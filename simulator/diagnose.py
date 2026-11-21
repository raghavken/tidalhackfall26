"""
Diagnose: produce a window for the requested anomaly, send it to the FPGA
detector, and add the backend's own analysis.
"""

import math

import numpy as np

from .live_sim import (
    OSC_FREQUENCY_HZ,
    SAMPLE_RATE_HZ,
    STATION_NAMES,
    WINDOW_SAMPLES,
    generate_window,
    normalize_severities,
    severity_from_energy,
)
from .packet_encoder import encode_packet

# Keys that reveal the answer; removed before anything is sent to Nemotron.
GROUND_TRUTH_KEYS = ("requested", "matches_request")


def window_to_packets(window):
    """Encode a window as FPGA packets: indices re-based to 0, stations 0-3 in order."""
    base = window[0]["sample_index"]
    return b"".join(
        encode_packet(sid, sample["sample_index"] - base, dev)
        for sample in window
        for sid, dev in enumerate(sample["deviation_mhz"])
    )


def tone_at_target(values):
    """Complex 0.25 Hz component of one station's window (|c| = amplitude in mHz)."""
    x = np.asarray(values, dtype=float)
    x = x - x.mean()
    t = np.arange(len(x)) / SAMPLE_RATE_HZ
    return 2.0 / len(x) * np.sum(x * np.exp(-2j * math.pi * OSC_FREQUENCY_HZ * t))


def _wrap(angle):
    return (angle + math.pi) % (2 * math.pi) - math.pi


def analyze(window, fpga_results):
    """Affected stations, per-station amplitude/phase, pairwise phase relationships."""
    tones = [tone_at_target([s["deviation_mhz"][sid] for s in window])
             for sid in range(len(STATION_NAMES))]
    alarmed = [r["station_id"] for r in fpga_results if r["alarm"]]
    pairs = []
    for i, a in enumerate(alarmed):
        for b in alarmed[i + 1:]:
            diff = _wrap(float(np.angle(tones[b]) - np.angle(tones[a])))
            pairs.append({
                "stations": [STATION_NAMES[a], STATION_NAMES[b]],
                "relationship": "in_phase" if abs(diff) < math.pi / 2 else "opposite",
                "phase_difference_rad": round(diff, 3),
            })
    count = len(alarmed)
    return {
        "classification": ("none" if count == 0 else
                           "single_station" if count == 1 else "multi_station"),
        "affected_stations": [STATION_NAMES[s] for s in alarmed],
        "amplitude_mhz": {STATION_NAMES[s]: round(float(abs(tones[s])), 2)
                          for s in range(len(STATION_NAMES))},
        "phase_rad": {STATION_NAMES[s]: round(float(np.angle(tones[s])), 3)
                      for s in range(len(STATION_NAMES))},
        "phase_relationships": pairs,
    }


def run_diagnosis(severities, rng, detector, diagnosis_id=0, *, phases=None):
    """
    Full Diagnose pipeline. Returns (diagnosis_dict, window).
    `rng` should be a long-lived generator so each call draws fresh noise.
    """
    requested = normalize_severities(severities)
    window = generate_window(requested, rng, WINDOW_SAMPLES, phases=phases)
    packets = window_to_packets(window)
    raw = detector.detect(packets)
    if len(raw) != len(STATION_NAMES):
        raise RuntimeError(f"detector returned {len(raw)} results, expected 4")
    results = [
        {"station_id": r["station_id"], "station": STATION_NAMES[r["station_id"]],
         "window_end_sample": r["window_end_sample"], "energy": r["energy"],
         "alarm": r["alarm"], "severity": severity_from_energy(r["energy"])}
        for r in sorted(raw, key=lambda r: r["station_id"])
    ]
    diagnosis = {
        "diagnosis_id": diagnosis_id,
        "detector": detector.name,
        "window": {"samples": WINDOW_SAMPLES, "seconds": WINDOW_SAMPLES / SAMPLE_RATE_HZ,
                   "packets": len(packets) // 7},
        "requested": requested,
        "fpga_results": results,
        "analysis": analyze(window, results),
        "matches_request": all(r["severity"] == requested[r["station"]] for r in results),
    }
    return diagnosis, window


def evidence_only(diagnosis):
    """Copy of a diagnosis with ground truth removed (safe to give to Nemotron)."""
    return {k: v for k, v in diagnosis.items() if k not in GROUND_TRUTH_KEYS}
