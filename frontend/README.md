# Oscillation Cartographer — Live dashboard (Next.js)

The browser dashboard for the live PMU simulator:
- a map of the **real Brazos Valley power grid** (OpenStreetMap; United States only), where you assign real substations to the four virtual stations (North, East, South, West);
- a **three.js 3D model** of the selected substation that reacts to the live data;
- the live frequency waveform, and per-station **severity and phase** controls with **Inject disturbance**;
- **Diagnose** (FPGA detector), with a verdict panel and **Explain with Nemotron**;
- **Stream, FPGA and Nemotron status**, always visible.

The ThinkPad runs the simulator and talks to the DE1 over USB-Blaster. A browser on the same Wi-Fi can view the dashboard.

The specification and every design decision are in [MVP.md](MVP.md). **Phase 1 is built** (this README). **Phase 2, critical facilities, is not built yet**: see [Phase 2 handoff](#phase-2-handoff-critical-facilities).

## Prerequisites

- **Node.js 20.9 or newer in WSL.** Without sudo:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  # close and reopen the terminal (or: source ~/.bashrc)
  nvm install 22
  ```
- **Python** for the simulator: `start.sh` creates `.venv` and installs `simulator/requirements.txt` automatically. Manually: `python3 -m venv .venv && .venv/bin/pip install -r simulator/requirements.txt`.
- **Optional, for Nemotron:** fill in the repository-root `.env` (see `.env.example` and `simulator/README.md`).

## Start everything together

From the repository root in WSL, with the DE1 powered on and USB-Blaster connected:

```bash
bash start.sh
```

The launcher builds Next.js, invokes Windows PowerShell to compile and
program the DE1 with Quartus, then starts FastAPI and Next.js. Open
[localhost:3000](http://localhost:3000). Press Ctrl+C to stop the stack.

Use `bash start.sh --skip-program` when the DE1 already holds the current
bitstream, or `bash start.sh --reference` to use the Python detector (no board needed). Add
`--lan <ThinkPad-Wi-Fi-IPv4>` to start the Windows relay. See
`bash start.sh --help` for overrides.

## Start services individually

In WSL, from the repository root, install the simulator dependencies into
your Python environment and start FastAPI. Use the Quartus path installed
on the ThinkPad and a DE1 programmed with the Virtual JTAG image.

```bash
python -m pip install -r simulator/requirements.txt
SIM_DETECTOR=hardware SIM_QUARTUS_STP=/mnt/c/altera/13.0sp1/quartus/bin64/quartus_stp.exe python -m uvicorn simulator.app:app --host 127.0.0.1 --port 8000
```

Without the hardware environment variables, Diagnose uses the Python
reference. The dashboard displays the selected detector.

In another WSL terminal:

```bash
cd frontend
npm ci
npm run build
npm start
```

For development with hot reload, use `npm run dev` instead of build + start.

Open [localhost:3000](http://localhost:3000). Next.js forwards `/api/*` and `/ws/stream` to FastAPI on port 8000 (`next.config.mjs`; change the target with `SIMULATOR_URL`, which is read at build time for `npm start`). The map data route `/infra` is served by Next.js itself.

### Wi-Fi access

To enable access over Wi-Fi with the default WSL NAT setup, run the relay from the repository
root in Windows PowerShell with Windows Node.js installed. Replace the
example address with the ThinkPad's Wi-Fi IPv4 address from `ipconfig`.

```powershell
node frontend/lan.mjs 192.168.1.20
```

Open `http://192.168.1.20:3000` on the other computer using that same address.
The relay binds to that Windows interface and forwards to WSL Next.js.
Next.js proxies REST and WebSocket traffic to FastAPI over loopback.
If Windows blocks incoming requests, allow TCP 3000 from the Wi-Fi subnet
on the Wi-Fi interface. Clients share the simulator and its controls, so use
a trusted network. A Wi-Fi network with client isolation can block access.

### npm scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server (hot reload) on port 3000 |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Unit tests for the pure libraries (`node --test`, 13 tests) |
| `npm run snapshot` | Re-download the Brazos Valley map snapshot from OpenStreetMap |
| `npm run lan` | Wi-Fi relay (`lan.mjs`) |

## Use the dashboard

1. **Assign stations:** on the grid map, click a substation (white dot). The popup has **View in 3D** (opens a Preview tab, so you can inspect it first) and **Assign as N / E / S / W**. Assigned substations get a coloured letter badge, and assignments are saved in your browser.
2. **Inject a disturbance:** in *Station controls*, set each station's severity (normal / mild / moderate / severe) and phase (°), then press **Inject disturbance**. Within about 4 s:
   - the waveform changes;
   - the map badges pulse (one ring every 4 s, larger for higher severity);
   - the 3D model glows in the severity colour and sways at 0.25 Hz.
3. **Diagnose:** press **Diagnose**. The FPGA pill shows "diagnosing…" (in hardware mode the ThinkPad sends 2,400 packets to the DE1 and checks the four returned packets; the waveform keeps streaming). The *FPGA verdict* panel then shows:
   - a summary;
   - energy bars against the severity bands;
   - phase relationships;
   - the 20 s window that was analysed;
   - a demo check (whether the result matches what was injected).

   Alarmed stations turn red on the map (lines between them light up), and the 3D beacon turns red or green.
4. **Explain with Nemotron:** in the verdict panel. The Nemotron pill shows "thinking…", then the analysis appears under the verdict. The button is disabled when Nemotron isn't configured on the backend.
5. **Power lines** checkbox: hides or shows the transmission lines and legend; the choice is remembered. **Load in view** fetches live OpenStreetMap data for the area you've panned to (US only).

## How it's built

### Layout

```
Header: title + status pills (Stream · FPGA · Nemotron)
┌ Grid map (MapLibre) ───────────────┬ 3D substation (three.js) ──────┐
│ lines · substations · plants       │ tabs North|East|South|West     │
│ station badges · popups · toggle   │ (+ Preview)                    │
└────────────────────────────────────┴────────────────────────────────┘
Frequency deviation (canvas waveform, last 20 s)
Station controls (severity + phase per station; Inject / Clear / Diagnose)
FPGA verdict (summary, energy bars, phase, diagnosed window, demo check, Nemotron)
```

On narrow screens the map and the 3D view stack.

### Files

| Path | Role |
|---|---|
| `app/page.jsx` | Page composition and app state (assignments, preview, draft edits, map data) |
| `app/layout.jsx`, `app/style.css` | Shell and global styles (MapLibre CSS imported in the layout) |
| `app/infra/route.js` | `GET /infra?bbox=s,w,n,e`: map data (below) |
| `components/StatusBar.jsx` | Stream / FPGA / Nemotron pills, from WebSocket `status` messages |
| `components/GridMap.jsx` | MapLibre map: layers, tooltips, popups, station badges, line highlights, toggle, legend, US bounds |
| `components/SubstationScene.jsx` | three.js scene: procedural substation, live glow, 0.25 Hz sway, verdict beacon |
| `components/StationControls.jsx` | Station cards; Inject / Clear / Diagnose |
| `components/VerdictPanel.jsx` | FPGA verdict, plus the Explain with Nemotron button and answer |
| `components/Waveform.jsx` | Canvas line chart (live, and the diagnosed window) |
| `lib/useSimulator.js` | WebSocket + REST hook: `config`, `state`, `status`, `samples`, `latest` (ref), `diagnosis`, `diagnosisWindow`, `explanations`, `inject()`, `clear()`, `diagnose()`, `explain()` |
| `lib/overpass.mjs` | Overpass query (clipped to the US border), transmission filters, OSM → GeoJSON, bbox/US limits, server fallback |
| `lib/voltage.mjs` | Voltage tag parsing, colour bands, MapLibre expressions |
| `lib/assignments.mjs` | Station ↔ substation assignments and map prefs in `localStorage` |
| `lib/topology.mjs` | Distance helper; which lines touch or connect alarmed stations |
| `lib/substationModel.mjs` | OSM tags → 3D model parameters; severity glow colours |
| `lib/stations.js` | Station names, colours, letters, severity order |
| `data/infra-snapshot.json` | Brazos Valley grid snapshot: 39 substations, 13 plants, 656 line segments |
| `scripts/snapshot.mjs` | Regenerates the snapshot (`npm run snapshot`) |
| `tests/lib.test.mjs` | 13 unit tests for `lib/*.mjs` |

`.mjs` files are plain JavaScript with no React or browser dependencies, so the server route, the snapshot script and the tests all share them.

### Map data (`/infra`)

- **Source:** OpenStreetMap via the Overpass API, the same data OpenInfraMap draws. We query it ourselves; OpenInfraMap's servers aren't used.
- **What's kept:**
  - **transmission substations** (`substation=transmission`, or highest `voltage` ≥ 69 kV; distribution substations dropped);
  - **power plants** (display only, not assignable);
  - **power lines** ≥ 69 kV, plus lines with no voltage tag (drawn grey).
- **Snapshot first:** areas inside the Brazos Valley box (30.18–31.08 °N, 96.86–95.81 °W) are served from `data/infra-snapshot.json`, which is instant and works offline. `?live=1` forces a live query.
- **Live:** other areas query Overpass with a 25 s budget across three public servers (`OVERPASS_URLS`), and are cached in memory. If all fail, the snapshot is returned with `live_unavailable: true` and a `warning`, which the map shows as a banner. The public Overpass servers are often slow or overloaded; the fallback keeps the demo working.
- **Limits:**
  - areas larger than 1.5° per side are refused, and so are areas outside the United States;
  - the map can't be panned outside the contiguous US;
  - the query is clipped to the US border (`area["ISO3166-1"="US"]`).
- **Response:** `{ bbox, fetchedAt, source, substations, outlines, plants, lines }`. Each of the last four is a GeoJSON FeatureCollection. Substation properties: `id` (`"way/123"`), `name`, `operator`, `voltage` (raw tag), `voltagesKv` (highest first), `maxKv`, `substationType`, `outline` (ring of `[lon, lat]` for way substations).

### Map styling

- **Base:** OpenFreeMap minimal dark style (no API key). If it can't load, a plain dark background is used.
- **Lines:** coloured by `maxKv` (345 purple, 230 blue, 138 red, 115 orange-red, 69 orange, unknown grey), 1.4–2.6 px wide by voltage.
- **Plants and substations:** plants are yellow triangles; substations are white dots, with faint outlines from zoom 12.
- **Station badges:** DOM markers in the station colour. A CSS pulse ring (4 s period, sized by severity) is disabled under `prefers-reduced-motion`.
- **After Diagnose:**
  - alarmed badges turn red with `!`; clear ones get `✓`;
  - lines with an end at an alarmed station glow (`oc-lines-touch`); lines between two alarmed stations glow strongly (`oc-lines-connect`).

### 3D model

- `modelParams()` turns a substation summary into:
  - one bay per voltage level (gantry, 3-phase busbars, breakers, incoming lattice tower(s) with sagging conductors);
  - transformers;
  - a fenced yard sized from the OSM outline;
  - a control house with a beacon.

  Everything is procedural; there are no 3D files.
- **Every frame** (no React re-render), the scene reads `latest.current`:
  - busbar and conductor glow intensity follows the live `deviation_mhz`;
  - the glow colour follows severity (normal white, mild yellow, moderate orange, severe red; always paired with a text label);
  - the conductors sway at 0.25 Hz, scaled by amplitude;
  - the beacon pulses red on an FPGA alarm and turns green when clear.
- Orbit controls, auto-rotate after 8 s idle. Rendering pauses while the tab is hidden.

### Backend contract used

From the simulator (`simulator/README.md`):

| Endpoint / message | Used for |
|---|---|
| WS `/ws/stream` → `hello` | `config`, `state` (incl. `severities`, `phase_deg`), `status`, 20 s `history` |
| WS `samples` | Live waveform, frequencies, 3D glow |
| WS `state` / `reset` | Current severities and phases |
| WS `status` | FPGA `idle`/`diagnosing`/`error` + `available` + `last_run_ms`; Nemotron `not_configured`/`ready`/`thinking`/`error` + `model` |
| WS `diagnosis` | Verdict panel and the diagnosed `window` |
| WS `explanation` | Nemotron answer (also returned by the explain request) |
| `PUT /api/anomaly` | Inject: `{North: "severe", …, phase_deg: {North: 0, …}}` |
| `DELETE /api/anomaly` | Clear |
| `POST /api/diagnose` | Diagnose |
| `POST /api/diagnoses/{id}/explain` | Explain with Nemotron |

## Verification

Done during the build:
- `npm test`: 13/13 pass.
- `npm run build`: compiles cleanly.
- Simulator tests: 44 pass.
- The snapshot was downloaded live with the US-border query.
- **End-to-end** through the Next.js server against a running simulator and a fake Nemotron model (15/15):
  - the page, `/infra` (snapshot), non-US and oversized areas rejected;
  - WebSocket streaming through the proxy, with `hello` status;
  - Inject with `phase_deg`, and invalid phase → 422;
  - Diagnose (multi-station, North and South opposite), FPGA status `diagnosing → idle`, the diagnosed window;
  - Explain through the proxy, Nemotron status `thinking → ready`, the `explanation` broadcast, `/api/status`.

Not verified automatically: **visual rendering** (map, 3D, colours, layout). Check in a browser:
1. The map opens on College Station with coloured lines, white substation dots and yellow plant triangles, on a dark base map with town names.
2. Hovering shows tooltips. Clicking a substation shows View in 3D and N/E/S/W.
3. View in 3D opens a Preview tab. Assign all four; the badges appear and survive a reload.
4. The Power lines checkbox hides and shows the lines and legend.
5. Inject North severe and South mild: the North badge pulses, and the 3D North tab glows red and sways.
6. Diagnose: the FPGA pill shows diagnosing then idle, the verdict fills, the North and South badges turn red, lines light up, and the beacon pulses red.
7. Explain with Nemotron (if configured): the pill shows thinking, then the answer appears.
8. You can't pan out of the United States.

## Phase 2 handoff: critical facilities

**Not built yet.** The full spec is in [MVP.md → Phase 2](MVP.md#phase-2--critical-facilities-after-phase-1s-map-works). Where it plugs in:

1. **Data, `lib/overpass.mjs`:**
   - extend `buildQuery()` with the 8 categories (hospitals, military, water, major oil & gas, emergency, airports, data centres, universities). Keep `(area.us)` and the bbox on every statement. Use `out center tags` for areas; major pipelines need `out geom`;
   - extend `parseOverpass()` to return a `facilities` FeatureCollection with a `category` property;
   - add tests in `tests/lib.test.mjs`.
2. **Scoring, new `lib/critical.mjs`:** a category → tags/weight table; attribute each facility to its **nearest transmission substation within 10 km** (`distanceKm` in `lib/topology.mjs`); compute each substation's score. Pure and unit-tested.
3. **Snapshot:** run `npm run snapshot` after step 1, then check that Texas A&M and the local hospitals are in it.
4. **Map, `components/GridMap.jsx`:**
   - add an `oc-facilities-src` source and one symbol layer per category, with icons from `map.addImage()` like `triangleImage()`. Don't rely on base-map glyphs; they're absent in the offline fallback;
   - per-category toggles via `setLayoutProperty(…, 'visibility', …)`, like the power-lines toggle, stored with `loadPrefs`/`savePrefs` in `lib/assignments.mjs`;
   - score halos: a circle layer under `oc-subs`;
   - the "nearest substation for …" list in the `oc-subs` click popup.
5. **Verdict, `components/VerdictPanel.jsx`:** an impact line for alarmed stations, from their assigned substation's facility list.
6. **Nemotron:** the explain endpoint (`simulator/nemotron.py`, `explain_diagnosis`) currently sends only the diagnosis. Phase 2 should add the alarmed stations' facility lists to the evidence (for example, the frontend sends them in the explain request body, or the backend gets a `get_critical_facilities` tool), so the analysis can rank impact.

Keep the phase 1 rules:
- **"nearest substation", never "serves":** this is a proximity estimate, because OSM doesn't record which substation feeds which facility;
- US-only queries;
- the snapshot-first route behaviour;
- text labels alongside colours.
