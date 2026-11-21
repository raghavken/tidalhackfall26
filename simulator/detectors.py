"""
Detector backends for Diagnose: they take FPGA input packets and return the
FPGA's per-station results.

- "reference": fpga/tools/reference_detector.py, the FPGA team's bit-exact
  Python model of the board. No hardware needed.
- "hardware": the real DE1 over JTAG. Not wired up yet.
"""

import os
import sys

from .packet_encoder import decode_stream

_FPGA_TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "fpga", "tools")


class DetectorUnavailable(RuntimeError):
    """Raised when a detector backend cannot run (e.g. no hardware configured)."""


def _import_reference_detector():
    if _FPGA_TOOLS not in sys.path:
        sys.path.insert(0, _FPGA_TOOLS)  # reference_detector imports its siblings
    try:
        import reference_detector
    except ImportError as exc:
        raise DetectorUnavailable(f"cannot load fpga/tools/reference_detector.py: {exc}")
    return reference_detector


class ReferenceDetector:
    name = "reference"

    def detect(self, packet_bytes):
        """Decode 7-byte packets, run the FPGA model, return its result dicts."""
        ref = _import_reference_detector()
        records = [(p["station_id"], p["sample_index"], p["deviation_mhz"])
                   for p in decode_stream(packet_bytes)]
        return [
            {"station_id": r["station_id"], "window_end_sample": r["window_end_sample"],
             "energy": r["energy"], "alarm": bool(r["alarm"])}
            for r in ref.detect(records)
        ]


class HardwareDetector:
    name = "hardware"

    def detect(self, packet_bytes):
        raise DetectorUnavailable(
            "hardware detector not configured yet; use the 'reference' detector")


DETECTORS = {"reference": ReferenceDetector, "hardware": HardwareDetector}


def get_detector(name):
    if name not in DETECTORS:
        raise ValueError(f"unknown detector {name!r}; choose from {list(DETECTORS)}")
    return DETECTORS[name]()


def detector_available(name):
    """True if the named detector can run right now (for the status endpoint)."""
    if name == "hardware":
        return False  # stub until the JTAG path is wired in
    try:
        _import_reference_detector()
    except DetectorUnavailable:
        return False
    return True
