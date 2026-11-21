"""Diagnose pipeline tests, using the FPGA team's reference detector."""

import itertools
import os
import sys
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "fpga", "tools"))

from replay import validate_input  # noqa: E402  (FPGA team's input checks)

from simulator.detectors import DetectorUnavailable, get_detector  # noqa: E402
from simulator.diagnose import evidence_only, run_diagnosis, window_to_packets  # noqa: E402
from simulator.live_sim import SEVERITY_NAMES, STATION_NAMES, generate_window  # noqa: E402

REFERENCE = get_detector("reference")


class TestPackets(unittest.TestCase):
    def test_packets_pass_fpga_input_validation(self):
        window = generate_window({"North": "severe"}, np.random.default_rng(0))
        packets = window_to_packets(window)
        self.assertEqual(len(packets), 2400 * 7)
        keys = validate_input(packets)  # raises on bad header/order/checksum
        self.assertEqual(keys, [(0, 599), (1, 599), (2, 599), (3, 599)])

    def test_rebases_indices(self):
        window = generate_window({}, np.random.default_rng(0))
        for s in window:
            s["sample_index"] += 5000  # e.g. a slice taken from the live stream
        validate_input(window_to_packets(window))


class TestAllCombinations(unittest.TestCase):
    def test_every_combination_lands_in_requested_band(self):
        """All 4^4 = 256 station/severity combinations, on 2 noise draws each."""
        rng = np.random.default_rng(2026)
        for combo in itertools.product(SEVERITY_NAMES, repeat=4):
            request = dict(zip(STATION_NAMES, combo))
            for _ in range(2):
                d, _ = run_diagnosis(request, rng, REFERENCE)
                got = {r["station"]: r["severity"] for r in d["fpga_results"]}
                self.assertEqual(got, request)
                self.assertTrue(d["matches_request"])
                alarms = {r["station"] for r in d["fpga_results"] if r["alarm"]}
                self.assertEqual(alarms, {s for s, v in request.items() if v != "normal"})


class TestAnalysis(unittest.TestCase):
    def relationship(self, request, pair):
        d, _ = run_diagnosis(request, np.random.default_rng(7), REFERENCE)
        for p in d["analysis"]["phase_relationships"]:
            if set(p["stations"]) == set(pair):
                return p["relationship"], d
        self.fail(f"no relationship for {pair}")

    def test_north_east_in_phase(self):
        rel, d = self.relationship({"North": "moderate", "East": "moderate"}, ("North", "East"))
        self.assertEqual(rel, "in_phase")
        self.assertEqual(d["analysis"]["classification"], "multi_station")

    def test_north_south_opposite(self):
        rel, _ = self.relationship({"North": "severe", "South": "mild"}, ("North", "South"))
        self.assertEqual(rel, "opposite")

    def test_custom_phase_north_south_in_phase(self):
        d, _ = run_diagnosis({"North": "severe", "South": "severe"}, np.random.default_rng(5),
                             REFERENCE, phase_deg={"South": 0})
        rel = d["analysis"]["phase_relationships"][0]
        self.assertEqual(rel["relationship"], "in_phase")
        self.assertEqual(d["requested_phase_deg"]["South"], 0.0)

    def test_classification(self):
        rng = np.random.default_rng(1)
        self.assertEqual(run_diagnosis({}, rng, REFERENCE)[0]["analysis"]["classification"], "none")
        single = run_diagnosis({"West": "mild"}, rng, REFERENCE)[0]["analysis"]
        self.assertEqual(single["classification"], "single_station")
        self.assertEqual(single["affected_stations"], ["West"])

    def test_fresh_noise_each_press(self):
        rng = np.random.default_rng(3)
        a, _ = run_diagnosis({"North": "severe"}, rng, REFERENCE)
        b, _ = run_diagnosis({"North": "severe"}, rng, REFERENCE)
        self.assertNotEqual(a["fpga_results"][0]["energy"], b["fpga_results"][0]["energy"])
        self.assertEqual(a["fpga_results"][0]["severity"], b["fpga_results"][0]["severity"])

    def test_evidence_only_strips_ground_truth(self):
        d, _ = run_diagnosis({"North": "mild"}, np.random.default_rng(0), REFERENCE)
        e = evidence_only(d)
        self.assertNotIn("requested", e)
        self.assertNotIn("requested_phase_deg", e)
        self.assertNotIn("matches_request", e)
        self.assertIn("fpga_results", e)
        self.assertIn("requested", d)  # original untouched

    def test_hardware_stub(self):
        with self.assertRaises(DetectorUnavailable):
            run_diagnosis({}, np.random.default_rng(0), get_detector("hardware"))


if __name__ == "__main__":
    unittest.main()
