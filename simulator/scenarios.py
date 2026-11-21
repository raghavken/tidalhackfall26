"""
Synthetic PMU (Phasor Measurement Unit) frequency data for four substations.

Each measurement is built from five ingredients:

    f(t) = 60 Hz                       (1) nominal grid frequency
         + drift(t)                    (2) slow random drift, SHARED by all stations
         + noise_k(t)                  (3) independent Gaussian noise per station
         + envelope(t) * osc_k(t)      (4)+(5) optional oscillation with gradual onset

This is a physically motivated *signal generator*, not a power-system
dynamics simulation. All amplitudes are in millihertz (mHz) internally and
converted to Hz at the end.
"""

import math

import numpy as np

# ---------------------------------------------------------------------------
# Fixed constants (shared with the FPGA design - do not change casually)
# ---------------------------------------------------------------------------
NOMINAL_FREQUENCY_HZ = 60.0
SAMPLE_RATE_HZ = 30  # samples per second, per substation
FPGA_WINDOW_SAMPLES = 600  # 20 s analysis window per substation
MAX_SAMPLE_INDEX = 0xFFFF  # sample index must fit in an unsigned 16-bit field

# ---------------------------------------------------------------------------
# Default simulation parameters
# ---------------------------------------------------------------------------
DEFAULT_DURATION_S = 70.0
DEFAULT_SEED = 42
DEFAULT_START_TIME_S = 12.0
DEFAULT_OSC_FREQUENCY_HZ = 0.25

NOISE_STD_MHZ = 1.0  # per-station measurement noise (standard deviation)
DRIFT_STD_MHZ = 3.0  # long-run standard deviation of the shared drift
DRIFT_TIME_CONSTANT_S = 10.0  # how slowly the shared drift wanders
ONSET_RAMP_S = 4.0  # oscillation fades in over this many seconds

ISOLATED_AMPLITUDE_MHZ = 25.0  # North-only anomaly amplitude

# ---------------------------------------------------------------------------
# Substations: amplitude (mHz) and phase offset (radians) of the inter-area mode.
# North/East swing together; South/West swing roughly opposite (~pi apart).
# ---------------------------------------------------------------------------
STATIONS = [
    {"station_id": 0, "name": "North", "amplitude_mhz": 20.0, "phase_rad": 0.0},
    {"station_id": 1, "name": "East", "amplitude_mhz": 12.0, "phase_rad": 0.15},
    {"station_id": 2, "name": "South", "amplitude_mhz": 17.0, "phase_rad": math.pi},
    {"station_id": 3, "name": "West", "amplitude_mhz": 7.0, "phase_rad": math.pi + 0.2},
]
STATION_NAMES = [s["name"] for s in STATIONS]

SCENARIOS = ("normal", "grid_oscillation", "isolated")

CSV_COLUMNS = [
    "sample_index",
    "time_seconds",
    "station_id",
    "station",
    "frequency_hz",
    "deviation_mhz",
]


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------
def time_axis(duration):
    """Return (num_samples, times) for a simulation of `duration` seconds."""
    num_samples = int(round(duration * SAMPLE_RATE_HZ))
    if num_samples <= 0:
        raise ValueError("duration must produce at least one sample")
    if num_samples - 1 > MAX_SAMPLE_INDEX:
        max_duration = (MAX_SAMPLE_INDEX + 1) / SAMPLE_RATE_HZ
        raise ValueError(
            f"duration too long: sample index must fit in 16 bits "
            f"(max {max_duration:.1f} s at {SAMPLE_RATE_HZ} Hz)"
        )
    times = np.arange(num_samples) / SAMPLE_RATE_HZ
    return num_samples, times


def common_drift_mhz(rng, num_samples):
    """
    Slowly varying random drift shared by every substation (in mHz).

    Uses a first-order autoregressive process, AR(1):
        x[n] = phi * x[n-1] + e[n]
    with phi = exp(-dt / tau). The innovation e[n] is scaled so the
    long-run standard deviation equals DRIFT_STD_MHZ.
    """
    dt = 1.0 / SAMPLE_RATE_HZ
    phi = math.exp(-dt / DRIFT_TIME_CONSTANT_S)
    innovation_std = DRIFT_STD_MHZ * math.sqrt(1.0 - phi**2)

    innovations = rng.normal(0.0, innovation_std, num_samples)
    drift = np.empty(num_samples)
    drift[0] = rng.normal(0.0, DRIFT_STD_MHZ)  # start in steady state
    for n in range(1, num_samples):
        drift[n] = phi * drift[n - 1] + innovations[n]
    return drift


def onset_envelope(times, start_time, ramp=ONSET_RAMP_S):
    """
    0 before `start_time`, 1 after `start_time + ramp`, and a smooth
    raised-cosine (S-shaped) rise in between.
    """
    if ramp <= 0:
        return (times >= start_time).astype(float)
    progress = np.clip((times - start_time) / ramp, 0.0, 1.0)
    return 0.5 * (1.0 - np.cos(np.pi * progress))


def oscillation_mhz(times, amplitude, frequency, phase, start_time):
    """Sinusoid (mHz) with gradual onset. Phase is measured from `start_time`."""
    sine = np.sin(2.0 * np.pi * frequency * (times - start_time) + phase)
    return amplitude * onset_envelope(times, start_time) * sine


def scenario_oscillations(scenario):
    """
    Return a list of (amplitude_mhz, phase_rad) per station for a scenario.
    An amplitude of 0 means "no injected oscillation".
    """
    if scenario == "normal":
        return [(0.0, 0.0) for _ in STATIONS]
    if scenario == "grid_oscillation":
        return [(s["amplitude_mhz"], s["phase_rad"]) for s in STATIONS]
    if scenario == "isolated":
        return [(ISOLATED_AMPLITUDE_MHZ, 0.0)] + [(0.0, 0.0) for _ in STATIONS[1:]]
    raise ValueError(f"unknown scenario {scenario!r}; choose from {SCENARIOS}")


# ---------------------------------------------------------------------------
# Main generators
# ---------------------------------------------------------------------------
def generate_frequencies(
    scenario="normal",
    duration=DEFAULT_DURATION_S,
    seed=DEFAULT_SEED,
    start_time=DEFAULT_START_TIME_S,
    osc_frequency=DEFAULT_OSC_FREQUENCY_HZ,
):
    """
    Generate raw frequency data as NumPy arrays.

    Returns (times, frequencies_hz) where frequencies_hz has shape
    (num_samples, 4): one column per station, ordered by station ID.
    """
    oscillations = scenario_oscillations(scenario)  # validates the name early
    if osc_frequency <= 0:
        raise ValueError("osc_frequency must be positive")
    num_samples, times = time_axis(duration)

    # One random generator drives everything, so a seed fully determines output.
    rng = np.random.default_rng(seed)
    drift = common_drift_mhz(rng, num_samples)
    noise = rng.normal(0.0, NOISE_STD_MHZ, (num_samples, len(STATIONS)))

    deviation_mhz = drift[:, None] + noise
    for k, (amplitude, phase) in enumerate(oscillations):
        if amplitude > 0:
            deviation_mhz[:, k] += oscillation_mhz(
                times, amplitude, osc_frequency, phase, start_time
            )

    frequencies_hz = NOMINAL_FREQUENCY_HZ + deviation_mhz / 1000.0
    return times, frequencies_hz


def generate_data(
    scenario="normal",
    duration=DEFAULT_DURATION_S,
    seed=DEFAULT_SEED,
    start_time=DEFAULT_START_TIME_S,
    osc_frequency=DEFAULT_OSC_FREQUENCY_HZ,
):
    """
    Generate measurement records matching the CSV schema.

    Returns a list of dicts with keys:
        sample_index, time_seconds, station_id, station, frequency_hz, deviation_mhz
    ordered by sample_index, then station_id.

    frequency_hz is rounded to 6 decimals (1 uHz) - exactly what the CSV stores -
    and deviation_mhz is computed from that rounded value, so the CSV, the
    binary file and these records always agree.
    """
    times, frequencies_hz = generate_frequencies(
        scenario, duration, seed, start_time, osc_frequency
    )
    records = []
    for sample_index, t in enumerate(times):
        for station in STATIONS:
            sid = station["station_id"]
            freq = round(float(frequencies_hz[sample_index, sid]), 6)
            records.append(
                {
                    "sample_index": sample_index,
                    "time_seconds": round(float(t), 6),
                    "station_id": sid,
                    "station": station["name"],
                    "frequency_hz": freq,
                    "deviation_mhz": int(round((freq - NOMINAL_FREQUENCY_HZ) * 1000)),
                }
            )
    return records
