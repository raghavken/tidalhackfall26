# Synthetic PMU Data Generator

Generates synchronized frequency measurements from four simulated Phasor
Measurement Units (PMUs) for testing the Oscillation Cartographer FPGA
detector, backend and diagnostic agent. Output comes as CSV (for humans and
Python) and as a 7-byte-per-measurement binary packet stream (for the FPGA).

## Installation

Requires Python 3.10+.

```bash
pip install -r simulator/requirements.txt
```

(`pytest` is only needed for running the tests.)

## Usage

Run from the repository root:

```bash
python simulator/generate.py --scenario all            # all three scenarios
python simulator/generate.py --scenario normal
python simulator/generate.py --scenario grid_oscillation --plot
python simulator/generate.py --scenario isolated --seed 7 --start-time 20
```

| Option | Default | Meaning |
|---|---|---|
| `--scenario` | (required) | `normal`, `grid_oscillation`, `isolated` or `all` |
| `--duration` | 70 | Simulated seconds (max ≈ 2184 s, so sample index fits 16 bits) |
| `--seed` | 42 | Random seed; same seed + same options = identical files |
| `--start-time` | 12 | Disturbance start time in seconds |
| `--osc-frequency` | 0.25 | Injected oscillation frequency in Hz |
| `--output-dir` | `simulator/data` | Where files are written |
| `--plot` | off | Also save `<scenario>.png` |

The sampling rate is fixed at **30 samples/s per station** for FPGA
compatibility (120 measurements/s across the four stations).

Output per scenario: `<scenario>.csv`, `<scenario>.bin` and optionally
`<scenario>.png`. With defaults each scenario has 70 s × 30 × 4 =
**8,400 records** and the binary file is 8,400 × 7 = **58,800 bytes**.

### Using it from Python

```python
from simulator import generate_data

records = generate_data(scenario="grid_oscillation", duration=70, seed=42,
                        start_time=12, osc_frequency=0.25)
records[0]
# {'sample_index': 0, 'time_seconds': 0.0, 'station_id': 0, 'station': 'North',
#  'frequency_hz': 60.00..., 'deviation_mhz': ...}
```

Other useful helpers:

- `simulator.generate_frequencies(...)` → `(times, freqs)` NumPy arrays, shape `(N, 4)`
- `simulator.encode_records(records)` → `bytes` of packets
- `simulator.decode_stream(data)` / `decode_packet(pkt)` → decode and verify packets
  (useful for an FPGA testbench or for checking what the board echoes back)

## Substations

| ID | Name | Oscillation amplitude | Phase offset |
|---|---|---|---|
| 0 | North | 20 mHz | 0 rad |
| 1 | East | 12 mHz | 0.15 rad |
| 2 | South | 17 mHz | π rad |
| 3 | West | 7 mHz | π + 0.2 rad |

North and East swing together; South and West swing the opposite way — the
signature of an inter-area mode.

## Scenarios

- **`normal`** — drift + noise only. No injected oscillation.
- **`grid_oscillation`** — sustained 0.25 Hz oscillation at every station using
  the amplitudes and phases above, starting at `--start-time`.
- **`isolated`** — only North oscillates (25 mHz, 0.25 Hz); the other three
  stations behave normally. Tests whether diagnostics can tell a local
  anomaly from a grid-wide one.

## Mathematical model

For station *k* at time *t* (all deviations in mHz):

```
f_k(t) = 60 Hz + [ d(t) + n_k(t) + E(t) · A_k · sin(2π f_osc (t − t0) + φ_k) ] / 1000
```

1. **Nominal frequency** — 60 Hz.
2. **Common drift `d(t)`** — an AR(1) process shared by all stations,
   `d[n] = φ·d[n−1] + e[n]`, with `φ = exp(−Δt/τ)`, τ = 10 s and a
   long-run standard deviation of 3 mHz. It models the whole interconnection's
   frequency wandering as load and generation shift. It is slow, so it puts
   very little energy near 0.25 Hz.
3. **Measurement noise `n_k(t)`** — independent Gaussian, σ = 1 mHz per station.
4. **Oscillation** — amplitude `A_k`, phase `φ_k`, frequency `f_osc`, starting at `t0`.
5. **Onset envelope `E(t)`** — 0 before `t0`, then a raised-cosine ramp
   `0.5·(1 − cos(π·(t − t0)/4 s))` reaching full amplitude 4 s (one 0.25 Hz
   cycle) after onset, then 1.

A single `numpy.random.default_rng(seed)` drives all randomness, so output is
fully reproducible. Tunable constants live at the top of `scenarios.py`.

## Data formats

### CSV

Columns: `sample_index, time_seconds, station_id, station, frequency_hz, deviation_mhz`

```csv
sample_index,time_seconds,station_id,station,frequency_hz,deviation_mhz
0,0.000000,0,North,60.001523,2
0,0.000000,1,East,60.000874,1
...
```

- Rows ordered by `sample_index`, then `station_id`; every sample index has all four stations.
- `time_seconds = sample_index / 30`, written with 6 decimals.
- `frequency_hz` is written with 6 decimals (1 µHz resolution).
- `deviation_mhz = round((frequency_hz − 60.0) × 1000)`, computed from the
  value exactly as written in the CSV, so it can be re-derived from the file.

### Binary (`.bin`)

Consecutive 7-byte packets, one per CSV row, in the same order:

| Byte | Contents |
|---|---|
| 0 | Header `0xAA` |
| 1 | Station ID (uint8) |
| 2 | Sample index, low byte |
| 3 | Sample index, high byte |
| 4 | Deviation (mHz), low byte — signed 16-bit two's complement |
| 5 | Deviation (mHz), high byte |
| 6 | Checksum = (byte0 + … + byte5) mod 256 |

Example: station 2, sample 258 (`0x0102`), deviation −2 mHz (`0xFFFE`) →
`AA 02 02 01 FE FF AC`.

The encoder raises `ValueError` if a station ID, sample index (0–65535) or
deviation (−32768…32767) does not fit its field. The decoder checks the header
and checksum.

## Tests

```bash
python -m pytest simulator/tests
# or, without pytest:
python -m unittest discover -s simulator/tests -t .
```

Tests cover record counts and ordering, reproducibility, the deviation formula,
packet encoding (known bytes, extremes, range errors, corruption detection),
CSV ↔ binary agreement, the CLI, and the signal content of each scenario
(dominant 0.25 Hz peak, per-station amplitudes and relative phases, North-only
isolated anomaly, no oscillation in `normal`). Spectral checks use the final
600-sample (20 s) window, matching the FPGA analysis window.

## Limitations

- This is a signal generator, not a power-system simulation: there are no
  network equations, governors, damping or mode shapes from a real model.
  The oscillation is sustained (undamped) with constant amplitude.
- The drift is identical at every station; real grids show small
  station-to-station differences in slow frequency movement.
- No data dropouts, timestamp jitter, bad-data flags or PMU reporting-standard
  framing (e.g. IEEE C37.118) are modelled.
- `deviation_mhz` is quantized to 1 mHz, so the binary stream has less
  resolution than the CSV `frequency_hz` column.
- Serial transmission to the FPGA is not implemented; `.bin` files are
  the payload that a serial sender would stream.
- Spectral checks with non-default `--osc-frequency` values are not tested;
  frequencies that don't fit a whole number of cycles in a 20 s window will
  show spectral leakage in the FPGA's analysis.
