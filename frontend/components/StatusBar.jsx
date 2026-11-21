'use client';

// Header status pills: Stream, FPGA, Nemotron. Each pill = dot + text, so
// state is never shown by colour alone.

function Pill({ tone, label, value, title }) {
  return <span className={`pill pill-${tone}`} title={title}>
    <span className="dot" aria-hidden="true" />
    <span className="pill-label">{label}</span>
    <span>{value}</span>
  </span>;
}

export default function StatusBar({ connection, state, status }) {
  const stream = connection !== 'live'
    ? { tone: 'warn', value: connection === 'connecting' ? 'connecting…' : 'reconnecting…' }
    : state && !state.running ? { tone: 'warn', value: 'paused' } : { tone: 'good', value: 'live' };

  const fpga = status?.fpga;
  const detector = fpga?.detector === 'hardware' ? 'DE1 FPGA' : 'Python reference';
  let fpgaPill = { tone: 'off', value: 'unknown' };
  if (fpga) {
    if (!fpga.available) fpgaPill = { tone: 'off', value: `${detector} · not configured` };
    else if (fpga.state === 'diagnosing') fpgaPill = { tone: 'busy', value: `${detector} · diagnosing…` };
    else if (fpga.state === 'error') fpgaPill = { tone: 'bad', value: `${detector} · error` };
    else fpgaPill = { tone: 'good', value: `${detector} · idle` +
      (fpga.last_run_ms != null ? ` · last run ${fpga.last_run_ms} ms` : '') };
  }

  const nemo = status?.nemotron;
  const nemoPill = {
    ready: { tone: 'good', value: `ready${nemo?.model ? ' · ' + nemo.model : ''}` },
    thinking: { tone: 'busy', value: 'thinking…' },
    error: { tone: 'bad', value: 'error' },
    not_configured: { tone: 'off', value: 'not configured' },
  }[nemo?.state] || { tone: 'off', value: 'unknown' };

  return <div className="status-bar" role="status" aria-live="polite">
    <Pill label="Stream" {...stream} />
    <Pill label="FPGA" {...fpgaPill} title={fpga?.last_error || undefined} />
    <Pill label="Nemotron" {...nemoPill} title={nemo?.last_error ||
      (nemo?.state === 'not_configured' ? 'Set NEMOTRON_BASE_URL and NEMOTRON_MODEL in .env' : undefined)} />
  </div>;
}
