'use client';

// One WebSocket + REST connection to the live simulator (FastAPI on :8000,
// reached through the Next.js rewrites in next.config.mjs).

import { useCallback, useEffect, useRef, useState } from 'react';

export const WAVEFORM_SAMPLES = 600; // 20 s at 30 Hz

async function api(path, options) {
  const response = await fetch('/api/' + path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = Array.isArray(data.detail) ? data.detail.map(d => d.msg).join('; ') : data.detail;
    throw new Error(typeof detail === 'string' && detail ? detail : `Request failed (${response.status})`);
  }
  return response.json();
}

export function useSimulator() {
  const [connection, setConnection] = useState('connecting'); // connecting | live | reconnecting
  const [config, setConfig] = useState(null);
  const [state, setState] = useState(null);
  const [status, setStatus] = useState(null);
  const [samples, setSamples] = useState([]);
  const [diagnosis, setDiagnosis] = useState(null);
  const [diagnosisWindow, setDiagnosisWindow] = useState(null);
  const [explanations, setExplanations] = useState({}); // diagnosis_id -> {model, analysis}
  const latest = useRef(null); // latest sample, read every frame by the 3D scene

  useEffect(() => {
    let socket;
    let retry;
    let disposed = false;
    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${scheme}//${location.host}/ws/stream`);
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        switch (message.type) {
          case 'hello':
            setConfig(message.config);
            setState(message.state);
            setStatus(message.status ?? null);
            setSamples(message.history.slice(-WAVEFORM_SAMPLES));
            latest.current = message.history.at(-1) ?? null;
            setConnection('live');
            // Restore the latest diagnosis after a reload (existing GET /api/diagnoses)
            fetch('/api/diagnoses').then(r => (r.ok ? r.json() : [])).then(list => {
              if (list.length) setDiagnosis(current => current ?? list[list.length - 1]);
            }).catch(() => {});
            break;
          case 'samples':
            latest.current = message.samples.at(-1);
            setSamples(previous => [...previous, ...message.samples].slice(-WAVEFORM_SAMPLES));
            break;
          case 'state':
            setState(message.state);
            break;
          case 'reset':
            setState(message.state);
            setSamples([]);
            break;
          case 'status':
            setStatus(message.status);
            break;
          case 'diagnosis':
            setDiagnosis(message.diagnosis);
            setDiagnosisWindow(message.window);
            break;
          case 'explanation':
            setExplanations(previous => ({ ...previous, [message.explanation.diagnosis_id]: message.explanation }));
            break;
          default:
            break;
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnection('reconnecting');
        retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, []);

  const inject = useCallback(async (severities, phaseDeg) => {
    const updated = await api('anomaly', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...severities, phase_deg: phaseDeg }) });
    setState(updated);
    return updated;
  }, []);

  const clear = useCallback(async () => {
    const updated = await api('anomaly', { method: 'DELETE' });
    setState(updated);
    return updated;
  }, []);

  const diagnose = useCallback(async () => {
    const result = await api('diagnose', { method: 'POST' });
    setDiagnosis(result); // the WebSocket message also delivers it, with the window
    return result;
  }, []);

  // `context` (optional): extra evidence such as nearby critical facilities (Phase 2)
  const explain = useCallback(async (diagnosisId, context = null) => {
    const result = await api(`diagnoses/${diagnosisId}/explain`, context
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context }) }
      : { method: 'POST' });
    setExplanations(previous => ({ ...previous, [result.diagnosis_id]: result }));
    return result;
  }, []);

  return { connection, config, state, status, samples, latest, diagnosis, diagnosisWindow,
    explanations, inject, clear, diagnose, explain };
}
