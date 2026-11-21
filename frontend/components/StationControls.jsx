'use client';

// Four station cards (severity + phase), Inject / Clear / Diagnose.
// Edits are a draft until Inject; Diagnose is disabled while a draft is pending
// so it always diagnoses what is actually streaming.

import { SEVERITY_ORDER, STATION_COLORS, STATION_NAMES } from '../lib/stations';

const round2 = value => Math.round(Number(value) * 100) / 100;

export default function StationControls({ config, state, latest, assignments, draft, setDraft,
  busy, onInject, onClear, onDiagnose, disabled, diagnosing }) {
  if (!config || !state) return <p className="muted">Waiting for the simulator…</p>;
  const current = { severities: state.severities,
    phase_deg: Object.fromEntries(STATION_NAMES.map(n => [n, round2(state.phase_deg?.[n] ?? 0)])) };
  const values = draft || current;
  const affected = STATION_NAMES.filter(n => values.severities[n] !== 'normal').length;
  const phaseInvalid = draft && Object.values(draft.phase_deg)
    .some(v => v === '' || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > 360);

  const edit = (field, name, value) => setDraft(previous => {
    const base = previous || current;
    return { ...base, [field]: { ...base[field], [name]: value } };
  });

  return <>
    <div className="stations">{STATION_NAMES.map((name, sid) => {
      const sub = assignments[name];
      const freq = latest?.frequency_hz?.[sid];
      return <fieldset key={name} disabled={disabled}>
        <legend style={{ color: STATION_COLORS[name] }}>{name}</legend>
        <p className="sub-name" title={sub?.operator || undefined}>
          {sub ? `${sub.name}${sub.maxKv ? ` · ${sub.maxKv} kV` : ''}` : 'unassigned'}
        </p>
        <strong className="freq">{freq != null ? `${freq.toFixed(4)} Hz` : '—'}</strong>
        <label>Severity
          <select value={values.severities[name]} onChange={e => edit('severities', name, e.target.value)}>
            {SEVERITY_ORDER.map(level => <option key={level} value={level}>
              {level} · {config.severities[level].amplitude_mhz} mHz</option>)}
          </select>
        </label>
        <label>Phase (°)
          <input type="number" min="-360" max="360" step="any" inputMode="decimal"
            value={values.phase_deg[name]} onChange={e => edit('phase_deg', name, e.target.value)} />
        </label>
      </fieldset>;
    })}</div>
    <div className="actions">
      <button className="primary" disabled={disabled || !draft || phaseInvalid} onClick={onInject}>
        Inject disturbance</button>
      <button disabled={disabled} onClick={onClear}>Clear anomalies</button>
      <button disabled={disabled || Boolean(draft) || diagnosing} onClick={onDiagnose}
        title={draft ? 'Inject your edits first' : undefined}>Diagnose</button>
      <span className="muted">{affected} of 4 stations affected{draft ? ' (not injected yet)' : ''}</span>
      {busy && <span role="status">{busy}…</span>}
    </div>
    {phaseInvalid && <p className="error">Phase must be a number between −360 and 360.</p>}
  </>;
}
