// Station <-> real substation assignments and map preferences, kept in the
// browser's localStorage. Every function takes the storage object so it can be
// unit-tested with a fake; all access is wrapped because storage can throw
// (private windows, blocked site data).

import { CATEGORY_BY_ID, DEFAULT_CATEGORIES } from './critical.mjs';

export const STATION_NAMES = ['North', 'East', 'South', 'West'];
const ASSIGN_KEY = 'oc.assignments.v1';
const PREFS_KEY = 'oc.mapPrefs.v1';

function read(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Only the fields we need from a substation feature. */
export function summarizeSubstation(feature) {
  const p = feature.properties;
  return {
    id: p.id,
    name: p.name,
    operator: p.operator ?? null,
    voltage: p.voltage ?? null,
    voltagesKv: Array.isArray(p.voltagesKv) ? p.voltagesKv : [],
    maxKv: p.maxKv ?? null,
    outline: Array.isArray(p.outline) ? p.outline : null,
    lngLat: feature.geometry.coordinates,
  };
}

export function loadAssignments(storage) {
  const raw = read(storage, ASSIGN_KEY, {});
  const out = {};
  for (const name of STATION_NAMES) {
    const s = raw?.[name];
    out[name] = s && typeof s.id === 'string' && Array.isArray(s.lngLat) ? s : null;
  }
  return out;
}

/**
 * Assign `substation` (a summary) to `station`. A substation can only hold one
 * station: assigning it elsewhere moves it. Returns the new assignments.
 */
export function assign(storage, current, station, substation) {
  if (!STATION_NAMES.includes(station)) throw new Error(`unknown station ${station}`);
  const next = { ...current };
  for (const name of STATION_NAMES) {
    if (next[name]?.id === substation.id) next[name] = null;
  }
  next[station] = substation;
  write(storage, ASSIGN_KEY, next);
  return next;
}

export function unassign(storage, current, station) {
  const next = { ...current, [station]: null };
  write(storage, ASSIGN_KEY, next);
  return next;
}

export function stationFor(assignments, substationId) {
  return STATION_NAMES.find(name => assignments[name]?.id === substationId) ?? null;
}

export function loadPrefs(storage) {
  const prefs = read(storage, PREFS_KEY, {});
  const categories = Array.isArray(prefs.categories)
    ? prefs.categories.filter(id => CATEGORY_BY_ID[id]) : [...DEFAULT_CATEGORIES];
  return { showLines: prefs.showLines !== false, categories };
}

export function savePrefs(storage, prefs) {
  write(storage, PREFS_KEY, prefs);
  return prefs;
}
