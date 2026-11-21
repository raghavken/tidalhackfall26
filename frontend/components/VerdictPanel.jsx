'use client';

// What the FPGA concluded after Diagnose: summary, energy vs severity bands,
// phase relationships, the 20 s window that was analysed, a demo check, and
// the optional Nemotron explanation.

import Waveform from './Waveform';
import { STATION_COLORS } from '../lib/stations';

const LOG_MIN = 2;   // 10^2
const LOG_MAX = 9;   // 10^9
const EDGES = [{ value: 2_250_000, label: 'mild' }, { value: 9_000_000, label: 'moderate' },
  { value: 36_000_000, label: 'severe' }];

const pct = energy => {
  const v = Math.log10(Math.max(energy, 10 ** LOG_MIN));
  return Math.min(100, Math.max(0, (v - LOG_MIN) / (LOG_MAX - LOG_MIN) * 100));
};

function summary(diagnosis) {
  const { analysis, fpga_results: results } = diagnosis;
  const sev = Object.fromEntries(results.map(r => [r.station, r.severity]));
  const list = analysis.affected_stations.map(s => `${s} (${sev[s]})`).join(', ');
  if (analysis.classification === 'none') return 'No 0.25 Hz oscillation detected at any station.';
  if (analysis.classification === 'single_station') return `Single-station oscillation at ${list}.`;
  const pairs = analysis.phase_relationships
    .map(p => `${p.stations.join('–')} ${p.relationship.replace('_', ' ')}`).join('; ');
  return `Multi-station oscillation: ${list}${pairs ? `; ${pairs}` : ''}.`;
}

function EnergyBars({ results }) {
  return <div className="energy">
    <div className="energy-scale" aria-hidden="true">
      {EDGES.map(e => <span key={e.label} className="edge" style={{ left: `${pct(e.value)}%` }}>
        <em>{e.label}</em></span>)}
    </div>
    {results.map(r => <div key={r.station} className="energy-row">
      <span className="energy-name" style={{ color: STATION_COLORS[r.station] }}>{r.station}</span>
      <div className="energy-track">
        {EDGES.map(e => <span key={e.label} className="edge-line" style={{ left: `${pct(e.value)}%` }} />)}
        <div className="energy-bar" style={{ width: `${pct(r.energy)}%`, background: STATION_COLORS[r.station] }} />
      </div>
      <span className="energy-value">{r.energy.toLocaleString()} · <b>{r.severity}</b>
        {r.alarm ? ' · alarm' : ''}</span>
    </div>)}
    <p className="muted small">FPGA energy I² + Q², log scale. Alarm threshold 2,250,000 (≈ 5 mHz).</p>
  </div>;
}

function NemotronBox({ diagnosis, explanation, nemotron, onExplain, busy, disabled }) {
  const thinking = nemotron?.state === 'thinking' || busy;
  const notConfigured = nemotron?.state === 'not_configured';
  return <div className="nemotron">
    <div className="actions">
      <button onClick={() => onExplain(diagnosis.diagnosis_id)} disabled={disabled || thinking || notConfigured}
        title={notConfigured ? 'Set NEMOTRON_BASE_URL and NEMOTRON_MODEL in the backend .env' : undefined}>
        Explain with Nemotron</button>
      {thinking && <span role="status"><span className="spinner inline" aria-hidden="true" /> Nemotron is analysing this diagnosis…</span>}
      {notConfigured && <span className="muted small">Nemotron not configured on the backend.</span>}
    </div>
    {explanation && <div className="nemotron-answer" aria-live="polite">
      <h3>Nemotron analysis <span className="muted small">· {explanation.model}</span></h3>
      <p>{explanation.analysis}</p>
    </div>}
  </div>;
}

export default function VerdictPanel({ diagnosis, window: windowSamples, diagnosing, assignments,
  explanation, nemotron, onExplain, explainBusy, disabled }) {
  if (diagnosing) {
    return <div className="verdict-wait" role="status"><span className="spinner" aria-hidden="true" />
      Sending 2,400 measurements to the detector…</div>;
  }
  if (!diagnosis) {
    return <p className="muted">Inject a disturbance, then press <b>Diagnose</b> to send the last
      20 seconds to the FPGA detector.</p>;
  }
  const detector = diagnosis.detector === 'hardware' ? 'DE1 FPGA' : 'Python reference (FPGA model)';
  const alarmed = diagnosis.fpga_results.filter(r => r.alarm);
  return <div className="verdict">
    <p className="verdict-summary">{summary(diagnosis)}</p>
    <p className="muted small">
      Diagnosis #{diagnosis.diagnosis_id} · {detector} · {diagnosis.window.packets.toLocaleString()} measurements
      {diagnosis.run_ms != null ? ` · ${diagnosis.run_ms} ms` : ''}
      {' · '}<span className={`demo-check ${diagnosis.matches_request ? 'ok' : 'bad'}`}
        title="Demo check: does the FPGA result match the injected settings?">
        demo check {diagnosis.matches_request ? '✓' : '✗'}</span>
    </p>
    {alarmed.length > 0 && <ul className="where">{alarmed.map(r => <li key={r.station}>
      <b style={{ color: STATION_COLORS[r.station] }}>{r.station}</b>
      {' — '}{assignments[r.station]?.name || 'unassigned substation'}: {r.severity} oscillation
      (≈ {diagnosis.analysis.amplitude_mhz[r.station]} mHz)</li>)}</ul>}
    <EnergyBars results={diagnosis.fpga_results} />
    {diagnosis.analysis.phase_relationships.length > 0 && <>
      <h3>Phase relationships</h3>
      <ul>{diagnosis.analysis.phase_relationships.map(p => <li key={p.stations.join('-')}>
        {p.stations.join(' and ')}: <b>{p.relationship.replace('_', ' ')}</b>
        {' '}({Math.round(p.phase_difference_rad * 180 / Math.PI)}°)</li>)}</ul>
    </>}
    {windowSamples && <>
      <h3>The 20 s window that was diagnosed</h3>
      <Waveform samples={windowSamples} height={170} label="The 600-sample window sent to the FPGA detector" />
    </>}
    <NemotronBox diagnosis={diagnosis} explanation={explanation} nemotron={nemotron}
      onExplain={onExplain} busy={explainBusy} disabled={disabled} />
  </div>;
}
