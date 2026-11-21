# GridSent — dashboard (Next.js)

Browser interface for the Oscillation Cartographer project: power grid oscillation analysis on **simulated** PMU telemetry, with FPGA detection and Nemotron diagnostics.

- **Grid topology map:** real transmission infrastructure from OpenStreetMap (United States only), cached for 8 Texas regions, plus critical facilities (Phase 2). Assign real substations to stations 1–4.
- **Substation view:** a three.js model of the selected station's substation, with a live technical readout.
- **Frequency deviation chart:** Δf = f − 60.000 Hz for stations 1–4, at 30 samples/s.
- **Disturbance injection:** per-station oscillation severity and phase.
- **Diagnostic report:** detector output (measured), backend analysis (computed), impact estimate (proximity), and the Nemotron interpretation (AI-generated, clearly separated).
- **Status bar** (bottom): telemetry stream, detector, Nemotron and topology source.

Stations are labelled **1–4** in the interface. The simulator and backend call them North (1), East (2), South (3) and West (4); Nemotron's text may use those names.

Specification and decisions: [MVP.md](MVP.md). Phase 1 (map, 3D view, Diagnose) and Phase 2 (critical facilities) are both built.

## Prerequisites

- **Node.js 20.9 or newer in WSL.** Without sudo:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  # close and reopen the terminal (or: source ~/.bashrc)
  nvm install 22
  ```
- **Python** for the simulator: `start.sh` creates `.venv` and installs `simulator/requirements.txt` automatically. Manually: `python3 -m venv .venv && .venv/bin/pip install -r simulator/requirements.txt`.
- **Optional, Nemotron:** fill in the repository-root `.env` (see `.env.example` and `simulator/README.md`).

## Start everything together

From the repository root in WSL, with the DE1 powered on and USB-Blaster connected:

```bash
bash start.sh
```

The launcher builds Next.js, invokes Windows PowerShell to compile and program the DE1 with Quartus, then starts FastAPI and Next.js. Open [localhost:3000](http://localhost:3000). Press Ctrl+C to stop the stack.

Use `bash start.sh --skip-program` when the DE1 already holds the current bitstream, or `bash start.sh --reference` to use the Python detector (no board needed). Add `--lan <ThinkPad-Wi-Fi-IPv4>` to start the Windows relay. See `bash start.sh --help` for overrides.

## Start services individually

In WSL, from the repository root:

```bash
python -m pip install -r simulator/requirements.txt
SIM_DETECTOR=hardware SIM_QUARTUS_STP=/mnt/c/altera/13.0sp1/quartus/bin64/quartus_stp.exe python -m uvicorn simulator.app:app --host 127.0.0.1 --port 8000
```

Without the hardware environment variables, Diagnose uses the Python reference (a bit-exact model of the FPGA).

In another WSL terminal:

```bash
cd frontend
npm ci
npm run build
npm start        # or `npm run dev` for hot reload
```

Open [localhost:3000](http://localhost:3000). Next.js forwards `/api/*` and `/ws/stream` to FastAPI on port 8000 (`next.config.mjs`; change the target with `SIMULATOR_URL`, read at build time for `npm start`). `/infra` (map data) and `/map-worker/*` (MapLibre's worker script) are served by Next.js itself.

**Demo links:** `/?region=<id>` opens the map at a cached region, for example `/?region=houston`. The ids are listed under [Map data](#map-data-infra).

### Wi-Fi access

With the default WSL NAT setup, run the relay from the repository root in Windows PowerShell with Windows Node.js installed, using the ThinkPad's Wi-Fi IPv4 address from `ipconfig`:

```powershell
node frontend/lan.mjs 192.168.1.20
```

Open `http://192.168.1.20:3000` on the other computer. The relay forwards to WSL Next.js, which proxies REST and WebSocket traffic to FastAPI. If Windows blocks incoming requests, allow TCP 3000 from the Wi-Fi subnet. Clients share the simulator and its controls, so use a trusted network.

### npm scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Unit tests for the pure libraries (`node --test`, 23 tests) |
| `npm run regions [-- <ids>] [-- --force]` | Download cached power-grid regions from OpenStreetMap |
| `npm run facilities [-- <ids>] [-- --force]` | Download critical facilities for regions |
| `npm run snapshot` | Re-download the Brazos Valley grid (the original snapshot) |
| `npm run lan` | Wi-Fi relay (`lan.mjs`) |

The download scripts skip regions that already have a file, and retry the overloaded public Overpass servers patiently (`lib/overpassRetry.mjs`). Expect 35–75 s per region when the servers cooperate.

## Using the dashboard

1. **Choose a region:** use the *Region* menu in the map header, or `/?region=…`.
2. **Assign stations:** click a substation (white dot) for **View in 3D** (opens a *Preview* in the substation panel) or **Assign as station 1–4**. Assigned substations show a numbered badge; assignments are saved in the browser.
3. **Facilities:** the map's **Facilities** button lists the 8 categories with counts and toggles. Grey rings on substations show criticality (facilities within 10 km whose nearest transmission substation it is).
4. **Inject a disturbance:** in *Disturbance injection*, set each station's oscillation (none / mild 7 / moderate 14 / severe 30 mHz) and phase, then **Inject disturbance**. Within about 4 s:
   - the chart changes;
   - the station's map badge pulses once every 4 s (amber, or red for severe);
   - the substation model's conductors glow amber or red and sway at 0.25 Hz.
5. **Run diagnosis:** sends the last 20 s (2,400 measurements) to the detector. Energy (I²+Q²) is shown in **Hz²** (raw mHz² ÷ 10⁶; exact raw value on hover, `lib/energy.mjs`), so the alarm threshold reads 2.25 Hz² and is marked with a red tick on each bar; every row says `alarm · ≥ 2.25 Hz²` or `clear · < 2.25 Hz²`. The *Diagnostic report* fills in, alarmed stations turn red on the map (with the lines between them), and the substation beacon turns red (alarm) or blue (clear). The report survives a page reload.
6. **Nemotron:** **Request interpretation** in the report. The answer is formatted as a report (headings, lists) and labelled AI-generated. When facility data is loaded, the alarmed stations' nearby critical facilities are sent as extra evidence.

## Design system

The interface uses an industrial-monitoring look: neutral near-black, information-dense, no decoration.

| Token | Value | Use |
|---|---|---|
| Background | `#09090B` | Page |
| Panel | `#111113` | Panels |
| Raised | `#18181B` | Inputs, popups, segmented control |
| Border | `#27272A` | 1px borders (radius 4–6 px) |
| Text / secondary | `#EDEDED` / `#8B8B95` | |
| Accent | `#60A5FA` | The only interactive colour |
| Warning / fault | `#E0A33A` / `#E5484D` | **Only** for warnings and faults (oscillation severity, alarms, errors) |

- **Fonts:** Inter (interface) and JetBrains Mono (measurements, frequencies, energies, timestamps), bundled through `@fontsource` so builds and the demo work offline. Measurements use tabular numerals.
- **Station trace colours** (`lib/stations.js`): restrained blue, teal, lilac and grey, never red or amber.
- **Map:**
  - the base map labels are dimmed and the voltage colours desaturated (`lib/voltage.mjs`);
  - criticality rings and facility markers are neutral, with category letters;
  - notices appear **below** the map, never over it.
- **3D:** charcoal background, realistic material colours, and glow only while a station is oscillating.
- **No decoration:** no gradients, glows, pills or emojis. Status lives in the bottom status bar.

## How it's built

### Layout

```
Header: GridSent · Power grid oscillation analysis            (simulated telemetry note)
┌ Grid topology (60%) ──────────────────────┬ Substation (40%) ─ [1|2|3|4|Preview] ┐
│ map · Lines / Facilities / Load view       │ three.js model                         │
│ legend                                     │ readout: substation, kV, f, Δf,        │
│ topology source · notices                  │ injected, detector                     │
├ Frequency deviation (full width) ──────────┴────────────────────────────────────────┤
├ Disturbance injection ────────────────┬ Diagnostic report ──────────────────────────┤
Status bar: Telemetry · Detector · Nemotron · Topology
```

Below 1,100 px wide, the rows stack into one column.

### Files

| Path | Role |
|---|---|
| `app/page.jsx` | Layout and app state (assignments, regions, preview, draft edits, criticality, Nemotron context) |
| `app/layout.jsx`, `app/style.css` | Fonts and the design system |
| `app/infra/route.js` | `GET /infra`: cached regions and facilities, instant "not pre-loaded", opt-in live queries |
| `app/map-worker/[asset]/route.js` | Serves MapLibre's worker script (MapLibre 6 can't find it inside the Next.js bundle) |
| `components/GridMap.jsx` | MapLibre map: grid layers, facilities, rings, popups, badges, controls, legend |
| `components/SubstationScene.jsx` | three.js substation: procedural model, oscillation glow and sway, verdict beacon |
| `components/Waveform.jsx` | Instrument-style Δf chart (live, and the diagnosed window) |
| `components/StationControls.jsx` | Disturbance injection table; Inject / Clear / Run diagnosis |
| `components/VerdictPanel.jsx` | Diagnostic report (detector, analysis, impact, Nemotron) |
| `components/StatusFooter.jsx` | Bottom status bar |
| `lib/useSimulator.js` | WebSocket + REST hook; restores the latest diagnosis on reload |
| `lib/regions.mjs` | Cached region list and `regionFor(bbox)` |
| `lib/overpass.mjs`, `lib/overpassRetry.mjs` | Overpass queries (US-only), parsing, patient retries |
| `lib/critical.mjs` | Phase 2: categories, facility query and parsing, nearest-substation attribution, scoring |
| `lib/reportFormat.mjs` | Nemotron text → report blocks (headings, lists, paragraphs) |
| `lib/energy.mjs` | Detector energy display: mHz² → Hz², alarm threshold and band edges |
| `lib/voltage.mjs`, `lib/topology.mjs`, `lib/substationModel.mjs`, `lib/assignments.mjs`, `lib/stations.js` | Voltage colours, line topology, 3D parameters, browser-saved assignments and prefs, station labels and colours |
| `data/infra-snapshot.json`, `data/regions/*.json` | Cached power-grid regions |
| `data/facilities/*.json` | Cached critical facilities per region |
| `scripts/regions.mjs`, `scripts/facilities.mjs`, `scripts/snapshot.mjs` | Download scripts |
| `tests/lib.test.mjs` | 23 unit tests |

`.mjs` files are plain JavaScript without React, shared by the server route, the scripts and the tests.

### Map data (`/infra`)

The public Overpass servers are too slow for interactive use (30–60 s per area, often failing), so regions are cached ahead of time.

| Region (`id`) | Grid | Facilities |
|---|---|---|
| San Antonio (`san-antonio`) | ✓ | ✓ |
| Corpus Christi (`corpus-christi`) | ✓ | ✓ |
| Laredo (`laredo`) | ✓ | ✓ |
| Rio Grande Valley (`rio-grande-valley`) | ✓ | — |
| Houston (`houston`) | ✓ | ✓ |
| Dallas–Fort Worth (`dallas-fort-worth`) | ✓ | ✓ |
| Austin (`austin`) | ✓ | ✓ |
| Brazos Valley (`brazos-valley`, default) | ✓ | ✓ |

- `GET /infra` returns the default region, and `?region=<id>` returns a cached region. `?regions=1` lists the regions and whether each is downloaded.
- `GET /infra?bbox=s,w,n,e` (**Load view**):
  - if a cached region covers the view, it's returned instantly; if a region covers most of it, that region is returned with a note;
  - otherwise the route answers instantly with `404 {code: "not_preloaded"}` and the map offers **Try live load (slow)** (`&live=1`, up to 60 s).
- **What's kept:**
  - transmission substations (≥ 69 kV or `substation=transmission`);
  - power plants (display only);
  - power lines (≥ 69 kV or no voltage tag).
- **US only:** requests outside the US are refused and the map can't be panned out of the contiguous US. Border regions use the OSM US-border clip.
- **Response:** `{ bbox, region, source, fetchedAt, substations, outlines, plants, lines, facilities?, pipelines?, facilitiesAvailable }`.
- **Adding a region:** add it to `REGIONS` in `lib/regions.mjs`, then run `npm run regions -- <id>` and `npm run facilities -- <id>`.

### Critical facilities (Phase 2)

- **8 categories** (`lib/critical.mjs`) with weights: hospitals 5, military 5, water and wastewater 4, major oil & gas 3, emergency 3, airports 3, data centres 2, universities 2. Major oil and gas means refineries and terminals, plus pipelines with a name or operator; minor military features and private airstrips are excluded.
- **Attribution:** each facility counts once, toward its **nearest transmission substation within 10 km**. A substation's criticality is the sum of its facilities' weights. This is a **proximity estimate**: the UI says "nearest substation for", never "serves".
- **Map:**
  - per-category toggles (defaults: hospitals, military, water, oil & gas), remembered in the browser;
  - criticality rings;
  - dotted facility → substation lines from zoom 10.5;
  - dashed pipelines;
  - the substation popup lists its facilities.
- **Report:** an *Impact estimate* section for alarmed stations.
- **Nemotron:** `POST /api/diagnoses/{id}/explain` gets an optional body `{"context": {"critical_facilities": …}}` with the alarmed stations' facilities. The backend passes it to the model as `grid_context`, and the prompt tells the model to treat it as a proximity estimate.

### Backend contract used

| Endpoint / message | Used for |
|---|---|
| WS `/ws/stream` → `hello` | `config`, `state` (severities, `phase_deg`), `status`, 20 s history |
| WS `samples` / `state` / `reset` | Chart, readouts, 3D glow; current settings |
| WS `status` | Status bar (detector and Nemotron states) |
| WS `diagnosis` / `explanation` | Report, and the analysed window |
| `PUT` / `DELETE /api/anomaly` | Inject / Clear |
| `POST /api/diagnose`, `GET /api/diagnoses` | Run diagnosis; restore the latest after a reload |
| `POST /api/diagnoses/{id}/explain` | Nemotron interpretation (optional `context` body) |

## Verification

Done after the redesign:
- `npm test`: 22/22 pass. Simulator tests: 45 pass. `npm run build`: compiles.
- **End-to-end** against running servers with a fake Nemotron model (13/13):
  - the GridSent page and all regions load (20–200 ms) with facilities;
  - an uncovered area answers instantly (17 ms);
  - inject, diagnose and explain (with facility context) work through the proxy;
  - the explanation is broadcast and the latest diagnosis is restorable.
- **Headless Edge screenshots:**
  - the header, layout, map (base map, desaturated lines), substation model and readout, chart, injection table, diagnostic report and status bar all render;
  - an in-browser probe confirmed the substation, plant, facility and ring layers draw features;
  - Nemotron report formatting is covered by a unit test.

Not verified automatically: clicking through the map popups and the Nemotron report with a real model. Browser checklist:
1. Pick Houston in the Region menu. The map flies there; Facilities shows the counts.
2. Click a substation: View in 3D, then assign it as station 1. The badge "1" appears and survives a reload.
3. Inject station 1 severe: the badge pulses red, the conductors glow, the chart shows a 30 mHz sine.
4. Run diagnosis: the report fills in, the badge turns red with "!", the impact estimate lists nearby facilities.
5. Request interpretation (with Nemotron configured): a structured report labelled AI-generated.
