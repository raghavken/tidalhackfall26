"""
Live PMU signal generation for four substations (no web code here).

Each station's frequency is built from:

    f_k(t) = 60 Hz
           + drift(t)                 shared AR(1) drift, same for every station
           + noise_k(t)               independent Gaussian measurement noise
           + A_k(t) * sin(2*pi*0.25*t + phase_k)    optional 0.25 Hz oscillation

A_k is set by the station's chosen severity. In the live stream it fades
between levels over RAMP_SECONDS so nothing jumps.
"""

import math
from collections import deque

import numpy as np

# ---------------------------------------------------------------------------
# Fixed constants (shared with the FPGA)
# ---------------------------------------------------------------------------
NOMINAL_FREQUENCY_HZ = 60.0
SAMPLE_RATE_HZ = 30
OSC_FREQUENCY_HZ = 0.25
WINDOW_SAMPLES = 600  # one FPGA analysis window (20 s)
ENERGY_THRESHOLD = 2_250_000  # FPGA alarm: I^2 + Q^2 >= this

# Background signal
NOISE_STD_MHZ = 1.0
DRIFT_STD_MHZ = 3.0
DRIFT_TIME_CONSTANT_S = 10.0
RAMP_SECONDS = 4.0  # live-stream fade between severity levels

HISTORY_SECONDS = 60  # ring buffer kept for new clients

# Fixed phase per station: North/East swing together, South/West opposite.
STATIONS = [
    {"station_id": 0, "name": "North", "phase_rad": 0.0},
    {"station_id": 1, "name": "East", "phase_rad": 0.15},
    {"station_id": 2, "name": "South", "phase_rad": math.pi},
    {"station_id": 3, "name": "West", "phase_rad": math.pi + 0.2},
]
STATION_NAMES = [s["name"] for s in STATIONS]
DEFAULT_PHASE_DEG = {s["name"]: round(math.degrees(s["phase_rad"]), 2) for s in STATIONS}
PHASE_LIMIT_DEG = 360.0

# Severity levels. Bands are on the FPGA energy (I^2 + Q^2); for a 0.25 Hz
# oscillation of amplitude A mHz the energy is about 90,000 * A^2.
SEVERITIES = {
    "normal": {"amplitude_mhz": 0.0, "energy_min": 0, "energy_max": 2_250_000},
    "mild": {"amplitude_mhz": 7.0, "energy_min": 2_250_000, "energy_max": 9_000_000},
    "moderate": {"amplitude_mhz": 14.0, "energy_min": 9_000_000, "energy_max": 36_000_000},
    "severe": {"amplitude_mhz": 30.0, "energy_min": 36_000_000, "energy_max": None},
}
SEVERITY_NAMES = list(SEVERITIES)


def severity_from_energy(energy):
    """Map an FPGA energy value to its severity band name."""
    for name, band in SEVERITIES.items():
        upper = band["energy_max"]
        if energy >= band["energy_min"] and (upper is None or energy < upper):
            return name
    raise ValueError(f"energy {energy} is negative")


def normalize_severities(config):
    """
    Turn {"North": "severe", ...} into a full 4-entry dict.
    Stations left out are "normal". Raises ValueError on bad names.
    """
    full = {name: "normal" for name in STATION_NAMES}
    for station, severity in config.items():
        if station not in full:
            raise ValueError(f"unknown station {station!r}; choose from {STATION_NAMES}")
        if severity not in SEVERITIES:
            raise ValueError(f"unknown severity {severity!r}; choose from {SEVERITY_NAMES}")
        full[station] = severity
    return full


def normalize_phases(phase_deg, base=None):
    """
    Merge a partial {"North": 0, ...} phase update (degrees) into `base`
    (default: the fixed station phases). Raises ValueError on bad input.
    """
    full = dict(base or DEFAULT_PHASE_DEG)
    for station, value in (phase_deg or {}).items():
        if station not in full:
            raise ValueError(f"unknown station {station!r}; choose from {STATION_NAMES}")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or math.isnan(value):
            raise ValueError(f"phase for {station} must be a number")
        if not -PHASE_LIMIT_DEG <= value <= PHASE_LIMIT_DEG:
            raise ValueError(f"phase for {station} must be between -360 and 360 degrees")
        full[station] = float(value)
    return full


def _wrap_rad(angle):
    return (angle + math.pi) % (2 * math.pi) - math.pi


def _ramp_weight(sample_index, from_index):
    ramp_samples = RAMP_SECONDS * SAMPLE_RATE_HZ
    progress = min(max((sample_index - from_index) / ramp_samples, 0.0), 1.0)
    return 0.5 * (1.0 - math.cos(math.pi * progress))


def _drift_coefficients():
    phi = math.exp(-1.0 / (SAMPLE_RATE_HZ * DRIFT_TIME_CONSTANT_S))
    return phi, DRIFT_STD_MHZ * math.sqrt(1.0 - phi * phi)


def _make_sample(sample_index, time_seconds, deviations_float):
    """Round to 1 uHz like the CSV did, then derive the integer mHz deviation."""
    freqs = [round(NOMINAL_FREQUENCY_HZ + d / 1000.0, 6) for d in deviations_float]
    devs = [int(round((f - NOMINAL_FREQUENCY_HZ) * 1000)) for f in freqs]
    for d in devs:
        if not -32768 <= d <= 32767:
            raise OverflowError(f"deviation {d} mHz does not fit in signed 16 bits")
    return {
        "sample_index": sample_index,
        "time_seconds": round(time_seconds, 6),
        "deviation_mhz": devs,
        "frequency_hz": freqs,
    }


class LiveSimulator:
    """
    Endless, unpaced sample generator. Call next_sample() once per 1/30 s
    (the web layer handles the timing). All randomness comes from one seeded
    generator, so the same seed and the same calls give the same data.
    """

    def __init__(self, seed=None):
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        self._phi, self._innovation_std = _drift_coefficients()
        self._drift = self.rng.normal(0.0, DRIFT_STD_MHZ)  # start in steady state
        self.sample_index = 0
        self.severities = {name: "normal" for name in STATION_NAMES}
        self.phase_deg = dict(DEFAULT_PHASE_DEG)
        # Per-station fades: amplitude and phase each move from `start` to
        # `target` over the ramp, so changes never jump.
        self._fade = [
            {"start": 0.0, "target": 0.0, "from_index": 0} for _ in STATIONS
        ]
        self._phase_fade = [
            {"start": s["phase_rad"], "delta": 0.0, "from_index": 0} for s in STATIONS
        ]
        self.history = deque(maxlen=HISTORY_SECONDS * SAMPLE_RATE_HZ)

    # -- configuration ------------------------------------------------------
    def amplitude_at(self, station_id, sample_index):
        """Oscillation amplitude (mHz) for a station at a given sample."""
        fade = self._fade[station_id]
        weight = _ramp_weight(sample_index, fade["from_index"])
        return fade["start"] + (fade["target"] - fade["start"]) * weight

    def phase_at(self, station_id, sample_index):
        """Station phase (radians) at a given sample; slides along the shortest way."""
        fade = self._phase_fade[station_id]
        return fade["start"] + fade["delta"] * _ramp_weight(sample_index, fade["from_index"])

    def set_phases(self, phase_deg):
        """Merge a partial phase update (degrees). Changed stations slide over the ramp."""
        new = normalize_phases(phase_deg, self.phase_deg)
        for station in STATIONS:
            sid, name = station["station_id"], station["name"]
            if new[name] != self.phase_deg[name]:
                current = self.phase_at(sid, self.sample_index)
                target = math.radians(new[name])
                self._phase_fade[sid] = {
                    "start": current,
                    "delta": _wrap_rad(target - current),
                    "from_index": self.sample_index,
                }
        self.phase_deg = new
        return dict(new)

    def set_severities(self, config):
        """Replace the whole configuration. Changed stations fade to the new level."""
        new = normalize_severities(config)
        for station in STATIONS:
            sid, name = station["station_id"], station["name"]
            if new[name] != self.severities[name]:
                self._fade[sid] = {
                    "start": self.amplitude_at(sid, self.sample_index),
                    "target": SEVERITIES[new[name]]["amplitude_mhz"],
                    "from_index": self.sample_index,
                }
        self.severities = new
        return dict(new)

    # -- generation ---------------------------------------------------------
    def next_sample(self):
        """Generate the next 4-station sample and append it to the history."""
        n = self.sample_index
        t = n / SAMPLE_RATE_HZ
        self._drift = self._phi * self._drift + self.rng.normal(0.0, self._innovation_std)
        noise = self.rng.normal(0.0, NOISE_STD_MHZ, len(STATIONS))
        deviations = []
        for station in STATIONS:
            sid = station["station_id"]
            osc = self.amplitude_at(sid, n) * math.sin(
                2.0 * math.pi * OSC_FREQUENCY_HZ * t + self.phase_at(sid, n)
            )
            deviations.append(self._drift + noise[sid] + osc)
        sample = _make_sample(n, t, deviations)
        self.history.append(sample)
        self.sample_index += 1
        return sample

    def recent(self, num_samples):
        """The last `num_samples` samples from the history (oldest first)."""
        if num_samples <= 0:
            return []
        return list(self.history)[-num_samples:]


def generate_window(severities, rng, num_samples=WINDOW_SAMPLES, phase_deg=None):
    """
    A fresh, independent window for Diagnose: full-strength oscillation from
    the first sample, new drift and noise, and a random common starting phase
    (station offsets from `phase_deg` preserved). Sample indices start at 0.
    """
    config = normalize_severities(severities)
    phases = normalize_phases(phase_deg)
    phi, innovation_std = _drift_coefficients()
    drift = rng.normal(0.0, DRIFT_STD_MHZ)
    start_phase = rng.uniform(0.0, 2.0 * math.pi)
    amplitudes = [SEVERITIES[config[s["name"]]]["amplitude_mhz"] for s in STATIONS]
    offsets = [math.radians(phases[s["name"]]) for s in STATIONS]
    window = []
    for n in range(num_samples):
        t = n / SAMPLE_RATE_HZ
        drift = phi * drift + rng.normal(0.0, innovation_std)
        noise = rng.normal(0.0, NOISE_STD_MHZ, len(STATIONS))
        deviations = [
            drift + noise[s["station_id"]] + amplitudes[s["station_id"]] * math.sin(
                2.0 * math.pi * OSC_FREQUENCY_HZ * t + start_phase + offsets[s["station_id"]])
            for s in STATIONS
        ]
        window.append(_make_sample(n, t, deviations))
    return window
