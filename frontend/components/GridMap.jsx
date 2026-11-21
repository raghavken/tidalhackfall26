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
import { STATION_COLORS, STATION_LABEL, STATION_NAMES, stationTitle } from '../lib/stations';
import { CATEGORIES, CATEGORY_BY_ID } from '../lib/critical.mjs';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const FALLBACK_STYLE = { version: 8, sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1017' } }] };
const EMPTY = { type: 'FeatureCollection', features: [] };
const LINE_LAYERS = ['oc-lines', 'oc-lines-touch', 'oc-lines-connect'];

async function loadStyle() {
  try {
    const response = await fetch(STYLE_URL, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(String(response.status));
    const style = await response.json();
    for (const layer of style.layers || []) {
      if (layer.type === 'symbol') {
        layer.paint = { ...(layer.paint || {}), 'text-opacity': 0.55, 'icon-opacity': 0.35 };
      }
    }
    return { style, fallback: false };
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
  ctx.fillStyle = '#A1A1AA';
  ctx.strokeStyle = '#09090B';
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

// Phase 2: one round marker per facility category (colour + letter, so it's
// never colour alone).
function facilityImage(color, mark, size = 30) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = '#18181B';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = `bold ${Math.round(size * 0.5)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(mark, size / 2, size / 2 + 1);
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
  onToggleLines, onAssign, onPreview, onSelectStation, onLoadInView, loading, notice, focus,
  critical, categories, onToggleCategory }) {
  const container = useRef(null);
  const mapRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [baseFallback, setBaseFallback] = useState(false);
  const [facilityPanel, setFacilityPanel] = useState(false);
  const markers = useRef({});
  const handlers = useRef({});
  handlers.current = { onAssign, onPreview, onSelectStation, assignments, critical };

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
            'line-opacity': 0.8 } });
        map.addLayer({ id: 'oc-lines-touch', type: 'line', source: 'oc-lines-src',
          filter: ['in', ['get', 'id'], ['literal', []]],
          paint: { 'line-color': '#E5484D', 'line-width': 2.5, 'line-opacity': 0.45 } });
        map.addLayer({ id: 'oc-lines-connect', type: 'line', source: 'oc-lines-src',
          filter: ['in', ['get', 'id'], ['literal', []]],
          paint: { 'line-color': '#E5484D', 'line-width': 3.5, 'line-opacity': 0.85 } });
        // Phase 2: critical facilities, pipelines, attribution lines, criticality halos
        for (const c of CATEGORIES) map.addImage(`oc-fac-${c.id}`, facilityImage(c.color, c.mark), { pixelRatio: 2 });
        for (const id of ['oc-fac-src', 'oc-pipes-src', 'oc-attrib-src', 'oc-halo-src']) {
          map.addSource(id, { type: 'geojson', data: EMPTY });
        }
        map.addLayer({ id: 'oc-pipes', type: 'line', source: 'oc-pipes-src',
          paint: { 'line-color': '#8C7A66', 'line-width': 1.2, 'line-opacity': 0.75, 'line-dasharray': [3, 2] } });
        map.addLayer({ id: 'oc-attrib', type: 'line', source: 'oc-attrib-src', minzoom: 10.5,
          paint: { 'line-color': '#71717A', 'line-width': 1, 'line-opacity': 0.5, 'line-dasharray': [1, 2] } });
        map.addLayer({ id: 'oc-halo', type: 'circle', source: 'oc-halo-src',
          paint: { 'circle-color': '#A1A1AA', 'circle-opacity': 0.08, 'circle-stroke-color': '#A1A1AA',
            'circle-stroke-width': 1, 'circle-stroke-opacity': 0.45,
            'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 2, 9, 10, 14, 30, 22, 60, 30] } });
        map.addLayer({ id: 'oc-plants', type: 'symbol', source: 'oc-plants-src',
          layout: { 'icon-image': 'oc-triangle', 'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 13, 1.1],
            'icon-allow-overlap': true } });
        map.addLayer({ id: 'oc-subs', type: 'circle', source: 'oc-subs-src',
          paint: { 'circle-color': '#E4E4E7',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 12, 4.5, 15, 7],
            'circle-stroke-color': '#09090B', 'circle-stroke-width': 1.5 } });
        map.addLayer({ id: 'oc-fac', type: 'symbol', source: 'oc-fac-src',
          filter: ['in', ['get', 'category'], ['literal', []]],
          layout: { 'icon-image': ['concat', 'oc-fac-', ['get', 'category']], 'icon-allow-overlap': true,
            'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 13, 0.9] } });

        // Hover tooltips
        const tip = new Popup({ closeButton: false, closeOnClick: false, className: 'oc-tip', offset: 10 });
        map.on('mousemove', 'oc-fac', e => {
          map.getCanvas().style.cursor = 'pointer';
          const p = e.features[0].properties;
          const category = CATEGORY_BY_ID[p.category];
          const near = handlers.current.critical?.nearestName?.(p.id);
          const box = el('div');
          box.append(el('strong', null, p.name || `Unnamed ${category?.one ?? 'facility'}`));
          box.append(el('div', 'tip-detail', [category?.label, p.operator].filter(Boolean).join(' · ')));
          box.append(el('div', 'tip-detail', near ? `Nearest substation: ${near}` : 'No transmission substation within 10 km'));
          tip.setLngLat(e.lngLat).setDOMContent(box).addTo(map);
        });
        map.on('mouseleave', 'oc-fac', () => { map.getCanvas().style.cursor = ''; tip.remove(); });
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
          if (holder) box.append(el('p', 'assigned-as', `Assigned as ${stationTitle(holder)}`));
          const impact = handlers.current.critical?.describe?.(summary.id);
          if (impact) {
            const p = el('p', 'impact');
            p.append(el('b', null, 'Nearest substation for: '), document.createTextNode(impact));
            box.append(p);
          }
          const popup = new Popup({ offset: 12, maxWidth: '280px' });
          const view = el('button', 'btn-primary', 'View in 3D');
          view.onclick = () => { previewCb(summary); popup.remove(); };
          box.append(view);
          const row = el('div', 'assign-row');
          row.append(el('span', 'muted', 'Assign as station'));
          for (const name of STATION_NAMES) {
            const b = el('button', 'assign', STATION_LABEL[name]);
            b.title = `Assign as ${stationTitle(name)}`;
            b.style.setProperty('--stn', STATION_COLORS[name]);
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

  // -- Phase 2: facilities, pipelines, attribution lines, halos -------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.getSource('oc-fac-src').setData(data?.facilities ?? EMPTY);
    map.getSource('oc-pipes-src').setData(data?.pipelines ?? EMPTY);
    map.getSource('oc-attrib-src').setData(critical?.attributionLines ?? EMPTY);
    map.getSource('oc-halo-src').setData(critical?.halos ?? EMPTY);
  }, [ready, data, critical]);

  const categoryKey = (categories || []).join(',');
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const visible = categories || [];
    map.setFilter('oc-fac', ['in', ['get', 'category'], ['literal', visible]]);
    map.setFilter('oc-attrib', ['in', ['get', 'category'], ['literal', visible]]);
    map.setLayoutProperty('oc-pipes', 'visibility', visible.includes('oil_gas') ? 'visible' : 'none');
    map.setLayoutProperty('oc-attrib', 'visibility', visible.length ? 'visible' : 'none');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, categoryKey]);

  // -- jump to a region (page sets `focus` = { bbox: [s, w, n, e], key }) ---------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focus) return;
    const [s, w, n, e] = focus.bbox;
    map.fitBounds([[w, s], [e, n]], { padding: 24, duration: 1200 });
  }, [ready, focus]);

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
        node.append(el('span', 'ring'), el('span', 'letter', STATION_LABEL[name]), el('span', 'verdict'));
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
      node.title = `${stationTitle(name)}: ${sub.name} · ${severity}` +
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

  return <>
    <div className="map-wrap">
      <div ref={container} className="map" role="region" aria-label="Map of power infrastructure" />
      <div className="map-tools" role="toolbar" aria-label="Map layers">
        <label className="tool-toggle"><input type="checkbox" checked={showLines}
          onChange={e => onToggleLines(e.target.checked)} /> Lines</label>
        {data?.facilitiesAvailable && <button className="tool-btn" onClick={() => setFacilityPanel(v => !v)}
          aria-expanded={facilityPanel}>Facilities</button>}
        <button className="tool-btn" onClick={loadInView} disabled={loading || !ready}>
          {loading ? 'Loading…' : 'Load view'}</button>
      </div>
      {facilityPanel && data?.facilitiesAvailable && <div className="facility-panel" role="group"
        aria-label="Critical facility layers">
        <p className="facility-title">Critical facilities</p>
        {CATEGORIES.map(c => {
          const count = data.facilities.features.filter(f => f.properties.category === c.id).length;
          return <label key={c.id} className="tool-toggle">
            <input type="checkbox" checked={(categories || []).includes(c.id)}
              onChange={e => onToggleCategory(c.id, e.target.checked)} />
            <span className="fac-mark" style={{ '--fac': c.color }}>{c.mark}</span>
            <span>{c.label}</span><span className="mono muted">{count}</span>
          </label>;
        })}
        <p className="muted small">Ring size = criticality of the nearest transmission substation
          (facilities within 10 km). Proximity estimate, not service areas.</p>
      </div>}
      {showLines && <ul className="map-legend" aria-label="Line voltage colours">
        {VOLTAGE_BANDS.map(b => <li key={b.label}><span style={{ background: b.color }} />{b.label}</li>)}
        <li><span style={{ background: UNKNOWN_VOLTAGE_COLOR }} />n/a</li>
        <li><span className="tri" />plant</li>
      </ul>}
    </div>
    {(notice || baseFallback) && <p className="map-status-note">
      {notice || 'Base map unavailable offline; showing grid topology only.'}</p>}
  </>;
}
