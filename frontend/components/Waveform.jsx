'use client';

// Frequency-deviation chart drawn like an instrument trace: thin lines, no
// fills, subtle grid, labelled axes with units. Δf = f − 60.000 Hz.
import { useEffect, useRef } from 'react';
import { STATION_COLORS, STATION_LABEL, STATION_NAMES } from '../lib/stations';

const GRID = '#1F1F23';
const AXIS = '#3F3F46';
const TICK_TEXT = '#8B8B95';
const MONO = '"JetBrains Mono", ui-monospace, "SFMono-Regular", Consolas, monospace';

function niceStep(range) {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
}

export default function Waveform({ samples, height = 220, label, showLegend = true }) {
  const canvas = useRef(null);
  useEffect(() => {
    const target = canvas.current;
    const draw = () => {
      const width = target.clientWidth;
      const h = target.clientHeight;
      const scale = window.devicePixelRatio || 1;
      target.width = width * scale;
      target.height = h * scale;
      const ctx = target.getContext('2d');
      ctx.scale(scale, scale);
      const left = 52;
      const right = 10;
      const top = 8;
      const bottom = 24;
      const plotW = width - left - right;
      const plotH = h - top - bottom;
      const peak = Math.max(5, ...samples.flatMap(s => s.deviation_mhz.map(Math.abs)));
      const step = niceStep(peak * 2);
      const bound = Math.ceil(peak / step) * step;
      const y = v => top + (1 - (v + bound) / (2 * bound)) * plotH;

      ctx.font = `11px ${MONO}`;
      ctx.lineWidth = 1;
      // horizontal grid + y ticks
      for (let v = -bound; v <= bound + 1e-9; v += step) {
        const yy = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = v === 0 ? AXIS : GRID;
        ctx.beginPath();
        ctx.moveTo(left, yy);
        ctx.lineTo(width - right, yy);
        ctx.stroke();
        ctx.fillStyle = TICK_TEXT;
        ctx.textAlign = 'right';
        ctx.fillText(`${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`, left - 6, yy + 4);
      }
      // time axis: seconds relative to the newest sample
      const n = samples.length;
      if (n > 1) {
        const t0 = samples[0].time_seconds;
        const t1 = samples[n - 1].time_seconds;
        const span = t1 - t0 || 1;
        ctx.textAlign = 'center';
        for (let s = 0; s <= span + 1e-9; s += 5) {
          const xx = Math.round(left + plotW * (1 - s / span)) + 0.5;
          ctx.strokeStyle = GRID;
          ctx.beginPath();
          ctx.moveTo(xx, top);
          ctx.lineTo(xx, top + plotH);
          ctx.stroke();
          ctx.fillStyle = TICK_TEXT;
          ctx.fillText(s === 0 ? '0 s' : `−${s} s`, xx, h - 8);
        }
      }
      ctx.save();
      ctx.translate(12, top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillStyle = TICK_TEXT;
      ctx.font = `11px "Inter Variable", Inter, system-ui, sans-serif`;
      ctx.fillText('Δf (mHz)', 0, 0);
      ctx.restore();

      // traces
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      STATION_NAMES.forEach((name, sid) => {
        ctx.strokeStyle = STATION_COLORS[name];
        ctx.beginPath();
        samples.forEach((sample, i) => {
          const xx = left + plotW * i / Math.max(1, n - 1);
          const yy = y(sample.deviation_mhz[sid]);
          if (i === 0) ctx.moveTo(xx, yy);
          else ctx.lineTo(xx, yy);
        });
        ctx.stroke();
      });
    };
    draw();
    const resize = new ResizeObserver(draw);
    resize.observe(target);
    return () => resize.disconnect();
  }, [samples]);

  const last = samples.at(-1);
  return <div className="waveform">
    <canvas ref={canvas} style={{ height }} role="img"
      aria-label={label || 'Frequency deviation in millihertz for stations 1 to 4'} />
    {showLegend && <ul className="trace-legend">{STATION_NAMES.map((name, sid) =>
      <li key={name}>
        <span className="trace-swatch" style={{ background: STATION_COLORS[name] }} />
        <span>{STATION_LABEL[name]}</span>
        {last && <span className="mono muted">{last.deviation_mhz[sid] > 0 ? '+' : ''}{last.deviation_mhz[sid]} mHz</span>}
      </li>)}
      <li className="muted">0 = 60.000 Hz nominal</li>
    </ul>}
  </div>;
}
