"""Signal generator tests. Run from the repo root: python -m pytest simulator/tests"""

import hashlib
import math
import os
import sys
import unittest

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from simulator.diagnose import tone_at_target  # noqa: E402
from simulator.live_sim import (  # noqa: E402
    SAMPLE_RATE_HZ,
    SEVERITIES,
    LiveSimulator,
    generate_window,
    normalize_severities,
    severity_from_energy,
)


def run(sim, n):
    return [sim.next_sample() for _ in range(n)]


def station_series(samples, sid):
    return [s["deviation_mhz"][sid] for s in samples]


class TestLiveSimulator(unittest.TestCase):
    def test_sample_format(self):
        s = LiveSimulator(seed=1).next_sample()
        self.assertEqual(s["sample_index"], 0)
        self.assertEqual(s["time_seconds"], 0.0)
        self.assertEqual(len(s["deviation_mhz"]), 4)
        for f, d in zip(s["frequency_hz"], s["deviation_mhz"]):
            self.assertEqual(d, round((f - 60.0) * 1000))
            self.assertIsInstance(d, int)

    def test_indices_and_times_continuous(self):
        samples = run(LiveSimulator(seed=1), 100)
        self.assertEqual([s["sample_index"] for s in samples], list(range(100)))
        self.assertAlmostEqual(samples[-1]["time_seconds"], 99 / SAMPLE_RATE_HZ, places=6)

    def test_same_seed_reproducible(self):
        self.assertEqual(run(LiveSimulator(seed=5), 300), run(LiveSimulator(seed=5), 300))
        self.assertNotEqual(run(LiveSimulator(seed=5), 300), run(LiveSimulator(seed=6), 300))

    def test_normal_has_no_oscillation(self):
        samples = run(LiveSimulator(seed=2), 600)
        for sid in range(4):
            self.assertLess(abs(tone_at_target(station_series(samples, sid))), 3.0)

    def test_severity_reaches_target_amplitude(self):
        sim = LiveSimulator(seed=3)
        sim.set_severities({"North": "severe", "South": "mild"})
        run(sim, 150)  # let the 4 s fade finish
        samples = run(sim, 600)
        amps = [abs(tone_at_target(station_series(samples, sid))) for sid in range(4)]
        self.assertAlmostEqual(amps[0], 30, delta=2)
        self.assertLess(amps[1], 2)
        self.assertAlmostEqual(amps[2], 7, delta=2)
        self.assertLess(amps[3], 2)

    def test_fade_has_no_jump(self):
        sim = LiveSimulator(seed=4)
        run(sim, 30)
        sim.set_severities({"North": "severe"})
        amps = [sim.amplitude_at(0, sim.sample_index + k) for k in range(0, 150)]
        self.assertEqual(amps[0], 0.0)
        self.assertAlmostEqual(amps[-1], 30.0, places=6)
        self.assertLess(max(abs(b - a) for a, b in zip(amps, amps[1:])), 0.5)  # mHz/sample
        # Changing mid-fade starts from the current amplitude (no jump down)
        run(sim, 60)
        before = sim.amplitude_at(0, sim.sample_index)
        sim.set_severities({"North": "mild"})
        self.assertAlmostEqual(sim.amplitude_at(0, sim.sample_index), before, places=9)

    def test_config_validation(self):
        self.assertEqual(normalize_severities({"West": "mild"}),
                         {"North": "normal", "East": "normal", "South": "normal", "West": "mild"})
        with self.assertRaises(ValueError):
            normalize_severities({"Central": "mild"})
        with self.assertRaises(ValueError):
            normalize_severities({"North": "extreme"})

    def test_history_ring_buffer(self):
        sim = LiveSimulator(seed=1)
        run(sim, 2000)
        self.assertEqual(len(sim.history), 1800)  # 60 s
        self.assertEqual(sim.recent(5)[-1]["sample_index"], 1999)


class TestSeverityBands(unittest.TestCase):
    def test_band_edges(self):
        self.assertEqual(severity_from_energy(0), "normal")
        self.assertEqual(severity_from_energy(2_249_999), "normal")
        self.assertEqual(severity_from_energy(2_250_000), "mild")
        self.assertEqual(severity_from_energy(9_000_000), "moderate")
        self.assertEqual(severity_from_energy(35_999_999), "moderate")
        self.assertEqual(severity_from_energy(36_000_000), "severe")
        self.assertEqual(severity_from_energy(10**15), "severe")

    def test_amplitudes_sit_inside_their_bands(self):
        for name, band in SEVERITIES.items():
            ideal = 90_000 * band["amplitude_mhz"] ** 2
            self.assertEqual(severity_from_energy(ideal), name)


class TestWindow(unittest.TestCase):
    def test_window_shape_and_fresh_noise(self):
        rng = np.random.default_rng(0)
        a = generate_window({"North": "moderate"}, rng)
        b = generate_window({"North": "moderate"}, rng)
        self.assertEqual(len(a), 600)
        self.assertEqual(a[0]["sample_index"], 0)
        self.assertNotEqual(a, b)  # new noise on every call

    def test_window_full_strength_from_start(self):
        w = generate_window({"East": "severe"}, np.random.default_rng(1))
        first_5s = station_series(w[:150], 1)
        self.assertGreater(max(first_5s) - min(first_5s), 40)  # ~60 mHz peak-to-peak


class TestFrozenFpgaData(unittest.TestCase):
    """The FPGA team's tools read these files (.bin and .csv); they must never change."""
    EXPECTED = {
        "normal.bin": "1cabbe92888ee7e35d0872638834231a72c5c8d4e68bf3f43a01380b23385a6e",
        "grid_oscillation.bin": "aedaa7916f0afb2ab054947eada8067816a8889d53b1c4e5ac2513d26af8de24",
        "isolated.bin": "a2419573a92e72f81b47d062d9846eb3cd3877ea7e2a601f6853bb0dd6c595f8",
        "normal.csv": "89dfaf121bb30d56bb34ef6a75aa02af5b7f14604fe4244f1cb77a20c702644c",
        "grid_oscillation.csv": "33ed6e5c56f3cc67c90c02711ef4649c9d4400bb0453a90f5b3e6b6c92622f58",
        "isolated.csv": "251fdbf326cbd6a750d2fa553f21417714fdbd4d61bf987db879842bea2137af",
    }

    def test_files_unchanged(self):
        for name, digest in self.EXPECTED.items():
            path = os.path.join(ROOT, "simulator", "data", name)
            with open(path, "rb") as f:
                data = f.read()
            if name.endswith(".bin"):
                self.assertEqual(len(data), 58_800, name)
            self.assertEqual(hashlib.sha256(data).hexdigest(), digest, name)


if __name__ == "__main__":
    unittest.main()
