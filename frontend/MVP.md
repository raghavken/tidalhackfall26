# MVP — Oscillation Cartographer: Map + 3D Dashboard

## Context

The live simulator (`simulator/`) streams four virtual PMUs (North, East, South, West) over a WebSocket and runs Diagnose through the FPGA detector. This MVP is the browser dashboard for it, a Next.js app in `frontend/`, with:

1. **Station controls:** a severity dropdown and phase input for each station, and an **Inject disturbance** button.
2. **A map of real power infrastructure:** OpenStreetMap data, the same data OpenInfraMap draws. Substations, power plants and transmission lines around College Station, TX. The user assigns a real substation to each virtual station.
3. **A three.js 3D model** of the selected substation that reacts to live data and to the FPGA's verdict.
4. **A Diagnose flow:** send the window to the FPGA, show a "diagnosing" state, then show what the FPGA concluded.
5. **FPGA and Nemotron status**, always visible.

## Prerequisites

**Node.js 22 LTS** (Next.js 16 needs ≥ 20.9). Install without sudo:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# reopen the terminal
nvm install 22
```

## Part A — Simulator changes (`simulator/`)

### A1. Per-station phase (`phase_deg`)

- `PUT /api/anomaly` accepts an optional `phase_deg` object alongside the severities:
  ```json
  {"North": "severe", "South": "mild",
   "phase_deg": {"North": 0, "East": 8.6, "South": 180, "West": 191.5}}
  ```
  Each value must be between −360 and 360 (otherwise `422`). Stations omitted from `phase_deg` keep their current phase, and omitting `phase_deg` entirely leaves all phases unchanged. Severities keep their "replace" behaviour (omitted = normal).
- Defaults are the current fixed phases in degrees: North 0, East 8.59, South 180, West 191.46.
- `GET /api/state` and WebSocket `state` messages include `phase_deg`.
- **Live stream:** a phase change slides to the new phase over the same 4 s raised-cosine ramp as severity, so there's no jump.
- **Diagnose** uses the current phases. Severity bands are unchanged. The in-phase/opposite analysis follows the phases set; for example North and South both at 0° are reported `in_phase`.

### A2. Status endpoint and messages

`GET /api/status`:

```json
{
  "stream": {"running": true, "clients": 2, "sample_index": 5421},
  "fpga": {"detector": "reference", "available": true,
           "state": "idle", "last_diagnosis_id": 3, "last_run_ms": 24, "last_error": null},
  "nemotron": {"state": "not_connected", "detail": "Agent not built yet"}
}
```

- `fpga.state` is `idle`, `diagnosing` or `error`. `available` is false for the `hardware` stub, or if the reference model can't load.
- `nemotron.state` is a fixed `not_connected` until the agent exists. The field is there so the frontend doesn't need to change later.
- New WebSocket message `{"type": "status", "status": {...}}`, sent when Diagnose starts, when it finishes or fails, and when the stream pauses or resumes. The `hello` message also includes `status`.

### A3. Tests

Phase validation and persistence; the live phase ramp has no jump; Diagnose with North and South at 0° reports `in_phase`; status moves through `idle` → `diagnosing` → `idle`; the hardware detector reports `available: false`. All existing simulator tests must still pass.

## Part B — Frontend (`frontend/`)

### Page layout

```
┌ Header ─────────────────────────────────────────────────────────────────┐
│ Oscillation Cartographer   [● Stream: live] [● FPGA: Python ref · idle]  │
│                            [○ Nemotron: not connected]                   │
├ Grid map ───────────────────────────┬ 3D substation ─────────────────────┤
│  dark base map, transmission lines, │  three.js model of the selected     │
│  substations and plants;            │  station; tabs North|East|South|West│
│  N/E/S/W badges on assigned ones    │  animates with live data; alarm     │
│  [☑ Power lines] [Load in view]     │  beacon after FPGA verdict          │
├ Frequency deviation (live waveform, 4 stations, last 20 s) ──────────────┤
├ Station controls ────────────────────────────────────────────────────────┤
│  North · Bryan Sub 138 kV · severity [severe ▾] · phase [0]             │
│  East … South … West …                 2 of 4 stations affected          │
│  [Inject disturbance]  [Clear anomalies]  [Diagnose]                     │
├ FPGA verdict (after Diagnose) ───────────────────────────────────────────┤
│  "diagnosing…" → summary, energy bars vs severity bands, phase           │
│  relationships, the 20 s window that was diagnosed                       │
└──────────────────────────────────────────────────────────────────────────┘
```

On narrow screens everything stacks in one column. (Substation names in the sketches are illustrative.)

### B1. Station controls and Inject

- Four station cards. Each shows the station's colour, its live frequency, the **assigned real substation** (name and voltage, or "unassigned"), a **severity** dropdown (normal / mild / moderate / severe, with each band's amplitude) and a **phase (°)** input.
- **Inject disturbance** sends all four cards' settings in one `PUT /api/anomaly`. The "N of 4 stations affected" count is the number not set to `normal`.
- **Clear anomalies** (`DELETE /api/anomaly`) and **Diagnose** (`POST /api/diagnose`).
- Edits are a draft until Inject is pressed. Diagnose is disabled while there are un-injected edits, so it always diagnoses what's actually streaming.

### B2. Grid map

**Libraries and data**

- **MapLibre GL JS** (open source, WebGL).
- **Base map:** OpenFreeMap's minimal **dark** vector style (`https://tiles.openfreemap.org/styles/dark`). It's free, needs no API key, and is built on OpenStreetMap data. Attribution is shown in the corner. If the tile service is unreachable, the map falls back to a plain dark background with only our infrastructure layers, so the demo still works.
- **Infrastructure data:** a Next.js server route, `GET /infra?bbox=s,w,n,e`, queries the OpenStreetMap **Overpass API** for:
  - `power=substation`: **transmission substations only**. A substation is kept if it's tagged `substation=transmission` or its highest `voltage` is ≥ 69 kV. Small local distribution substations (`substation=distribution`/`minor_distribution`, or below 69 kV) are dropped to avoid clutter;
  - `power=plant`: shown for context but **not assignable** as a station;
  - `power=line` with voltage ≥ 69 kV: the transmission lines. Local distribution wires are excluded, to avoid clutter.
- The route runs on the server, so the browser has no CORS issues. Results are cached in memory per bounding box.
- **Snapshot first, live for new areas:** `frontend/data/infra-snapshot.json` covers the **wider Brazos Valley** (bbox 30.18–31.08 °N, 96.86–95.81 °W, about 100 × 100 km around College Station). Any requested area inside it is served from the snapshot instantly, which keeps the demo fast and offline-safe. Areas outside it are queried live from Overpass (25 s timeout). If that fails, the route returns the snapshot with a "live data unavailable" flag.
- It refuses areas larger than about 1.5° × 1.5° to keep queries polite and fast.
- **United States only:** the map can't be panned outside the contiguous US, the route rejects areas outside it, and the Overpass query is clipped to the US border (`area["ISO3166-1"="US"]`), so border regions don't include Canadian or Mexican infrastructure.
- **Default view:** centred on College Station, Texas (30.628, −96.334), at zoom 10 so the whole Brazos Valley grid is visible. It loads automatically on page open. **Load in view** fetches the area the user has panned to.

**What the finished grid map looks like**

```
 ┌───────────────────────────────────────────────────────────────┐
 │ · · ·  dark charcoal background, faint grey roads, dim blue   │
 │        water, small grey town labels (Bryan, College Station) │
 │                                                               │
 │      ●══════════════════════●  (N) Bryan Sub    ← N badge     │
 │      ║   purple 345 kV          blue ring, pulsing (severe)   │
 │      ║                                                        │
 │ ▲ power plant ─────────── red 138 kV ───────────● (E)         │
 │  (gas, 600 MW)                                  green ring    │
 │      ║                                                        │
 │      ●  unassigned substation (small white dot)               │
 │      ║                                                        │
 │      ● (S) ───── orange 69 kV ───── ● (W)                     │
 │        orange ring, pulsing (mild)    violet ring (normal)    │
 │                                                               │
 │ [☑ Power lines]  [Load in view]   legend: 69 · 138 · 345 kV   │
 └───────────────────────────────────────────────────────────────┘
```

- **Base:** almost black, with roads as faint grey lines, water in muted dark blue, and only town-level labels. Nothing competes with the infrastructure.
- **Transmission lines** (when the toggle is on): thin (1.5–2.5 px) lines that thicken with voltage, coloured by voltage like OpenInfraMap: **345 kV purple, 230 kV blue, 138 kV red, 115 kV orange-red, 69 kV orange**, and other voltages grey. They show the grid as a network: which substations connect to which, and how.
- **Substations:** small white dots. When zoomed in far enough that its OSM outline is bigger than a dot, a substation is drawn as a faint filled polygon instead.
- **Power plants:** triangle markers, labelled with their source (gas, coal, solar, wind) and capacity when OSM has them.
- **Hover** on any line or substation shows a tooltip: name, operator, voltage.
- **Click** a substation to open a popup with its details and the buttons **View in 3D** and **Assign as North / East / South / West**. View in 3D lets you inspect a substation before deciding to assign it.
- **Assigned substations** become larger markers with a letter badge (N/E/S/W) in that station's chart colour, so the map, waveform, controls and 3D tabs all use the same colour per station.
- **Live state on the map:**
  - when a station's severity isn't normal, its marker gets a **pulsing ring**; the pulse beats at the real 0.25 Hz (once every 4 s), and the ring grows with severity;
  - after Diagnose, alarmed stations turn **red** with a solid glow and clear ones get a green check. Lines directly connecting two alarmed stations are highlighted, which visualizes the disturbance path.
- **Power lines toggle:** a checkbox in the map corner, on by default. Turning it off hides the transmission lines instantly (it hides the layer; no reload), leaving just the substations and plants. The choice is remembered in the browser.
- **Legend:** a small voltage colour key, shown only while lines are visible.
- Assignments are saved in the browser (`localStorage`) and survive a refresh. They're for display only; the simulator still generates the four virtual stations.

### B3. three.js substation model

- One canvas shows the selected station, with **tabs North | East | South | West**. Clicking an assigned map badge also switches the tab.
- **Preview tab:** "View in 3D" on an unassigned substation opens it in an extra **Preview** tab, with the model built from its tags, a neutral grey glow (it has no live data) and an **Assign as…** button. Previewing another substation replaces the preview; assigning it moves it to that station's tab.
- **Procedural model** (no downloaded 3D files), built from the station's OSM tags:
  - a fenced gravel yard, sized from the OSM outline when available, otherwise a default size;
  - incoming lines on steel lattice towers, one set per voltage level;
  - busbars on gantries;
  - power transformers, one per voltage level in the `voltage` tag (for example `138000;69000` → 2);
  - breakers and a control house;
  - the station name and voltage as a floating label.
- **Live behaviour:**
  - busbars and conductors glow, with intensity following the station's live `deviation_mhz`;
  - the glow colour follows the requested severity: normal soft white, mild yellow, moderate orange, severe red. Severity colours are always paired with a text label (the overlay says "severe"), because some station identity colours are similar (for example South's orange);
  - the conductors sway gently at the real 0.25 Hz.
- **After Diagnose:** a beacon on the control house shows the FPGA's alarm for this station (red if alarmed, green if clear), with an overlay of energy and severity band.
- Orbit controls (drag to rotate, scroll to zoom), slow auto-rotate when idle. Unassigned stations show a generic substation.
- Loaded only in the browser (dynamic import, SSR off). Rendering pauses when the tab is hidden.

### B4. Diagnose flow and FPGA verdict

1. Click **Diagnose**: the FPGA status pill shows "diagnosing…" (from the `status` WebSocket message) and the verdict panel shows a spinner.
2. When the `diagnosis` message arrives, the verdict panel shows:
   - **a summary line**, for example "Multi-station oscillation: North (severe), South (mild); opposite phase";
   - **energy bars** for each station on a log scale, with the band edges (2.25M / 9M / 36M) marked;
   - **phase relationships** for each alarmed pair;
   - **the diagnosed 20 s window**, plotted from the message's `window`;
   - the detector (Python reference or DE1 FPGA) and the run time.
3. Map markers, connecting lines and the 3D beacon update to match the verdict.
4. `requested` and `matches_request` (ground truth) appear only as a small "demo check ✓" badge, never as part of the evidence.

### B5. Status pills (header)

- **Stream:** live, reconnecting or paused (from the WebSocket and `state`).
- **FPGA:** the detector name plus idle, diagnosing or error, and the last run time (from `status`). Grey when `available` is false.
- **Nemotron:** "not connected" (grey) until the backend reports otherwise.

### Code structure

```text
frontend/
├── MVP.md
├── README.md                    # rewritten: setup (Node via nvm), running both servers, features
├── package.json                 # scripts: dev, build, start, lan, test
├── lan.mjs                      # kept: optional Wi-Fi relay for viewing from another computer
├── next.config.mjs              # rewrites /api/* and /ws/stream to FastAPI (port 8000)
├── app/
│   ├── layout.jsx
│   ├── page.jsx                 # page layout; composes the components
│   ├── style.css
│   └── infra/route.js           # Overpass proxy + cache + snapshot fallback
├── components/
│   ├── StatusBar.jsx
│   ├── Waveform.jsx             # canvas live waveform
│   ├── StationControls.jsx
│   ├── GridMap.jsx              # MapLibre map, layers, toggle, popups (client-only)
│   ├── SubstationScene.jsx      # three.js (client-only)
│   └── VerdictPanel.jsx
├── lib/
│   ├── useSimulator.js          # WebSocket + REST hook
│   ├── assignments.js           # localStorage station ↔ substation, toggle state
│   ├── overpass.js              # query builder + OSM → GeoJSON parsing
│   ├── voltage.js               # voltage tag parsing + colour scale
│   └── substationModel.js       # tags → model parameters (pure, testable)
├── data/infra-snapshot.json     # College Station snapshot (offline fallback); generated by scripts/snapshot.mjs
├── scripts/snapshot.mjs         # one command to re-download the snapshot from Overpass
└── tests/                       # node:test unit tests (no extra framework)
```

**npm dependencies:** `next`, `react`, `react-dom`, plus new `three` and `maplibre-gl`, pinned to exact versions at least 2 weeks old.

## Acceptance criteria

**Simulator**
- `phase_deg` is accepted, validated and reported in state. Phase changes ramp with no jump.
- `/api/status` and the `status` messages report idle → diagnosing → idle around a Diagnose.
- All simulator tests pass, old and new.

**Frontend**
- `npm run build` succeeds with no errors.
- With the simulator running, the page loads, connects and streams live.
- Inject with any mix of severities and phases updates the waveform within about 4 s. The affected count is correct.
- The map opens on College Station with transmission lines, substations and plants. With the network blocked, the snapshot loads instead.
- The power-lines toggle hides and shows the lines without reloading, and the choice survives a refresh.
- All four stations can be assigned by clicking, and the assignments survive a refresh. Assigned markers pulse with severity.
- "View in 3D" on any substation shows it in the Preview tab before it's assigned.
- The 3D view renders the selected station, its colour follows severity, and it sways at about 0.25 Hz. Switching tabs switches the model.
- Diagnose shows "diagnosing…", then the verdict panel. Map markers, connecting lines and 3D beacons match the FPGA results.
- The Stream, FPGA and Nemotron status pills are always visible.
- Unit tests (`node --test`) pass for the Overpass parsing, voltage colours, tag → model parameters and assignment storage.
- The page works at phone width (single column), and the map and 3D panels don't overflow.

## Phase 2 — Critical facilities (after phase 1's map works)

Mark the places that depend most on the grid, so each substation carries a sense of what's at stake. All data comes from OpenStreetMap through the same `/infra` route.

### Categories (all 8)

| Category | OSM tags | Marker | Weight |
|---|---|---|---|
| Hospitals | `amenity=hospital` | red cross | 5 |
| Military / defence | `landuse=military`, `military=*` (bases, airfields) | shield | 5 |
| Water & wastewater | `man_made=water_works`, `man_made=wastewater_plant` | water drop | 4 |
| Oil & gas (major only) | `industrial=refinery`, major `man_made=pipeline` (oil/gas, tagged with an operator or name), large `man_made=storage_tank` sites | droplet; pipelines as dashed lines | 3 |
| Emergency services | `amenity=fire_station`, `amenity=police` | siren | 3 |
| Airports | `aeroway=aerodrome` (public airports, not private strips) | plane | 3 |
| Data centres / telecom | `telecom=data_center`, `building=data_center` | server | 2 |
| Universities | `amenity=university` | cap | 2 |

Scope is limited to what OpenStreetMap maps well and quickly: **major** oil & gas only (refineries, named pipelines, tank farms; no individual well pads), public military boundaries only, and polygons reduced to their centre point.

### Map behaviour

- One toggle per category in a "Critical facilities" panel. On by default: hospitals, military, oil & gas, water; the rest off.
- Each facility is attributed to its **nearest transmission substation within 10 km**, so it counts once. That gives each substation a **criticality score**, the sum of its facilities' weights.
- Critical substations get an **amber halo** sized by score. A faint shaded area around each shows the region it's attributed to.
- The substation popup lists what's nearby, for example: "Bryan Sub · 138 kV · nearest substation for 2 hospitals, 1 water plant, Texas A&M".
- Labelled **"nearest substation"**, not "serves": OpenStreetMap doesn't record which substation actually feeds a facility, so this is a proximity estimate.

### Diagnose integration

- The verdict panel adds an **impact line** for alarmed stations, for example "Severe oscillation at North (Bryan Sub): nearest substation for 2 hospitals and 1 water treatment plant."
- The diagnosis evidence includes each station's facility list and score, ready for the Nemotron agent to use later (for example a `get_critical_facilities` tool).

### Phase 2 files and acceptance

- New `lib/critical.js` (category tags, weights, nearest-substation attribution, scoring: pure and unit-tested) and `components/CriticalLayer.jsx` (markers, toggles, halos). The snapshot gains the facilities for the College Station area.
- Acceptance: all 8 categories load in College Station (for example Texas A&M and local hospitals), the toggles work, every facility is attributed to at most one substation, scores match the weights, and the impact line appears after Diagnose.

## Non-goals

- Nemotron itself (only its status slot).
- Real FPGA hardware runs (the `hardware` detector is still a stub).
- Using OpenInfraMap's own servers or website: the same OpenStreetMap data, fetched ourselves.
- Photorealistic or downloaded 3D models; sharing station assignments between computers.

## Decisions

| Topic | Decision |
|---|---|
| Default location | College Station, TX (30.628, −96.334), zoom 10 |
| Map / snapshot area | Wider Brazos Valley (~100 × 100 km) |
| Map coverage | United States only (contiguous 48 states) |
| Demo check badge | Shown after Diagnose (FPGA result vs injected settings) |
| Frontend restructure | Approved: existing `frontend/` files may be reorganised |
| Base map | OpenFreeMap minimal dark style, no API key |
| Transmission lines | Shown (≥ 69 kV, coloured by voltage), with an on/off toggle, on by default |
| 3D view | One station at a time, with tabs |
| Station assignment | User clicks each of the four on the map; **substations only** (power plants are display-only) |
| Substation filter | Transmission substations only (`substation=transmission` or ≥ 69 kV); local distribution substations hidden |
| Phase | User-settable per station (`phase_deg`) |
| Status | `GET /api/status` + `status` WebSocket messages |
| 3D preview | "View in 3D" from any substation's popup, before assigning (Preview tab) |
| Critical facilities | **Phase 2:** all 8 categories, major oil & gas only, nearest-substation scoring, impact line in the verdict |
