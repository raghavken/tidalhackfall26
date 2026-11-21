'use client';

// Discreet status bar fixed to the bottom of the screen: telemetry stream,
// detector and Nemotron state, and the map data source. Small muted text;
// colour (amber/red) only appears for warnings and faults.

function Item({ label, value, tone, title }) {
  return <span className={`status-item${tone ? ` tone-${tone}` : ''}`} title={title}>
    {tone && <span className="status-dot" aria-hidden="true" />}
    <span className="status-label">{label}</span>
    <span className="status-value">{value}</span>
  </span>;
}

export default function StatusFooter({ connection, state, status, config, mapSource }) {
  const stream = connection !== 'live'
    ? { value: connection === 'connecting' ? 'connecting' : 'reconnecting', tone: 'warn' }
    : state && !state.running ? { value: 'paused', tone: 'warn' }
      : { value: `simulated · ${config?.sample_rate_hz ?? 30} Hz · live` };

  const fpga = status?.fpga;
  const detector = fpga?.detector === 'hardware' ? 'DE1 FPGA (JTAG)' : 'Python reference (bit-exact FPGA model)';
  let det = { value: 'unknown' };
  if (fpga) {
    if (!fpga.available) det = { value: `${detector} · not configured`, tone: 'warn' };
    else if (fpga.state === 'diagnosing') det = { value: `${detector} · running` };
    else if (fpga.state === 'error') det = { value: `${detector} · error`, tone: 'fault' };
    else det = { value: `${detector} · idle${fpga.last_run_ms != null ? ` · last ${fpga.last_run_ms} ms` : ''}` };
  }

  const nemo = status?.nemotron;
  const nemoItem = {
    ready: { value: `ready · ${nemo?.model ?? ''}` },
    thinking: { value: 'analysing' },
    error: { value: 'error', tone: 'fault' },
    not_configured: { value: 'not configured' },
  }[nemo?.state] || { value: 'unknown' };

  return <footer className="status-footer" role="status" aria-live="polite">
    <Item label="Telemetry" {...stream} />
    <Item label="Detector" {...det} title={fpga?.last_error || undefined} />
    <Item label="Nemotron" {...nemoItem} title={nemo?.last_error ||
      (nemo?.state === 'not_configured' ? 'Set NEMOTRON_BASE_URL and NEMOTRON_MODEL in the backend .env' : undefined)} />
    {mapSource && <Item label="Topology" value={mapSource} />}
  </footer>;
}
