'use client';

// Canvas line chart of frequency deviation (mHz) for all four stations.
import { useEffect, useRef } from 'react';
import { STATION_COLORS, STATION_NAMES } from '../lib/stations';

export default function Waveform({ samples, height = 270, label }) {
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
      const bound = Math.max(10, ...samples.flatMap(s => s.deviation_mhz.map(Math.abs)));
      const left = 48;
      const top = 12;
      const plotHeight = h - 28;
      ctx.font = '12px system-ui';
      for (const fraction of [-1, -0.5, 0, 0.5, 1]) {
        const y = top + (1 - fraction) * plotHeight / 2;
        ctx.strokeStyle = fraction === 0 ? '#506785' : '#1e3046';
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(width - 8, y);
        ctx.stroke();
        ctx.fillStyle = '#aebfd5';
        ctx.fillText(String(Math.round(fraction * bound)), 4, y + 4);
      }
      STATION_NAMES.forEach((name, sid) => {
        ctx.strokeStyle = STATION_COLORS[name];
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        samples.forEach((sample, i) => {
          const x = left + (width - left - 8) * i / Math.max(1, samples.length - 1);
          const y = top + (1 - sample.deviation_mhz[sid] / bound) * plotHeight / 2;
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
  }, [samples]);
  return <div className="waveform">
    <canvas ref={canvas} style={{ height }} role="img"
      aria-label={label || 'Frequency deviation in millihertz for all four stations'} />
    <ul className="legend">{STATION_NAMES.map(name =>
      <li key={name}><span className="swatch" style={{ background: STATION_COLORS[name] }} />{name}</li>)}
    </ul>
  </div>;
}
