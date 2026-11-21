// OpenStreetMap (Overpass API) query + parsing into map-ready GeoJSON.
// Pure functions except fetchInfrastructure(); shared by the /infra route,
// the snapshot script and the unit tests.

import { maxVoltageKv, parseVoltagesKv } from './voltage.mjs';

// Public Overpass servers, tried in order (the main one is often overloaded).
export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
export const MIN_TRANSMISSION_KV = 69;
export const MAX_BBOX_DEGREES = 1.5;

// The map only covers the United States (contiguous 48 states).
// US_BOUNDS (south, west, north, east) rejects requests; US_MAX_BOUNDS limits
// panning. The Overpass query is also clipped to the real US border (OSM
// country area), so border regions don't pull in Canada/Mexico.
export const US_BOUNDS = [24.3, -125.0, 49.5, -66.8];
export const US_MAX_BOUNDS = [[-130, 20], [-62, 53]];

// Wider Brazos Valley, ~100 x 100 km around College Station (south, west, north, east)
export const SNAPSHOT_BBOX = [30.18, -96.86, 31.08, -95.81];
export const DEFAULT_CENTER = { lat: 30.628, lon: -96.334 };
export const DEFAULT_ZOOM = 10;

const DISTRIBUTION_TYPES = new Set(['distribution', 'minor_distribution']);

/** Validate a bbox [south, west, north, east]. Throws on bad input or outside the US. */
export function parseBbox(value) {
  const parts = (Array.isArray(value) ? value : String(value ?? '').split(',')).map(Number);
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) {
    throw new Error('bbox must be "south,west,north,east" in degrees');
  }
  const [s, w, n, e] = parts;
  if (s < -90 || n > 90 || w < -180 || e > 180 || s >= n || w >= e) {
    throw new Error('bbox is out of range or inverted');
  }
  if (n - s > MAX_BBOX_DEGREES || e - w > MAX_BBOX_DEGREES) {
    throw new Error(`area too large: zoom in (max ${MAX_BBOX_DEGREES}° per side)`);
  }
  const [us, uw, un, ue] = US_BOUNDS;
  if (n <= us || s >= un || e <= uw || w >= ue) {
    throw new Error('map data is limited to the United States');
  }
  return [s, w, n, e];
}

export function bboxInside(inner, outer) {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

/**
 * Overpass query for transmission infrastructure in a bbox.
 * `usBorder: true` (default) clips to the US border via the OSM country area;
 * it costs extra server time, so interior regions can skip it.
 * `timeoutS` is the server-side query timeout.
 */
export function buildQuery([s, w, n, e], { usBorder = true, timeoutS = 60 } = {}) {
  const box = `(${s},${w},${n},${e})`;
  const us = usBorder ? '(area.us)' : '';
  return `[out:json][timeout:${timeoutS}];
${usBorder ? 'area["ISO3166-1"="US"][admin_level=2]->.us;\n' : ''}nwr["power"="substation"]${us}${box};
out geom tags;
nwr["power"="plant"]${us}${box};
out center tags;
way["power"="line"]${us}${box};
out geom tags;`;
}

/** Keep transmission substations; drop local distribution ones. */
export function isTransmissionSubstation(tags = {}) {
  if (tags.power !== 'substation') return false;
  if (tags.substation === 'transmission') return true;
  if (DISTRIBUTION_TYPES.has(tags.substation)) return false;
  const kv = maxVoltageKv(tags.voltage);
  return kv !== null && kv >= MIN_TRANSMISSION_KV;
}

/** Keep transmission lines: >= 69 kV, or untagged voltage (drawn grey). */
export function isTransmissionLine(tags = {}) {
  if (tags.power !== 'line') return false;
  const kv = maxVoltageKv(tags.voltage);
  return kv === null || kv >= MIN_TRANSMISSION_KV;
}

function centreOf(element) {
  if (element.type === 'node') return [element.lon, element.lat];
  if (element.center) return [element.center.lon, element.center.lat];
  if (element.bounds) {
    const b = element.bounds;
    return [(b.minlon + b.maxlon) / 2, (b.minlat + b.maxlat) / 2];
  }
  const pts = (element.geometry || []).filter(Boolean);
  if (!pts.length) return null;
  return [pts.reduce((a, p) => a + p.lon, 0) / pts.length, pts.reduce((a, p) => a + p.lat, 0) / pts.length];
}

function outlineOf(element) {
  if (element.type !== 'way' || !element.geometry || element.geometry.length < 4) return null;
  const ring = element.geometry.filter(Boolean).map(p => [p.lon, p.lat]);
  const [first, last] = [ring[0], ring[ring.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  return ring.length >= 4 ? ring : null;
}

const round = (v, d = 6) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Convert an Overpass JSON response into
 * { substations, outlines, plants, lines } GeoJSON FeatureCollections.
 */
export function parseOverpass(json) {
  const substations = [], outlines = [], plants = [], lines = [];
  const seen = new Set();
  for (const el of json?.elements || []) {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = el.tags || {};
    if (isTransmissionSubstation(tags)) {
      const c = centreOf(el);
      if (!c) continue;
      const levels = parseVoltagesKv(tags.voltage);
      const ring = outlineOf(el);
      const properties = {
        id: key,
        name: tags.name || tags['name:en'] || tags.ref || 'Unnamed substation',
        operator: tags.operator || null,
        voltage: tags.voltage || null,
        voltagesKv: levels,
        substationType: tags.substation || null,
      };
      if (levels.length) properties.maxKv = levels[0];
      if (ring) properties.outline = ring.map(([x, y]) => [round(x), round(y)]);
      substations.push({ type: 'Feature', id: substations.length + 1, properties,
        geometry: { type: 'Point', coordinates: [round(c[0]), round(c[1])] } });
      if (ring) {
        outlines.push({ type: 'Feature', properties: { id: key, name: properties.name },
          geometry: { type: 'Polygon', coordinates: [properties.outline] } });
      }
    } else if (tags.power === 'plant') {
      const c = centreOf(el);
      if (!c) continue;
      plants.push({ type: 'Feature', properties: {
        id: key,
        name: tags.name || 'Unnamed power plant',
        operator: tags.operator || null,
        source: tags['plant:source'] || tags['generator:source'] || null,
        output: tags['plant:output:electricity'] || null,
      }, geometry: { type: 'Point', coordinates: [round(c[0]), round(c[1])] } });
    } else if (isTransmissionLine(tags) && el.type === 'way' && el.geometry?.length >= 2) {
      const coords = el.geometry.filter(Boolean).map(p => [round(p.lon), round(p.lat)]);
      const properties = { id: key, name: tags.name || null, operator: tags.operator || null,
        voltage: tags.voltage || null, circuits: tags.circuits || null };
      const kv = maxVoltageKv(tags.voltage);
      if (kv !== null) properties.maxKv = kv;
      lines.push({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: coords } });
    }
  }
  const fc = features => ({ type: 'FeatureCollection', features });
  return { substations: fc(substations), outlines: fc(outlines), plants: fc(plants), lines: fc(lines) };
}

/**
 * Fetch and parse live data from Overpass, trying each server in `urls` until
 * one answers. `timeoutMs` is the total budget; each server gets a fair slice
 * so one hung server can't starve the mirrors. Throws if every server fails.
 */
export async function fetchInfrastructure(bbox, { timeoutMs = 25000, fetchImpl = fetch,
  urls = OVERPASS_URLS, usBorder = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  const perServerMs = Math.max(5000, Math.floor(timeoutMs / urls.length));
  const errors = [];
  for (const url of urls) {
    const remaining = Math.min(deadline - Date.now(), perServerMs);
    if (remaining <= 0) break;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'oscillation-cartographer/0.1 (hackathon demo)' },
        body: 'data=' + encodeURIComponent(buildQuery(bbox,
          { usBorder, timeoutS: Math.max(25, Math.ceil(remaining / 1000)) })),
        signal: AbortSignal.timeout(remaining),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseOverpass(await response.json());
    } catch (error) {
      errors.push(`${new URL(url).host}: ${error.message}`);
    }
  }
  throw new Error('Overpass unavailable (' + errors.join('; ') + ')');
}

/** Count summary used in logs and the UI. */
export function summarize(data) {
  return {
    substations: data.substations.features.length,
    plants: data.plants.features.length,
    lines: data.lines.features.length,
  };
}
