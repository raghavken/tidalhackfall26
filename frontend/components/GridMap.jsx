'use client';

// Grid map: dark minimal base map + real transmission lines, substations and
// power plants (OpenStreetMap, United States only). Click a substation to
// preview it in 3D or assign it to a station. Assigned stations get N/E/S/W
// badges that pulse with severity and turn red/green after a Diagnose.

import { useEffect, useRef, useState } from 'react';
import { AttributionControl, Map as MapLibreMap, Marker, NavigationControl, Popup, setWorkerUrl } from 'maplibre-gl';
import { classifyLines } from '../lib/topology.mjs';
import { DEFAULT_CENTER, DEFAULT_ZOOM, US_MAX_BOUNDS } from '../lib/overpass.mjs';
import { VOLTAGE_BANDS, UNKNOWN_VOLTAGE_COLOR, voltageColorExpression, voltageWidthExpression }
  from '../lib/voltage.mjs';
import { summarizeSubstation } from '../lib/assignments.mjs';
import { STATION_COLORS, STATION_LETTER, STATION_NAMES } from '../lib/stations';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const FALLBACK_STYLE = { version: 8, sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1017' } }] };
const EMPTY = { type: 'FeatureCollection', features: [] };
const LINE_LAYERS = ['oc-lines', 'oc-lines-touch', 'oc-lines-connect'];

async function loadStyle() {
  try {
    const response = await fetch(STYLE_URL, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(String(response.status));
    return { style: await response.json(), fallback: false };
  } catch {
    return { style: FALLBACK_STYLE, fallback: true };
  }
}

function triangleImage(size = 26) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.moveTo(size / 2, 3);
  ctx.lineTo(size - 3, size - 4);
  ctx.lineTo(3, size - 4);
  ctx.closePath();
  ctx.fillStyle = '#ffd36b';
  ctx.strokeStyle = '#1a1206';
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

function describe(props) {
  const parts = [];
  if (props.voltagesKv?.length) parts.push(props.voltagesKv.map(kv => `${kv} kV`).join(' / '));
  else if (props.maxKv) parts.push(`${props.maxKv} kV`);
  if (props.operator) parts.push(props.operator);
  return parts.join(' · ');
}

// MapLibre stringifies nested properties in queried features; undo that.
function restoreProps(props) {
  const out = { ...props };
  for (const key of ['voltagesKv', 'outline']) {
    if (typeof out[key] === 'string') {
      try { out[key] = JSON.parse(out[key]); } catch { out[key] = null; }
    }
  }
  return out;
}

export default function GridMap({ data, assignments, severities, diagnosis, showLines,
  onToggleLines, onAssign, onPreview, onSelectStation, onLoadInView, loading, notice }) {
  const container = useRef(null);
  const mapRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [baseFallback, setBaseFallback] = useState(false);
  const markers = useRef({});
  const handlers = useRef({});
  handlers.current = { onAssign, onPreview, onSelectStation, assignments };

  // -- create the map once ----------------------------------------------------
  useEffect(() => {
    let map;
    let cancelled = false;
    (async () => {
      const { style, fallback } = await loadStyle();
      if (cancelled) return;
      setBaseFallback(fallback);
      setWorkerUrl('/map-worker/maplibre-gl-worker.mjs');
      map = new MapLibreMap({
        container: container.current,
        style,
        center: [DEFAULT_CENTER.lon, DEFAULT_CENTER.lat],
        zoom: DEFAULT_ZOOM,
        maxBounds: US_MAX_BOUNDS, // the map only covers the United States
        minZoom: 3,
        attributionControl: false,
      });
      mapRef.current = map;
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      map.addControl(new AttributionControl({ compact: true,
        customAttribution: 'Grid data © OpenStreetMap contributors' }), 'bottom-right');

      map.on('load', () => {
        map.addImage('oc-triangle', triangleImage(), { pixelRatio: 2 });
        for (const id of ['oc-lines-src', 'oc-outlines-src', 'oc-subs-src', 'oc-plants-src']) {
          map.addSource(id, { type: 'geojson', data: EMPTY });
        }
        map.addLayer({ id: 'oc-outlines', type: 'fill', source: 'oc-outlines-src', minzoom: 12,
          paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.07 } });
        map.addLayer({ id: 'oc-outlines-edge', type: 'line', source: 'oc-outlines-src', minzoom: 12,
          paint: { 'line-color': '#ffffff', 'line-opacity': 0.25, 'line-width': 1 } });
        map.addLayer({ id: 'oc-lines', type: 'line', source: 'oc-lines-src',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': voltageColorExpression(), 'line-width': voltageWidthExpression(),
            'line-opacity': 0.85 } });
        map.addLayer({ id: 'oc-lines-touch', type: 'line', source: 'oc-lines-src',
          filter: ['in', ['get', 'id'], ['literal', []]],
          paint: { 'line-color': '#ff5a5a', 'line-width': 3, 'line-opacity': 0.55, 'line-blur': 1 } });
        map.addLayer({ id: 'oc-lines-connect', type: 'line', source: 'oc-lines-src',
          filter: ['in', ['get', 'id'], ['literal', []]],
          paint: { 'line-color': '#ff3b3b', 'line-width': 5, 'line-opacity': 0.9, 'line-blur': 1.5 } });
        map.addLayer({ id: 'oc-plants', type: 'symbol', source: 'oc-plants-src',
          layout: { 'icon-image': 'oc-triangle', 'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 13, 1.1],
            'icon-allow-overlap': true } });
        map.addLayer({ id: 'oc-subs', type: 'circle', source: 'oc-subs-src',
          paint: { 'circle-color': '#f4f7fb',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 12, 5.5, 15, 8],
            'circle-stroke-color': '#0b1017', 'circle-stroke-width': 1.5 } });

        // Hover tooltips
        const tip = new Popup({ closeButton: false, closeOnClick: false, className: 'oc-tip', offset: 10 });
        for (const layer of ['oc-subs', 'oc-plants', 'oc-lines']) {
          map.on('mousemove', layer, e => {
            map.getCanvas().style.cursor = layer === 'oc-lines' ? '' : 'pointer';
            const p = restoreProps(e.features[0].properties);
            const title = layer === 'oc-lines' ? (p.name || 'Transmission line') : p.name;
            const detail = layer === 'oc-plants'
              ? [p.source, p.output, p.operator].filter(Boolean).join(' · ')
              : layer === 'oc-lines'
                ? [p.maxKv ? `${p.maxKv} kV` : 'voltage unknown', p.operator].filter(Boolean).join(' · ')
                : describe(p);
            const box = el('div');
            box.append(el('strong', null, title));
            if (detail) box.append(el('div', 'tip-detail', detail));
            tip.setLngLat(e.lngLat).setDOMContent(box).addTo(map);
          });
          map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; tip.remove(); });
        }

        // Click a substation: details + View in 3D + Assign as N/E/S/W
        map.on('click', 'oc-subs', e => {
          tip.remove();
          const feature = e.features[0];
          const summary = summarizeSubstation({ properties: restoreProps(feature.properties),
            geometry: feature.geometry });
          const { onAssign: assignCb, onPreview: previewCb, assignments: current } = handlers.current;
          const holder = STATION_NAMES.find(n => current[n]?.id === summary.id);
          const box = el('div', 'oc-popup');
          box.append(el('h3', null, summary.name));
          const info = describe(summary);
          if (info) box.append(el('p', 'muted', info));
          if (holder) box.append(el('p', 'assigned-as', `Assigned as ${holder}`));
          const popup = new Popup({ offset: 12, maxWidth: '280px' });
          const view = el('button', 'primary', 'View in 3D');
          view.onclick = () => { previewCb(summary); popup.remove(); };
          box.append(view);
          const row = el('div', 'assign-row');
          row.append(el('span', 'muted', 'Assign as'));
          for (const name of STATION_NAMES) {
            const b = el('button', 'assign', STATION_LETTER[name]);
            b.title = `Assign as ${name}`;
            b.style.borderColor = STATION_COLORS[name];
            b.style.color = STATION_COLORS[name];
            if (holder === name) b.disabled = true;
            b.onclick = () => { assignCb(name, summary); popup.remove(); };
            row.append(b);
          }
          box.append(row);
          popup.setLngLat(feature.geometry.coordinates).setDOMContent(box).addTo(map);
        });
        setReady(true);
      });
    })();
    return () => {
      cancelled = true;
      for (const m of Object.values(markers.current)) m.remove();
      markers.current = {};
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // -- data ---------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !data) return;
    map.getSource('oc-lines-src').setData(data.lines);
    map.getSource('oc-outlines-src').setData(data.outlines);
    map.getSource('oc-subs-src').setData(data.substations);
    map.getSource('oc-plants-src').setData(data.plants);
  }, [ready, data]);

  // -- power-lines toggle -------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const id of LINE_LAYERS) map.setLayoutProperty(id, 'visibility', showLines ? 'visible' : 'none');
  }, [ready, showLines]);

  // -- verdict: highlight lines at alarmed stations -----------------------------
  const alarms = {};
  for (const r of diagnosis?.fpga_results || []) alarms[r.station] = r.alarm;
  const alarmKey = JSON.stringify(alarms);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !data) return;
    const alarmed = STATION_NAMES.filter(n => alarms[n] && assignments[n]).map(n => assignments[n]);
    const { touching, connecting } = classifyLines(data.lines.features, alarmed);
    map.setFilter('oc-lines-touch', ['in', ['get', 'id'], ['literal', [...touching]]]);
    map.setFilter('oc-lines-connect', ['in', ['get', 'id'], ['literal', [...connecting]]]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, data, assignments, alarmKey]);

  // -- station badges -------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const name of STATION_NAMES) {
      const sub = assignments[name];
      let marker = markers.current[name];
      if (!sub) {
        marker?.remove();
        delete markers.current[name];
        continue;
      }
      if (!marker) {
        const node = el('button', 'station-marker');
        node.type = 'button';
        node.append(el('span', 'ring'), el('span', 'letter', STATION_LETTER[name]), el('span', 'verdict'));
        node.style.setProperty('--station', STATION_COLORS[name]);
        node.onclick = event => { event.stopPropagation(); handlers.current.onSelectStation(name); };
        marker = new Marker({ element: node }).setLngLat(sub.lngLat).addTo(map);
        markers.current[name] = marker;
      }
      marker.setLngLat(sub.lngLat);
      const node = marker.getElement();
      const severity = severities?.[name] || 'normal';
      const verdict = name in alarms ? (alarms[name] ? 'alarm' : 'clear') : 'none';
      node.className = `station-marker sev-${severity} verdict-${verdict}`;
      node.title = `${name}: ${sub.name} · ${severity}` +
        (verdict === 'none' ? '' : ` · FPGA ${verdict === 'alarm' ? 'alarm' : 'clear'}`);
      node.setAttribute('aria-label', node.title);
      node.querySelector('.verdict').textContent = verdict === 'alarm' ? '!' : verdict === 'clear' ? '✓' : '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, assignments, severities, alarmKey]);

  const loadInView = () => {
    const b = mapRef.current?.getBounds();
    if (b) onLoadInView([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
  };

  return <div className="map-wrap">
    <div ref={container} className="map" role="region" aria-label="Map of power infrastructure" />
    <div className="map-tools">
      <label className="toggle"><input type="checkbox" checked={showLines}
        onChange={e => onToggleLines(e.target.checked)} /> Power lines</label>
      <button onClick={loadInView} disabled={loading || !ready}>{loading ? 'Loading…' : 'Load in view'}</button>
    </div>
    {showLines && <ul className="map-legend" aria-label="Line voltage colours">
      {VOLTAGE_BANDS.map(b => <li key={b.label}><span style={{ background: b.color }} />{b.label}</li>)}
      <li><span style={{ background: UNKNOWN_VOLTAGE_COLOR }} />unknown</li>
      <li><span className="tri" />plant</li>
    </ul>}
    {(notice || baseFallback) && <p className="map-notice">
      {notice || 'Base map unavailable offline — showing grid data only.'}</p>}
  </div>;
}
