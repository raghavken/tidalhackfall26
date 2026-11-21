'use client';

// Station controls as a compact table: per-station severity and phase, with
// live readings. Edits are a draft until Inject; Diagnose is disabled while a
// draft is pending so it always diagnoses what is actually streaming.

import { SEVERITY_ORDER, STATION_COLORS, STATION_LABEL, STATION_NAMES } from '../lib/stations';

const round2 = value => Math.round(Number(value) * 100) / 100;

export default function StationControls({ config, state, latest, assignments, draft, setDraft,
  busy, onInject, onClear, onDiagnose, disabled, diagnosing }) {
  if (!config || !state) return <p className="muted pad">Waiting for the simulator…</p>;
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

  return <div className="controls">
    <div className="table-wrap">
      <table className="data-table controls-table">
        <thead><tr>
          <th scope="col">Stn</th><th scope="col">Substation</th>
          <th scope="col" className="num">f (Hz)</th><th scope="col" className="num">Δf (mHz)</th>
          <th scope="col">Injected oscillation</th><th scope="col">Phase (°)</th>
        </tr></thead>
        <tbody>{STATION_NAMES.map((name, sid) => {
          const sub = assignments[name];
          const freq = latest?.frequency_hz?.[sid];
          const dev = latest?.deviation_mhz?.[sid];
          return <tr key={name}>
            <th scope="row"><span className="stn-tag" style={{ '--stn': STATION_COLORS[name] }}>{STATION_LABEL[name]}</span></th>
            <td className="sub-cell" title={sub ? `${sub.name}${sub.operator ? ' · ' + sub.operator : ''}` : undefined}>
              {sub ? <>{sub.name}{sub.maxKv ? <span className="muted"> · {sub.maxKv} kV</span> : null}</>
                : <span className="muted">unassigned</span>}</td>
            <td className="num mono">{freq != null ? freq.toFixed(4) : '—'}</td>
            <td className="num mono">{dev != null ? `${dev > 0 ? '+' : ''}${dev}` : '—'}</td>
            <td><select aria-label={`Station ${STATION_LABEL[name]} severity`} disabled={disabled}
              value={values.severities[name]} onChange={e => edit('severities', name, e.target.value)}>
              {SEVERITY_ORDER.map(level => <option key={level} value={level}>
                {level === 'normal' ? 'none' : level} · {config.severities[level].amplitude_mhz} mHz</option>)}
            </select></td>
            <td><input aria-label={`Station ${STATION_LABEL[name]} phase in degrees`} disabled={disabled}
              className="mono phase-input" type="number" min="-360" max="360" step="any" inputMode="decimal"
              value={values.phase_deg[name]} onChange={e => edit('phase_deg', name, e.target.value)} /></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="actions">
      <button className="btn-primary" disabled={disabled || !draft || phaseInvalid} onClick={onInject}>
        Inject disturbance</button>
      <button disabled={disabled} onClick={onClear}>Clear</button>
      <button disabled={disabled || Boolean(draft) || diagnosing} onClick={onDiagnose}
        title={draft ? 'Inject your edits first' : undefined}>Run diagnosis</button>
      <span className="muted small">{affected} of 4 stations affected{draft ? ' · edits not injected' : ''}</span>
      {busy && <span className="muted small" role="status">{busy}…</span>}
    </div>
    {phaseInvalid && <p className="msg-warn">Phase must be a number between −360 and 360.</p>}
  </div>;
}
