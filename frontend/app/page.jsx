'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import StatusBar from '../components/StatusBar';
import Waveform from '../components/Waveform';
import StationControls from '../components/StationControls';
import VerdictPanel from '../components/VerdictPanel';
import { useSimulator } from '../lib/useSimulator';
import { assign, loadAssignments, loadPrefs, savePrefs } from '../lib/assignments.mjs';
import { STATION_COLORS, STATION_LETTER, STATION_NAMES } from '../lib/stations';

// WebGL components only run in the browser
const GridMap = dynamic(() => import('../components/GridMap'), { ssr: false,
  loading: () => <div className="map-wrap placeholder">Loading map…</div> });
const SubstationScene = dynamic(() => import('../components/SubstationScene'), { ssr: false,
  loading: () => <div className="scene placeholder">Loading 3D…</div> });

const storage = () => (typeof window === 'undefined' ? null : window.localStorage);

export default function Page() {
  const sim = useSimulator();
  const { connection, config, state, status, samples, latest, diagnosis, diagnosisWindow, explanations } = sim;

  const [assignments, setAssignments] = useState(() => Object.fromEntries(STATION_NAMES.map(n => [n, null])));
  const [showLines, setShowLines] = useState(true);
  const [infra, setInfra] = useState(null);
  const [infraLoading, setInfraLoading] = useState(false);
  const [infraNotice, setInfraNotice] = useState('');
  const [tab, setTab] = useState('North');
  const [preview, setPreview] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  // Restore browser-saved assignments and map prefs after mount
  useEffect(() => {
    setAssignments(loadAssignments(storage()));
    setShowLines(loadPrefs(storage()).showLines);
  }, []);

  const loadInfra = useCallback(async bbox => {
    setInfraLoading(true);
    try {
      const query = bbox ? `?bbox=${bbox.map(v => v.toFixed(4)).join(',')}` : '';
      const response = await fetch('/infra' + query);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Map data failed (${response.status})`);
      setInfra(body);
      setInfraNotice(body.warning || '');
    } catch (failure) {
      setInfraNotice(failure.message);
    } finally {
      setInfraLoading(false);
    }
  }, []);
  useEffect(() => { loadInfra(null); }, [loadInfra]);

  const toggleLines = value => { setShowLines(value); savePrefs(storage(), { showLines: value }); };
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
  const onExplain = id => control('Asking Nemotron', () => sim.explain(id));

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

  return <main>
    <header>
      <div><p className="label">LIVE GRID MONITOR · BRAZOS VALLEY</p><h1>Oscillation Cartographer</h1></div>
      <StatusBar connection={connection} state={state} status={status} />
    </header>

    <div className="top-grid">
      <section className="panel-map">
        <div className="section-head"><h2>Grid map</h2>
          <span>{infra ? `${infra.substations.features.length} substations · ${infra.plants.features.length} plants · ${infra.source}` : 'loading…'}</span></div>
        <GridMap data={infra} assignments={assignments} severities={state?.severities} diagnosis={diagnosis}
          showLines={showLines} onToggleLines={toggleLines} onAssign={onAssign} onPreview={onPreview}
          onSelectStation={setTab} onLoadInView={loadInfra} loading={infraLoading} notice={infraNotice} />
        <p className="muted small">Click a substation to view it in 3D or assign it as North, East, South or West.</p>
      </section>

      <section className="panel-scene">
        <div className="tabs" role="tablist" aria-label="Substation 3D view">
          {STATION_NAMES.map(name => <button key={name} role="tab" aria-selected={tab === name}
            className={tab === name ? 'tab active' : 'tab'} style={{ '--station': STATION_COLORS[name] }}
            onClick={() => setTab(name)}>{name}</button>)}
          {preview && <button role="tab" aria-selected={tab === 'Preview'}
            className={tab === 'Preview' ? 'tab active' : 'tab'} onClick={() => setTab('Preview')}>Preview</button>}
        </div>
        <div className="scene-wrap">
          <SubstationScene target={sceneTarget} severity={sceneSeverity} amplitudeMhz={sceneAmplitude}
            verdict={sceneTarget.kind === 'station' ? verdictFor(tab) : null} latest={latest} />
          <div className="scene-label">
            <strong>{sceneTarget.substation?.name || `${tab} · not assigned yet`}</strong>
            <span>{sceneTarget.substation?.voltagesKv?.length
              ? sceneTarget.substation.voltagesKv.map(kv => `${kv} kV`).join(' / ') : 'generic model'}</span>
            {sceneTarget.kind === 'station'
              ? <span>Severity: <b className={`sev-text sev-${sceneSeverity}`}>{sceneSeverity}</b>
                {sceneRow && <> · FPGA: <b className={sceneRow.alarm ? 'bad' : 'good'}>
                  {sceneRow.alarm ? 'alarm' : 'clear'}</b> · {sceneRow.energy.toLocaleString()}</>}</span>
              : <span>Preview · not a station yet</span>}
          </div>
          {sceneTarget.kind === 'preview' && <div className="scene-assign">
            <span>Assign as</span>
            {STATION_NAMES.map(name => <button key={name} className="assign"
              style={{ borderColor: STATION_COLORS[name], color: STATION_COLORS[name] }}
              title={`Assign as ${name}`} onClick={() => onAssign(name, preview)}>{STATION_LETTER[name]}</button>)}
          </div>}
        </div>
        <p className="muted small">Drag to rotate · scroll to zoom. Glow follows live frequency deviation;
          the yard sways at 0.25 Hz when oscillating.</p>
      </section>
    </div>

    <section>
      <div className="section-head"><h2>Frequency deviation</h2><span>mHz · last 20 s · live</span></div>
      <Waveform samples={samples} />
    </section>

    <section>
      <div className="section-head"><h2>Station controls</h2><span>0.25 Hz oscillation per station</span></div>
      <StationControls config={config} state={state} latest={samples.at(-1)} assignments={assignments}
        draft={draft} setDraft={setDraft} busy={busy} onInject={onInject} onClear={onClear}
        onDiagnose={onDiagnose} disabled={connection !== 'live' || Boolean(busy)} diagnosing={diagnosing} />
      {error && <p role="alert" className="error">{error}</p>}
    </section>

    <section>
      <div className="section-head"><h2>FPGA verdict</h2>
        <span>{diagnosis ? `diagnosis #${diagnosis.diagnosis_id}` : 'no diagnosis yet'}</span></div>
      <VerdictPanel diagnosis={diagnosis} window={diagnosisWindow} diagnosing={diagnosing}
        assignments={assignments} explanation={explanations[diagnosis?.diagnosis_id]}
        nemotron={status?.nemotron} onExplain={onExplain} explainBusy={busy === 'Asking Nemotron'}
        disabled={connection !== 'live' || Boolean(busy)} />
    </section>
  </main>;
}
