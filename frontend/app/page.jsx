'use client';

import { useEffect, useRef, useState } from 'react';

const colors = ['#63efce', '#83aaff', '#ff9d65', '#e59af8'];
const limit = 600;

function Waveform({ samples, stations }) {
  const canvas = useRef(null);
  useEffect(() => {
    const target = canvas.current;
    const draw = () => {
      const width = target.clientWidth;
      const height = target.clientHeight;
      const scale = window.devicePixelRatio || 1;
      target.width = width * scale;
      target.height = height * scale;
      const ctx = target.getContext('2d');
      ctx.scale(scale, scale);
      const bound = Math.max(10, ...samples.flatMap(s => s.deviation_mhz.map(Math.abs)));
      const left = 48;
      const top = 16;
      const plotHeight = height - 36;
      ctx.font = '12px system-ui';
      for (const fraction of [-1, -.5, 0, .5, 1]) {
        const y = top + (1 - fraction) * plotHeight / 2;
        ctx.strokeStyle = fraction === 0 ? '#506785' : '#23364c';
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(width - 8, y);
        ctx.stroke();
        ctx.fillStyle = '#aebfd5';
        ctx.fillText(Math.round(fraction * bound), 4, y + 4);
      }
      stations.forEach(({station_id}, series) => {
        ctx.strokeStyle = colors[series];
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        samples.forEach((sample, i) => {
          const x = left + (width - left - 8) * i / Math.max(1, samples.length - 1);
          const y = top + (1 - sample.deviation_mhz[station_id] / bound) * plotHeight / 2;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
    };
    draw();
    const resize = new ResizeObserver(draw);
    resize.observe(target);
    return () => resize.disconnect();
  }, [samples, stations]);
  return <canvas ref={canvas} aria-label="Live frequency deviation in millihertz for all stations" role="img" />;
}

async function api(path, options) {
  const response = await fetch('/api/' + path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : 'Request failed (' + response.status + ')');
  }
  return response.json();
}

export default function Page() {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState('Connecting');
  const [state, setState] = useState(null);
  const [samples, setSamples] = useState([]);
  const [draft, setDraft] = useState(null);
  const [diagnosis, setDiagnosis] = useState(null);
  const [explanations, setExplanations] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let socket, retry, disposed = false;
    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(scheme + '//' + location.host + '/ws/stream');
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'hello') {
          setConfig(message.config);
          setState(message.state);
          setSamples(message.history.slice(-limit));
          setStatus('Connected');
        } else if (message.type === 'samples') {
          setSamples(previous => [...previous, ...message.samples].slice(-limit));
        } else if (message.type === 'diagnosis') {
          setDiagnosis(message.diagnosis);
        } else if (message.type === 'state' || message.type === 'reset') {
          setState(message.state);
          if (message.type === 'reset') setSamples([]);
        }
      };
      socket.onclose = () => {
        if (!disposed) {
          setStatus('Reconnecting');
          retry = setTimeout(connect, 1500);
        }
      };
    };
    connect();
    return () => { disposed = true; clearTimeout(retry); socket.close(); };
  }, []);

  const edit = (field, name, value) => {
    setDraft(previous => {
      const current = previous || {severities: state.severities, phase_deg: state.phase_deg};
      return {...current, [field]: {...current[field], [name]: value}};
    });
  };
  const control = async (label, operation) => {
    setBusy(label);
    setError('');
    try { await operation(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  };
  const apply = () => control('Applying', async () => {
    const updated = await api('anomaly', {method:'PUT', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...draft.severities, phase_deg:draft.phase_deg})});
    setState(updated);
    setDraft(null);
  });

  const explain = () => control('Asking Nemotron', async () => {
    const result = await api('diagnoses/' + diagnosis.diagnosis_id + '/explain', {method:'POST'});
    setExplanations(previous => ({...previous, [result.diagnosis_id]: result}));
  });

  const stations = config?.stations || [];
  const latest = samples.at(-1);
  const explanation = explanations[diagnosis?.diagnosis_id];
  const values = draft || state;
  const disabled = status !== 'Connected' || Boolean(busy);
  return <main>
    <header><div><p className="label">LIVE PMU MONITOR</p><h1>Oscillation Cartographer</h1></div>
      <div className="connection" role="status">{status}{config && ' · ' + (config.detector === 'hardware' ? 'DE1 FPGA' : 'Python reference')}</div>
    </header>
    <section><div className="section-head"><h2>Frequency deviation</h2><span>mHz · latest 20 s</span></div>
      <Waveform samples={samples} stations={stations} />
    </section>
    <section><div className="section-head"><h2>Substation controls</h2><span>0.25 Hz oscillation</span></div>
      <div className="stations">{stations.map((station, index) => {
        const name = station.name;
        return <fieldset key={name} disabled={disabled}>
          <legend style={{color:colors[index]}}>{name}</legend>
          <strong>{latest ? latest.frequency_hz[station.station_id].toFixed(4) + ' Hz' : '—'}</strong>
          <label>Severity<select value={values.severities[name]} onChange={e => edit('severities', name, e.target.value)}>
            {Object.entries(config.severities).map(([level, band]) =>
              <option key={level} value={level}>{level} · {band.amplitude_mhz} mHz</option>)}
          </select></label>
          <label>Phase (°)<input type="number" min="-360" max="360" step="any"
            value={values.phase_deg[name]} onChange={e => edit('phase_deg', name, e.target.value)} /></label>
        </fieldset>;
      })}</div>
      <div className="actions">
        <button disabled={disabled || !draft || Object.values(draft.phase_deg).some(value => value === '' || Math.abs(Number(value)) > 360)} onClick={apply}>Apply settings</button>
        <button disabled={disabled || !state} onClick={() => control('Clearing', async () => {setState(await api('anomaly', {method:'DELETE'})); setDraft(null);})}>Clear anomalies</button>
        <button disabled={disabled || !state || Boolean(draft)} onClick={() => control('Diagnosing', async () => setDiagnosis(await api('diagnose', {method:'POST'})))}>Diagnose</button>
        {busy && <span role="status">{busy}…</span>}
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </section>
    {diagnosis && <section><div className="section-head"><h2>Diagnosis {diagnosis.diagnosis_id}</h2>
      <span>{diagnosis.detector === 'hardware' ? 'DE1 FPGA' : 'Python reference'} · {diagnosis.window.packets.toLocaleString()} measurements</span></div>
      <div className="table"><table><thead><tr><th>Station</th><th>Energy</th><th>Severity</th><th>Alarm</th></tr></thead>
        <tbody>{diagnosis.fpga_results.map(row => <tr key={row.station_id}><td>{row.station}</td><td>{row.energy.toLocaleString()}</td><td>{row.severity}</td><td>{row.alarm ? 'On' : 'Off'}</td></tr>)}</tbody></table></div>
      {diagnosis.analysis.phase_relationships.map(pair => <p key={pair.stations.join('-')}>{pair.stations.join(' and ')} · {pair.relationship.replace('_', ' ')} · {Math.round(pair.phase_difference_rad * 180 / Math.PI)}°</p>)}
      <div className="actions">
        <button disabled={disabled} onClick={explain}>Explain with Nemotron</button>
        {busy === 'Asking Nemotron' && <span role="status">Analyzing this diagnosis…</span>}
      </div>
      {explanation && <div aria-live="polite"><h3>Nemotron analysis</h3>
        <p style={{whiteSpace:'pre-wrap'}}>{explanation.analysis}</p>
      </div>}
    </section>}
  </main>;
}
