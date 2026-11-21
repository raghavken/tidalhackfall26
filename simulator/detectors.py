"""
Detector backends for Diagnose: they take FPGA input packets and return the
FPGA's per-station results.

- "reference": fpga/tools/reference_detector.py, the FPGA team's bit-exact
  Python model of the board. No hardware needed.
- "hardware": the real DE1 over JTAG. Uses the configured Windows Quartus tool.
"""

import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
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
        quartus = os.environ.get("SIM_QUARTUS_STP")
        if not quartus:
            raise DetectorUnavailable("hardware detector not configured; set SIM_QUARTUS_STP")
        if _FPGA_TOOLS not in sys.path:
            sys.path.insert(0, _FPGA_TOOLS)
        from decode_results import decode_packet
        from jtag_host import hardware_events

        results = []
        complete = None
        try:
            with TemporaryDirectory(prefix="simulator-window-") as directory:
                source = Path(directory) / "diagnosis.bin"
                source.write_bytes(packet_bytes)
                for line in hardware_events(quartus, source):
                    kind, _, payload = line.partition(" ")
                    if kind == "RECEIVED":
                        results.append(decode_packet(bytes.fromhex(payload)))
                    elif kind == "COMPLETE":
                        complete = int(payload)
                    elif kind == "ERROR":
                        raise RuntimeError(payload)
            expected = [(station, index) for index in range(599, len(packet_bytes) // 28, 600)
                        for station in range(4)]
            actual = [(r["station_id"], r["window_end_sample"]) for r in results]
            if complete != len(packet_bytes) // 7 or actual != expected:
                raise RuntimeError("FPGA measurement count or result identities did not match")
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            raise DetectorUnavailable(f"USB-Blaster replay failed: {exc}") from exc
        return results


DETECTORS = {"reference": ReferenceDetector, "hardware": HardwareDetector}


def get_detector(name):
    if name not in DETECTORS:
        raise ValueError(f"unknown detector {name!r}; choose from {list(DETECTORS)}")
    return DETECTORS[name]()
