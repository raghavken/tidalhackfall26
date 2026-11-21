"""
Tests for the synthetic PMU generator.

Run from the repository root with either:
    python -m pytest simulator/tests
    python -m unittest discover -s simulator/tests -t .
"""

import math
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from simulator.generate import read_csv, write_csv  # noqa: E402
from simulator.packet_encoder import (  # noqa: E402
    PACKET_SIZE,
    decode_packet,
    decode_stream,
    encode_packet,
    encode_records,
    read_binary,
    write_binary,
)
from simulator.scenarios import (  # noqa: E402
    FPGA_WINDOW_SAMPLES,
    SAMPLE_RATE_HZ,
    STATIONS,
    generate_data,
    generate_frequencies,
)

GENERATE_PY = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "generate.py"
)


def deviations_by_station(records):
    """Return an array of shape (num_samples, 4) of deviation_mhz values."""
    n = records[-1]["sample_index"] + 1
    out = np.zeros((n, 4))
    for r in records:
        out[r["sample_index"], r["station_id"]] = r["deviation_mhz"]
    return out


def tone(signal, freq_hz):
    """Complex amplitude of `signal` at `freq_hz` (|value| = sine amplitude)."""
    t = np.arange(len(signal)) / SAMPLE_RATE_HZ
    x = signal - signal.mean()
    return 2.0 / len(x) * np.sum(x * np.exp(-2j * np.pi * freq_hz * t))


def last_window(records):
    """The final FPGA analysis window (600 samples = 20 s) for every station."""
    return deviations_by_station(records)[-FPGA_WINDOW_SAMPLES:]


def wrap(angle):
    """Wrap an angle to (-pi, pi]."""
    return (angle + np.pi) % (2 * np.pi) - np.pi


class TestRecordStructure(unittest.TestCase):
    def test_default_record_count_and_order(self):
        for scenario in ("normal", "grid_oscillation", "isolated"):
            records = generate_data(scenario)
            self.assertEqual(len(records), 8400)
            for i, r in enumerate(records):
                self.assertEqual(r["sample_index"], i // 4)
                self.assertEqual(r["station_id"], i % 4)
                self.assertEqual(r["station"], STATIONS[i % 4]["name"])
                self.assertAlmostEqual(r["time_seconds"], (i // 4) / 30, places=6)

    def test_deviation_matches_formula(self):
        for r in generate_data("grid_oscillation"):
            expected = round((r["frequency_hz"] - 60.0) * 1000)
            self.assertEqual(r["deviation_mhz"], expected)

    def test_reproducible_with_same_seed(self):
        a = generate_data("grid_oscillation", seed=123)
        b = generate_data("grid_oscillation", seed=123)
        c = generate_data("grid_oscillation", seed=124)
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_custom_duration(self):
        self.assertEqual(len(generate_data("normal", duration=10)), 10 * 30 * 4)

    def test_rejects_bad_inputs(self):
        with self.assertRaises(ValueError):
            generate_data("not_a_scenario")
        with self.assertRaises(ValueError):
            generate_data("normal", duration=3000)  # sample index > 65535
        with self.assertRaises(ValueError):
            generate_data("normal", osc_frequency=0)


class TestScenarioPhysics(unittest.TestCase):
    def test_normal_has_no_oscillation(self):
        window = last_window(generate_data("normal"))
        for k in range(4):
            self.assertLess(abs(tone(window[:, k], 0.25)), 3.0)

    def test_normal_stays_near_60hz(self):
        _, freqs = generate_frequencies("normal")
        self.assertLess(np.max(np.abs(freqs - 60.0)), 0.02)  # within 20 mHz

    def test_grid_oscillation_dominant_at_quarter_hz(self):
        window = last_window(generate_data("grid_oscillation"))
        freqs = np.fft.rfftfreq(FPGA_WINDOW_SAMPLES, 1 / SAMPLE_RATE_HZ)
        for k in range(4):
            spectrum = np.abs(np.fft.rfft(window[:, k] - window[:, k].mean()))
            self.assertAlmostEqual(freqs[np.argmax(spectrum)], 0.25, places=6)

    def test_grid_oscillation_amplitudes_and_phases(self):
        window = last_window(generate_data("grid_oscillation"))
        tones = [tone(window[:, k], 0.25) for k in range(4)]
        for k, station in enumerate(STATIONS):
            self.assertAlmostEqual(abs(tones[k]), station["amplitude_mhz"], delta=2.5)
        north = np.angle(tones[0])
        for k, station in enumerate(STATIONS):
            measured = wrap(np.angle(tones[k]) - north)
            self.assertLess(abs(wrap(measured - station["phase_rad"])), 0.2,
                            f"{station['name']} phase off")
        # North/East in phase, South/West anti-phase relative to North
        self.assertLess(abs(wrap(np.angle(tones[1]) - north)), math.pi / 2)
        self.assertGreater(abs(wrap(np.angle(tones[2]) - north)), math.pi / 2)
        self.assertGreater(abs(wrap(np.angle(tones[3]) - north)), math.pi / 2)

    def test_no_oscillation_before_start(self):
        devs = deviations_by_station(generate_data("grid_oscillation"))
        before = devs[: 12 * SAMPLE_RATE_HZ]  # first 12 s
        for k in range(4):
            self.assertLess(abs(tone(before[:, k], 0.25)), 4.0)

    def test_isolated_concentrated_at_north(self):
        window = last_window(generate_data("isolated"))
        amps = [abs(tone(window[:, k], 0.25)) for k in range(4)]
        self.assertAlmostEqual(amps[0], 25.0, delta=2.5)
        for k in (1, 2, 3):
            self.assertLess(amps[k], 3.0)
            self.assertGreater(amps[0], 5 * amps[k])


class TestPacketEncoder(unittest.TestCase):
    def test_known_packet_bytes(self):
        pkt = encode_packet(2, 0x0102, -2)
        # -2 as int16 little-endian = FE FF
        body = bytes([0xAA, 0x02, 0x02, 0x01, 0xFE, 0xFF])
        self.assertEqual(pkt, body + bytes([sum(body) % 256]))

    def test_round_trip_extremes(self):
        for sid, idx, dev in [(0, 0, 0), (3, 65535, 32767), (255, 1, -32768)]:
            decoded = decode_packet(encode_packet(sid, idx, dev))
            self.assertEqual(decoded, {"station_id": sid, "sample_index": idx,
                                       "deviation_mhz": dev})

    def test_out_of_range_rejected(self):
        for args in [(256, 0, 0), (0, 65536, 0), (0, -1, 0), (0, 0, 32768), (0, 0, -32769)]:
            with self.assertRaises(ValueError):
                encode_packet(*args)

    def test_corruption_detected(self):
        pkt = bytearray(encode_packet(1, 5, 10))
        pkt[4] ^= 0x01
        with self.assertRaises(ValueError):
            decode_packet(bytes(pkt))
        pkt = bytearray(encode_packet(1, 5, 10))
        pkt[0] = 0x55
        with self.assertRaises(ValueError):
            decode_packet(bytes(pkt))

    def test_stream_matches_records(self):
        records = generate_data("grid_oscillation")
        data = encode_records(records)
        self.assertEqual(len(data), 58800)
        decoded = decode_stream(data)
        for r, d in zip(records, decoded, strict=True):
            self.assertEqual(d["station_id"], r["station_id"])
            self.assertEqual(d["sample_index"], r["sample_index"])
            self.assertEqual(d["deviation_mhz"], r["deviation_mhz"])


class TestFilesAndCli(unittest.TestCase):
    def test_csv_and_binary_files_agree(self):
        records = generate_data("isolated")
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = os.path.join(tmp, "x.csv")
            bin_path = os.path.join(tmp, "x.bin")
            write_csv(records, csv_path)
            write_binary(records, bin_path)
            self.assertEqual(os.path.getsize(bin_path), 8400 * PACKET_SIZE)
            from_csv = read_csv(csv_path)
            self.assertEqual(from_csv, records)
            for row, pkt in zip(from_csv, read_binary(bin_path), strict=True):
                self.assertEqual(
                    (row["station_id"], row["sample_index"], row["deviation_mhz"]),
                    (pkt["station_id"], pkt["sample_index"], pkt["deviation_mhz"]),
                )
                # deviation can be re-derived from the CSV's frequency column
                self.assertEqual(row["deviation_mhz"],
                                 round((row["frequency_hz"] - 60.0) * 1000))

    def test_cli_all_scenarios_with_plot(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [sys.executable, GENERATE_PY, "--scenario", "all",
                 "--output-dir", tmp, "--plot", "--duration", "30"],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            for scenario in ("normal", "grid_oscillation", "isolated"):
                for ext in ("csv", "bin", "png"):
                    self.assertTrue(os.path.exists(os.path.join(tmp, f"{scenario}.{ext}")))
                self.assertEqual(os.path.getsize(os.path.join(tmp, f"{scenario}.bin")),
                                 30 * 30 * 4 * PACKET_SIZE)


if __name__ == "__main__":
    unittest.main()
