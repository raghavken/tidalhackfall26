// Phase 2: critical facilities near the grid (OpenStreetMap), and a
// "nearest substation" criticality score for each transmission substation.
// Pure functions: shared by the /infra route, the download script and tests.
//
// IMPORTANT: attribution is a PROXIMITY ESTIMATE. OpenStreetMap does not record
// which substation actually feeds a facility, so the UI says "nearest
// substation for", never "serves".

import { distanceKm } from './topology.mjs';

export const ATTRIBUTION_KM = 10;

// id, label (plural), short marker text, colour, weight, on by default
export const CATEGORIES = [
  { id: 'hospital', label: 'Hospitals', one: 'hospital', mark: 'H', color: '#E2919B', weight: 5, defaultOn: true },
  { id: 'military', label: 'Military / defence', one: 'military site', mark: 'M', color: '#A3B386', weight: 5, defaultOn: true },
  { id: 'water', label: 'Water & wastewater', one: 'water plant', mark: 'W', color: '#7DB3E0', weight: 4, defaultOn: true },
  { id: 'oil_gas', label: 'Oil & gas (major)', one: 'oil & gas site', mark: 'O', color: '#BC9A78', weight: 3, defaultOn: true },
  { id: 'emergency', label: 'Emergency services', one: 'emergency station', mark: 'E', color: '#C9A3C4', weight: 3, defaultOn: false },
  { id: 'airport', label: 'Airports', one: 'airport', mark: 'A', color: '#B4BAC4', weight: 3, defaultOn: false },
  { id: 'data_center', label: 'Data centres / telecom', one: 'data centre', mark: 'D', color: '#A79BD8', weight: 2, defaultOn: false },
  { id: 'university', label: 'Universities', one: 'university', mark: 'U', color: '#C9C08A', weight: 2, defaultOn: false },
];
export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
export const DEFAULT_CATEGORIES = CATEGORIES.filter(c => c.defaultOn).map(c => c.id);

const MILITARY_KINDS = new Set(['base', 'airfield', 'naval_base', 'range', 'training_area', 'barracks']);
const OIL_GAS_INDUSTRIAL = new Set(['refinery', 'oil', 'gas', 'petroleum_terminal', 'oil_terminal']);
const PIPE_SUBSTANCES = new Set(['oil', 'gas', 'crude_oil', 'natural_gas', 'fuel', 'petroleum', 'hydrocarbons', 'lpg']);
const PUBLIC_AERODROME = new Set(['public', 'international', 'regional']);

/** Which category (if any) an OSM element belongs to. */
export function categorize(tags = {}) {
  if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') return 'hospital';
  if (tags.landuse === 'military' || MILITARY_KINDS.has(tags.military)) return 'military';
  if (tags.man_made === 'water_works' || tags.man_made === 'wastewater_plant') return 'water';
  if (OIL_GAS_INDUSTRIAL.has(tags.industrial)) return 'oil_gas';
  if (tags.amenity === 'fire_station' || tags.amenity === 'police') return 'emergency';
  if (tags.aeroway === 'aerodrome' &&
    (tags.iata || tags.icao || PUBLIC_AERODROME.has(tags['aerodrome:type']) || PUBLIC_AERODROME.has(tags.aerodrome))) {
    return 'airport';
  }
  if (tags.telecom === 'data_center' || tags.building === 'data_center') return 'data_center';
  if (tags.amenity === 'university') return 'university';
  return null;
}

/** Major oil/gas pipelines only: an oil/gas substance plus a name or operator. */
export function isMajorPipeline(tags = {}) {
  return tags.man_made === 'pipeline' && PIPE_SUBSTANCES.has(tags.substance) && Boolean(tags.name || tags.operator);
}

/** Overpass query for all 8 categories (+ major pipelines) in a bbox [s, w, n, e]. */
export function buildFacilitiesQuery([s, w, n, e], { usBorder = true, timeoutS = 120 } = {}) {
  const box = `(${s},${w},${n},${e})`;
  const us = usBorder ? '(area.us)' : '';
  const parts = [
    'nwr["amenity"~"^(hospital|fire_station|police|university)$"]',
    'nwr["healthcare"="hospital"]',
    'nwr["landuse"="military"]',
    'nwr["military"~"^(base|airfield|naval_base|range|training_area|barracks)$"]',
    'nwr["man_made"~"^(water_works|wastewater_plant)$"]',
    'nwr["industrial"~"^(refinery|oil|gas|petroleum_terminal|oil_terminal)$"]',
    'nwr["aeroway"="aerodrome"]',
    'nwr["telecom"="data_center"]',
    'nwr["building"="data_center"]',
  ].map(p => `  ${p}${us}${box};`).join('\n');
  return `[out:json][timeout:${timeoutS}];
${usBorder ? 'area["ISO3166-1"="US"][admin_level=2]->.us;\n' : ''}(
${parts}
);
out center tags;
way["man_made"="pipeline"]["substance"]${us}${box};
out geom tags;`;
}

const round = (v, d = 5) => Math.round(v * 10 ** d) / 10 ** d;

function centreOf(el) {
  if (el.type === 'node') return [el.lon, el.lat];
  if (el.center) return [el.center.lon, el.center.lat];
  return null;
}

/** Overpass JSON -> { facilities: points FC, pipelines: lines FC }. */
export function parseFacilities(json) {
  const facilities = [];
  const pipelines = [];
  const seen = new Set();
  for (const el of json?.elements || []) {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = el.tags || {};
    if (isMajorPipeline(tags) && el.type === 'way' && el.geometry?.length >= 2) {
      pipelines.push({ type: 'Feature', properties: { id: key, name: tags.name || null,
        operator: tags.operator || null, substance: tags.substance },
      geometry: { type: 'LineString', coordinates: el.geometry.filter(Boolean).map(p => [round(p.lon), round(p.lat)]) } });
      continue;
    }
    const category = categorize(tags);
    const c = category && centreOf(el);
    if (!c) continue;
    facilities.push({ type: 'Feature', properties: { id: key, category,
      name: tags.name || tags.official_name || null, operator: tags.operator || null },
    geometry: { type: 'Point', coordinates: [round(c[0]), round(c[1])] } });
  }
  const fc = features => ({ type: 'FeatureCollection', features });
  return { facilities: fc(facilities), pipelines: fc(pipelines) };
}

/**
 * Attribute each facility to its nearest transmission substation within
 * `maxKm`, so it counts once. Returns Map(substationId -> {score, counts,
 * facilities}) plus `attributedTo` (facilityId -> substationId).
 */
export function attributeFacilities(facilityFeatures, substationFeatures, maxKm = ATTRIBUTION_KM) {
  const bySubstation = new Map();
  const attributedTo = new Map();
  const subs = substationFeatures.map(f => ({ id: f.properties.id, at: f.geometry.coordinates }));
  for (const facility of facilityFeatures) {
    let best = null;
    let bestKm = Infinity;
    for (const s of subs) {
      const km = distanceKm(facility.geometry.coordinates, s.at);
      if (km < bestKm) { best = s; bestKm = km; }
    }
    if (!best || bestKm > maxKm) continue;
    const category = CATEGORY_BY_ID[facility.properties.category];
    if (!category) continue;
    const entry = bySubstation.get(best.id) ?? { score: 0, counts: {}, facilities: [] };
    entry.score += category.weight;
    entry.counts[category.id] = (entry.counts[category.id] ?? 0) + 1;
    entry.facilities.push({ id: facility.properties.id, category: category.id,
      name: facility.properties.name, distanceKm: Math.round(bestKm * 10) / 10 });
    bySubstation.set(best.id, entry);
    attributedTo.set(facility.properties.id, best.id);
  }
  return { bySubstation, attributedTo };
}

/** "2 hospitals, 1 water plant, Texas A&M University" style summary. */
export function describeImpact(entry, { maxNames = 3 } = {}) {
  if (!entry || entry.score === 0) return '';
  const parts = CATEGORIES.filter(c => entry.counts[c.id]).map(c => {
    const n = entry.counts[c.id];
    if (c.id === 'university' || c.id === 'military' || c.id === 'airport') {
      const names = entry.facilities.filter(f => f.category === c.id && f.name).map(f => f.name);
      if (names.length && names.length <= maxNames) return names.join(', ');
    }
    return `${n} ${c.one}${n === 1 ? '' : 's'}`;
  });
  return parts.join(', ');
}

/**
 * Everything the map/verdict need for a loaded region:
 *  - bySubstation: Map(substationId -> {score, counts, facilities})
 *  - halos: points at critical substations with a `score` property
 *  - attributionLines: facility -> nearest-substation lines (with `category`)
 *  - nearestOf: Map(facilityId -> substation name)
 * `data` is an /infra response ({substations, facilities}); facilities may be absent.
 */
export function criticality(data, maxKm = ATTRIBUTION_KM) {
  const empty = { type: 'FeatureCollection', features: [] };
  const subs = data?.substations?.features ?? [];
  const facs = data?.facilities?.features ?? [];
  if (!subs.length || !facs.length) {
    return { bySubstation: new Map(), halos: empty, attributionLines: empty, nearestOf: new Map() };
  }
  const { bySubstation, attributedTo } = attributeFacilities(facs, subs, maxKm);
  const subById = new Map(subs.map(f => [f.properties.id, f]));
  const halos = { type: 'FeatureCollection', features: [...bySubstation].map(([id, entry]) => ({
    type: 'Feature', properties: { id, score: entry.score }, geometry: subById.get(id).geometry })) };
  const nearestOf = new Map();
  const attributionLines = { type: 'FeatureCollection', features: [] };
  for (const f of facs) {
    const subId = attributedTo.get(f.properties.id);
    if (!subId) continue;
    const sub = subById.get(subId);
    nearestOf.set(f.properties.id, sub.properties.name);
    attributionLines.features.push({ type: 'Feature',
      properties: { facility: f.properties.id, substation: subId, category: f.properties.category },
      geometry: { type: 'LineString', coordinates: [f.geometry.coordinates, sub.geometry.coordinates] } });
  }
  return { bySubstation, halos, attributionLines, nearestOf };
}
