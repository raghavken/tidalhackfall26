'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import StatusFooter from '../components/StatusFooter';
import Waveform from '../components/Waveform';
import StationControls from '../components/StationControls';
import VerdictPanel from '../components/VerdictPanel';
import { useSimulator } from '../lib/useSimulator';
import { assign, loadAssignments, loadPrefs, savePrefs } from '../lib/assignments.mjs';
import { CATEGORY_BY_ID, DEFAULT_CATEGORIES, criticality, describeImpact } from '../lib/critical.mjs';
import { formatEnergy } from '../lib/energy.mjs';
import { STATION_COLORS, STATION_LABEL, STATION_NAMES, stationTitle } from '../lib/stations';

// WebGL components only run in the browser
const GridMap = dynamic(() => import('../components/GridMap'), { ssr: false,
  loading: () => <div className="map-wrap placeholder">Loading map…</div> });
const SubstationScene = dynamic(() => import('../components/SubstationScene'), { ssr: false,
  loading: () => <div className="scene-wrap placeholder">Loading 3D…</div> });

const storage = () => (typeof window === 'undefined' ? null : window.localStorage);

export default function Page() {
  const sim = useSimulator();
  const { connection, config, state, status, samples, latest, diagnosis, diagnosisWindow, explanations } = sim;

  const [assignments, setAssignments] = useState(() => Object.fromEntries(STATION_NAMES.map(n => [n, null])));
  const [showLines, setShowLines] = useState(true);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [infra, setInfra] = useState(null);
  const [infraLoading, setInfraLoading] = useState(false);
  const [infraNotice, setInfraNotice] = useState('');
  const [regions, setRegions] = useState([]);
  const [focus, setFocus] = useState(null);
  const jumpToRegionRef = useRef(null);
  const [tab, setTab] = useState('North');
  const [preview, setPreview] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  // Restore browser-saved assignments and map prefs after mount
  useEffect(() => {
    setAssignments(loadAssignments(storage()));
    const prefs = loadPrefs(storage());
    setShowLines(prefs.showLines);
    setCategories(prefs.categories);
  }, []);

  // Load map data for a view. Areas outside the pre-downloaded regions answer
  // instantly with "not pre-loaded"; `live` opts into a slow live query.
  const [retryBbox, setRetryBbox] = useState(null);
  const loadInfra = useCallback(async (bbox, live = false) => {
    setInfraLoading(true);
    setRetryBbox(null);
    if (live) setInfraNotice('Loading live OpenStreetMap data… this can take up to a minute.');
    try {
      const query = bbox ? `?bbox=${bbox.map(v => v.toFixed(4)).join(',')}${live ? '&live=1' : ''}` : '';
      const response = await fetch('/infra' + query);
      const body = await response.json();
      if (!response.ok) {
        if (body.code === 'not_preloaded') setRetryBbox(bbox);
        throw new Error(body.error || `Map data failed (${response.status})`);
      }
      setInfra(body);
      setInfraNotice(body.warning || '');
    } catch (failure) {
      setInfraNotice(failure.message);
    } finally {
      setInfraLoading(false);
    }
  }, []);
  useEffect(() => {
    // Open at a pre-loaded region from the URL (e.g. /?region=houston), handy for demo links
    const region = new URLSearchParams(window.location.search).get('region');
    if (region) jumpToRegionRef.current(region);
    else loadInfra(null);
  }, [loadInfra]);

  // Pre-downloaded regions for the "Jump to region" menu
  useEffect(() => {
    fetch('/infra?regions=1').then(r => r.json()).then(list => setRegions(list.filter(r => r.available)))
      .catch(() => {});
  }, []);
  const jumpToRegion = async id => {
    if (!id) return;
    setInfraLoading(true);
    try {
      const response = await fetch(`/infra?region=${encodeURIComponent(id)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Map data failed (${response.status})`);
      setInfra(body);
      setInfraNotice('');
      setRetryBbox(null);
      setFocus({ bbox: body.bbox, key: Date.now() });
    } catch (failure) {
      setInfraNotice(failure.message);
    } finally {
      setInfraLoading(false);
    }
  };
  jumpToRegionRef.current = jumpToRegion;
  const regionGroups = [...new Set(regions.map(r => r.group))];

  const toggleLines = value => { setShowLines(value); savePrefs(storage(), { showLines: value, categories }); };
  const toggleCategory = (id, on) => {
    const next = on ? [...new Set([...categories, id])] : categories.filter(c => c !== id);
    setCategories(next);
    savePrefs(storage(), { showLines, categories: next });
  };

  // Phase 2: criticality of each substation in the loaded region (nearest-substation estimate)
  const critical = useMemo(() => {
    const c = criticality(infra);
    const subName = new Map((infra?.substations?.features ?? []).map(f => [f.properties.id, f.properties.name]));
    return { ...c,
      describe: id => describeImpact(c.bySubstation.get(id)),
      nearestName: facilityId => c.nearestOf.get(facilityId) ?? null,
      inRegion: id => subName.has(id) };
  }, [infra]);
  // Impact for each assigned station: {substation, entry, text} or null when unknown
  const impacts = useMemo(() => Object.fromEntries(STATION_NAMES.map(name => {
    const sub = assignments[name];
    if (!sub) return [name, null];
    if (!infra?.facilitiesAvailable || !critical.inRegion(sub.id)) return [name, { substation: sub, unknown: true }];
    const entry = critical.bySubstation.get(sub.id) ?? { score: 0, counts: {}, facilities: [] };
    return [name, { substation: sub, entry, text: describeImpact(entry) }];
  })), [assignments, critical, infra]);
  // Evidence for Nemotron: alarmed stations' nearby critical facilities
  const explainContext = () => {
    const stations = {};
    for (const row of diagnosis?.fpga_results ?? []) {
      const impact = impacts[row.station];
      if (!row.alarm || !impact || impact.unknown) continue;
      stations[row.station] = {
        substation: impact.substation.name, voltage_kv: impact.substation.voltagesKv,
        criticality_score: impact.entry.score,
        nearest_substation_for: impact.entry.facilities.slice(0, 15).map(f => ({
          category: CATEGORY_BY_ID[f.category]?.label, name: f.name, distance_km: f.distanceKm })),
      };
    }
    return Object.keys(stations).length ? { critical_facilities: { stations,
      note: 'Proximity estimate from OpenStreetMap: each facility is attributed to its nearest transmission ' +
        'substation within 10 km. Not actual utility service areas.' } } : null;
  };
  const onAssign = useCallback((station, summary) => {
    setAssignments(current => assign(storage(), current, station, summary));
    setTab(station);
    setPreview(p => (p?.id === summary.id ? null : p));
  }, []);
  const onPreview = useCallback(summary => { setPreview(summary); setTab('Preview'); }, []);

  const control = async (label, operation) => {
    setBusy(label);
    setError('');
    try { await operation(); } catch (failure) { setError(failure.message); } finally { setBusy(''); }
  };
  const onInject = () => control('Injecting', async () => {
    const phase = Object.fromEntries(Object.entries(draft.phase_deg).map(([k, v]) => [k, Number(v)]));
    await sim.inject(draft.severities, phase);
    setDraft(null);
  });
  const onClear = () => control('Clearing', async () => { await sim.clear(); setDraft(null); });
  const onDiagnose = () => control('Diagnosing', () => sim.diagnose());
  const onExplain = id => control('Asking Nemotron', () => sim.explain(id, explainContext()));

  const diagnosing = status?.fpga?.state === 'diagnosing' || busy === 'Diagnosing';
  const verdictFor = name => {
    const row = diagnosis?.fpga_results?.find(r => r.station === name);
    return row ? (row.alarm ? 'alarm' : 'clear') : null;
  };

  // 3D target: a station tab or the preview
  const sceneTarget = useMemo(() => {
    if (tab === 'Preview' && preview) return { key: 'preview:' + preview.id, kind: 'preview', substation: preview };
    const sub = assignments[tab] || null;
    return { key: `${tab}:${sub?.id ?? 'generic'}`, kind: 'station',
      stationIndex: STATION_NAMES.indexOf(tab), substation: sub };
  }, [tab, preview, assignments]);
  const sceneSeverity = sceneTarget.kind === 'station' ? state?.severities?.[tab] || 'normal' : 'preview';
  const sceneAmplitude = config && sceneTarget.kind === 'station'
    ? config.severities[sceneSeverity]?.amplitude_mhz ?? 0 : 0;
  const sceneRow = diagnosis?.fpga_results?.find(r => r.station === tab);

  const latestSample = samples.at(-1);
  const sceneSid = sceneTarget.kind === 'station' ? sceneTarget.stationIndex : -1;
  const liveDev = sceneSid >= 0 ? latestSample?.deviation_mhz?.[sceneSid] : null;
  const liveFreq = sceneSid >= 0 ? latestSample?.frequency_hz?.[sceneSid] : null;
  const fetched = infra?.fetchedAt ? infra.fetchedAt.slice(0, 10) : null;
  const mapSource = infra
    ? (infra.region ? `cached OpenStreetMap · ${infra.region.name}${fetched ? ` · ${fetched}` : ''}`
      : `${infra.source}${fetched ? ` · ${fetched}` : ''}`)
    : null;

  return <>
    <header className="app-header">
      <div className="brand"><h1>GridSent</h1><span className="tagline">Power grid oscillation analysis</span></div>
      <div className="header-meta mono">Simulated PMU telemetry · 4 stations · 30 Hz · 0.25 Hz detector bin</div>
    </header>

    <main className="app-main">
      <div className="row-primary">
        <section className="panel panel-map" aria-labelledby="map-title">
          <header className="panel-head">
            <h2 id="map-title">Grid topology</h2>
            <div className="panel-tools">
              {regions.length > 0 && <label className="inline-field"><span>Region</span>
                <select value={infra?.region?.id || ''} disabled={infraLoading}
                  onChange={e => jumpToRegion(e.target.value)}>
                  {!infra?.region && <option value="">Current view</option>}
                  {regionGroups.map(group => <optgroup key={group} label={group}>
                    {regions.filter(r => r.group === group).map(r =>
                      <option key={r.id} value={r.id}>{r.name}</option>)}
                  </optgroup>)}
                </select></label>}
              <span className="panel-meta mono">{infra
                ? `${infra.substations.features.length} subs · ${infra.plants.features.length} plants` : 'loading'}</span>
            </div>
          </header>
          <div className="panel-body flush">
            <GridMap data={infra} assignments={assignments} severities={state?.severities} diagnosis={diagnosis}
              showLines={showLines} onToggleLines={toggleLines} onAssign={onAssign} onPreview={onPreview}
              onSelectStation={setTab} onLoadInView={loadInfra} loading={infraLoading} notice={infraNotice}
              focus={focus} critical={critical} categories={categories} onToggleCategory={toggleCategory} />
          </div>
          <footer className="panel-foot">
            <span>{mapSource ? `Topology: ${mapSource}` : 'Topology: loading'}</span>
            {retryBbox && <button className="link-btn" onClick={() => loadInfra(retryBbox, true)}
              disabled={infraLoading}>Try live load (slow)</button>}
            <span className="muted">Click a substation to inspect or assign it.</span>
          </footer>
        </section>

        <section className="panel panel-scene" aria-labelledby="scene-title">
          <header className="panel-head">
            <h2 id="scene-title">Substation</h2>
            <div className="segmented" role="tablist" aria-label="Station">
              {STATION_NAMES.map(name => <button key={name} role="tab" aria-selected={tab === name}
                className={tab === name ? 'active' : ''} style={{ '--stn': STATION_COLORS[name] }}
                title={stationTitle(name)} onClick={() => setTab(name)}>{STATION_LABEL[name]}</button>)}
              {preview && <button role="tab" aria-selected={tab === 'Preview'}
                className={tab === 'Preview' ? 'active' : ''} onClick={() => setTab('Preview')}>Preview</button>}
            </div>
          </header>
          <div className="panel-body flush">
            <SubstationScene target={sceneTarget} severity={sceneSeverity} amplitudeMhz={sceneAmplitude}
              verdict={sceneTarget.kind === 'station' ? verdictFor(tab) : null} latest={latest} />
          </div>
          <dl className="readout">
            <div><dt>{sceneTarget.kind === 'station' ? stationTitle(tab) : 'Preview'}</dt>
              <dd>{sceneTarget.substation?.name || <span className="muted">not assigned (generic model)</span>}</dd></div>
            <div><dt>Voltage</dt><dd className="mono">{sceneTarget.substation?.voltagesKv?.length
              ? sceneTarget.substation.voltagesKv.map(kv => `${kv} kV`).join(' / ') : '—'}</dd></div>
            {sceneTarget.kind === 'station' ? <>
              <div><dt>f</dt><dd className="mono">{liveFreq != null ? `${liveFreq.toFixed(4)} Hz` : '—'}</dd></div>
              <div><dt>Δf</dt><dd className="mono">{liveDev != null ? `${liveDev > 0 ? '+' : ''}${liveDev} mHz` : '—'}</dd></div>
              <div><dt>Injected</dt><dd className={sceneSeverity === 'severe' ? 'sev-fault'
                : sceneSeverity === 'normal' ? '' : 'sev-warn'}>{sceneSeverity === 'normal' ? 'none' : `${sceneSeverity} · ${sceneAmplitude} mHz`}</dd></div>
              <div><dt>Detector</dt><dd className={sceneRow?.alarm ? 'sev-fault mono' : 'mono'}>{sceneRow
                ? `${sceneRow.alarm ? 'alarm' : 'clear'} · ${formatEnergy(sceneRow.energy)}` : 'no diagnosis'}</dd></div>
            </> : <div className="readout-assign"><dt>Assign as</dt><dd>
              {STATION_NAMES.map(name => <button key={name} className="assign" style={{ '--stn': STATION_COLORS[name] }}
                title={`Assign as ${stationTitle(name)}`} onClick={() => onAssign(name, preview)}>{STATION_LABEL[name]}</button>)}
            </dd></div>}
          </dl>
        </section>
      </div>

      <section className="panel" aria-labelledby="chart-title">
        <header className="panel-head">
          <h2 id="chart-title">Frequency deviation</h2>
          <span className="panel-meta mono">Δf = f − 60.000 Hz · last 20 s · 30 samples/s · simulated</span>
        </header>
        <div className="panel-body"><Waveform samples={samples} /></div>
      </section>

      <div className="row-secondary">
        <section className="panel" aria-labelledby="controls-title">
          <header className="panel-head">
            <h2 id="controls-title">Disturbance injection</h2>
            <span className="panel-meta mono">0.25 Hz oscillation · per station</span>
          </header>
          <div className="panel-body">
            <StationControls config={config} state={state} latest={latestSample} assignments={assignments}
              draft={draft} setDraft={setDraft} busy={busy} onInject={onInject} onClear={onClear}
              onDiagnose={onDiagnose} disabled={connection !== 'live' || Boolean(busy)} diagnosing={diagnosing} />
            {error && <p role="alert" className="msg-fault">{error}</p>}
          </div>
        </section>

        <section className="panel" aria-labelledby="report-title">
          <header className="panel-head">
            <h2 id="report-title">Diagnostic report</h2>
            <span className="panel-meta mono">{diagnosis ? `diagnosis #${diagnosis.diagnosis_id}` : 'no diagnosis'}</span>
          </header>
          <div className="panel-body">
            <VerdictPanel diagnosis={diagnosis} window={diagnosisWindow} diagnosing={diagnosing}
              assignments={assignments} impacts={impacts} explanation={explanations[diagnosis?.diagnosis_id]}
              nemotron={status?.nemotron} onExplain={onExplain} explainBusy={busy === 'Asking Nemotron'}
              disabled={connection !== 'live' || Boolean(busy)} />
          </div>
        </section>
      </div>
    </main>

    <StatusFooter connection={connection} state={state} status={status} config={config} mapSource={mapSource} />
  </>;
}
