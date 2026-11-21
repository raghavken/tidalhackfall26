# MVP — Oscillation Cartographer: Live PMU Simulator (FastAPI + WebSocket)

## Project context

The first simulator produced three fixed 70-second CSV/BIN datasets. It is being **replaced** by a live simulator server:

```text
                    REST (controls, Diagnose)
  Frontend  ─────────────────────────────────►  Live simulator  ──Diagnose──►  FPGA (DE1)
  (browser) ◄─────────────────────────────────  (this folder)   ◄────────────  4 results
                  WebSocket (live data)
```

1. The simulator generates four PMU streams (North, East, South, West) continuously at 30 samples/s and pushes them to the browser over a WebSocket.
2. The user chooses **which stations** have an anomaly and **how severe** each one is (normal, mild, moderate, severe). The live stream changes to match.
3. **Diagnose** produces a 20-second data window for the chosen anomaly, sends it to the FPGA in its 7-byte packet format, and returns the FPGA's energy and alarm per station, plus the backend's own analysis.

This document covers the live simulator only. The frontend, FPGA and Nemotron are built separately.

## How the FPGA measures severity (from `fpga/README.md`)

For each station, the FPGA correlates 600 samples (20 s) against a 0.25 Hz cosine and sine (Q15 tables), shifts each sum right by 15 bits to get **I** and **Q**, and reports:

```text
energy = I² + Q²          alarm = energy ≥ 2,250,000
```

For a 0.25 Hz oscillation of amplitude A mHz, I² + Q² ≈ (N·A/2)² = **90,000 · A²**. So the alarm threshold of 2,250,000 corresponds to A = 5 mHz. The README's measured value, North at 20 mHz = 36,180,241, matches the 36,000,000 this formula predicts.

## Severity levels

Bands are defined on the **FPGA energy**, so the board's own output decides the severity. Each band is 4× the energy of the one below (2× the amplitude).

| Severity | FPGA energy (I² + Q²) | Equivalent amplitude | **Simulated amplitude** | Measured energy, 300 noisy trials (min – max) | Lands in band |
|---|---|---|---|---|---|
| `normal` | < 2,250,000 (no alarm) | < 5 mHz | **0 mHz** (drift and noise only) | 52 – 125,341 | 300/300 |
| `mild` | 2,250,000 – 8,999,999 | 5 – 10 mHz | **7 mHz** | 3,483,226 – 5,622,137 | 300/300 |
| `moderate` | 9,000,000 – 35,999,999 | 10 – 20 mHz | **14 mHz** | 15,734,914 – 19,942,853 | 300/300 |
| `severe` | ≥ 36,000,000 | ≥ 20 mHz | **30 mHz** | 76,783,393 – 85,915,773 | 300/300 |

The trials were measured with `fpga/tools/reference_detector.py`, the bit-exact model of the FPGA, using the simulator's drift, noise and random phase. Each simulated amplitude sits near the middle of its band (on a log scale), so noise never pushes it into a neighbouring band. Normal stays at least 18× below the alarm threshold.

The bands only cover 0.25 Hz oscillations, which is the only frequency the FPGA detects.

## Signal model

Same physics as the first simulator, generated one sample at a time with continuous state:

- 60 Hz nominal frequency.
- Shared AR(1) drift (τ = 10 s, σ = 3 mHz), continuous for the whole session.
- Independent Gaussian noise per station, σ = 1 mHz.
- Per-station 0.25 Hz oscillation with the amplitude of that station's chosen severity.
- **Phase per station:** defaults North 0, East 0.15, South π, West π + 0.2 rad, so North and East swing together and South and West swing opposite. *(Updated later: phase is now user-settable per station via `phase_deg`; see `frontend/MVP.md` Part A1 and this folder's README.)*
- In the live stream, a severity change fades over 4 s (raised cosine) instead of jumping.
- `deviation_mhz = round((frequency_hz − 60) × 1000)`, which must fit in signed 16 bits.

## Anomaly configuration

The user sets a severity for each station. Any combination is allowed: 0, 1, 2, 3 or 4 stations anomalous, each at its own severity.

```json
{"North": "severe", "East": "normal", "South": "mild", "West": "normal"}
```

Stations left out of a request stay `normal`. "All normal" is the baseline.

## Diagnose

The user selects the anomaly they want, then presses **Diagnose**. The simulator then:

1. **Produces a fresh 20 s window** (600 samples × 4 stations) for the current configuration, at full strength from the first sample (no fade). Every press draws new random noise, drift and a random starting phase (station phase offsets are preserved), so the anomaly is the same but the data is new. There is no need to wait for the live stream to settle.
2. Numbers the samples 0–599 (the FPGA requires each run to start at index 0, in strict station order) and encodes 2,400 packets of 7 bytes, using the current packet format.
3. Sends them to the detector. Exactly 2,400 measurements produce exactly 4 results.
   - `reference` (default until the board is connected): `fpga/tools/reference_detector.py`.
   - `hardware` (later): the FPGA team's JTAG replay on the board. A stub returns "not configured" for now.
4. Classifies each station's energy into a severity band, and computes per-station 0.25 Hz amplitude and phase from the raw window, plus the in-phase/opposite relationship for each pair of alarmed stations.
5. Returns the result, keeps it in memory (last 20), and broadcasts it on the WebSocket together with the window's samples, so the frontend can show exactly what was diagnosed.

Response example (values illustrative):

```json
{
  "diagnosis_id": 3,
  "detector": "reference",
  "requested": {"North": "severe", "East": "normal", "South": "mild", "West": "normal"},
  "fpga_results": [
    {"station": "North", "energy": 80974778, "alarm": true,  "severity": "severe"},
    {"station": "East",  "energy": 13261,    "alarm": false, "severity": "normal"},
    {"station": "South", "energy": 4416674,  "alarm": true,  "severity": "mild"},
    {"station": "West",  "energy": 9120,     "alarm": false, "severity": "normal"}
  ],
  "analysis": {
    "classification": "multi_station",
    "affected_stations": ["North", "South"],
    "amplitude_mhz": {"North": 30.0, "East": 0.4, "South": 7.0, "West": 0.3},
    "phase_relationships": [{"stations": ["North", "South"], "relationship": "opposite",
                             "phase_difference_rad": 3.14}]
  },
  "matches_request": true
}
```

`requested` and `matches_request` are ground truth for the demo and for testing. They must be removed from anything sent to Nemotron, so the agent works from evidence.

## Technology

| Choice | Why |
|---|---|
| **FastAPI** | Python web framework with built-in WebSockets, request validation, and interactive docs at `/docs` |
| **Uvicorn** | Runs the FastAPI app |
| **One asyncio background task** | Generates samples every 1/30 s and broadcasts them, so every client sees identical data |
| NumPy | Signal generation |

```bash
pip install -r simulator/requirements.txt
uvicorn simulator.app:app --reload --port 8000
```

## REST API

| Method & path | Purpose |
|---|---|
| `GET /api/health` | `{"status": "ok"}` |
| `GET /api/config` | Stations, severity levels with their energy bands and amplitudes, sample rate |
| `GET /api/state` | Current per-station severity, sample index, connected clients, paused or running |
| `PUT /api/anomaly` | Set severities, for example `{"North": "severe", "South": "mild"}`. Unknown station or severity returns `422`. |
| `DELETE /api/anomaly` | Everything back to normal |
| `POST /api/stream/pause`, `/resume`, `/reset` | Control the live stream. Reset accepts an optional `{"seed": 42}`. |
| `POST /api/diagnose` | Run Diagnose (above) |
| `GET /api/diagnoses` | Last 20 diagnosis results |

## WebSocket `ws://localhost:8000/ws/stream`

The server pushes messages; the browser only listens. All controls go through REST.

| `type` | When | Content |
|---|---|---|
| `hello` | On connect | Config, current state, last 20 s of samples (so charts fill immediately) |
| `samples` | 10 times per second | 3 consecutive samples (see batching below) |
| `state` | When the configuration changes | Same as `GET /api/state` |
| `diagnosis` | When a diagnosis finishes | The diagnose response plus the 600 × 4 window samples |

```json
{"type": "samples", "samples": [
  {"sample_index": 5421, "time_seconds": 180.7,
   "deviation_mhz": [4, 3, -3, -1],
   "frequency_hz": [60.004113, 60.002871, 59.997402, 59.99912]},
  …
]}
```

Arrays are in station order: [North, East, South, West].

**Batching:** the simulator makes 30 samples per second. Sending each one as its own message would mean 30 WebSocket messages per second. Bundling 3 samples per message sends 10 messages per second instead. The chart receives the same 30 points per second either way and looks identical. Fewer messages are lighter on the browser, which redraws once per message, and on the network. So the default is 3 samples per message, adjustable with the `SIM_BATCH` environment variable (uvicorn owns the command line, so settings are environment variables).

## Directory structure

The live simulator replaces the current contents of `simulator/`:

```text
simulator/
├── __init__.py
├── MVP.md               # this document
├── README.md            # rewritten for the live simulator
├── requirements.txt     # fastapi, uvicorn[standard], numpy, pytest, httpx
├── app.py               # FastAPI: REST routes, WebSocket, background task
├── live_sim.py          # station table, severity levels, streaming generator, window generator
├── packet_encoder.py    # kept: 7-byte FPGA packets
├── diagnose.py          # window → packets → detector → bands and phase analysis
├── detectors.py         # "reference" (fpga/tools) and "hardware" (stub)
└── tests/
    ├── test_live_sim.py
    ├── test_diagnose.py
    └── test_api.py      # REST + WebSocket with FastAPI's TestClient
```

```text
└── data/                # kept, frozen: FPGA team test data, not regenerated
    ├── normal.bin / normal.csv
    ├── grid_oscillation.bin / grid_oscillation.csv
    └── isolated.bin / isolated.csv
```

Removed: `generate.py`, `scenarios.py`, the old `tests/test_generator.py`, and the `.png` files in `data/`.

An added test checks that the six data files still exist and are unchanged (SHA-256; `.bin` files 58,800 bytes each), so a cleanup can never break the FPGA team's tools by accident.

## Acceptance criteria

- `uvicorn simulator.app:app` starts, and `/docs` lists every endpoint.
- The WebSocket delivers 30 samples/s (± 1% over 60 s) as 10 messages/s. Two clients receive identical samples.
- `PUT /api/anomaly` accepts any combination of 0–4 stations and any severity, and the change shows in the stream on the next tick with a 4 s fade. Invalid input returns `422`.
- For **every** one of the 4⁴ = 256 station/severity combinations, Diagnose with the reference detector reports each station in its requested band. Checked on several seeds.
- Phase: an alarmed North+East pair is reported in phase; North+South is reported opposite.
- Diagnose packets pass the FPGA input checks used by `fpga/tools/replay.py` (header, order starting at 0, checksum), and produce exactly 4 results.
- The server stays responsive while streaming: API calls answer in under 100 ms.
- Tests run without network access or FPGA hardware, and pass.

## Non-goals

- The frontend UI.
- The physical FPGA connection (`hardware` is a stub).
- Nemotron integration (the diagnosis JSON is designed to be its input later).
- Persistence, authentication, frequencies other than 0.25 Hz.

## Locked decisions

| Decision | Choice |
|---|---|
| `simulator/data/` | **Kept** as frozen FPGA test data: the three `.bin` files **and** the three `.csv` files (`fpga/tools/test_tools.py` and `generate_test_vectors.py` read the CSVs). The generator code that made them is removed. The FPGA team's dashboard, tests and test benches keep working unchanged. Only the `.png` plots are deleted. |
| Severity amplitudes | **normal 0 / mild 7 / moderate 14 / severe 30 mHz**, energy bands at 2.25M / 9M / 36M (verified above) |
| Diagnose noise | **Fresh random noise on every press.** The anomaly is identical each time; the noise differs. |
| Station selection | The user chooses the severity of each station independently (0–4 anomalous stations) |
| Phase | Fixed per station (North 0, East 0.15, South π, West π+0.2); not user-selectable |
| Location | Everything lives in `simulator/`; there is no separate `backend/` folder |
| WebSocket batching | 3 samples per message (10 messages/s), adjustable |
