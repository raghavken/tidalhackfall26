// Turn a substation's OSM details into parameters for the procedural 3D model.
// Pure and deterministic, so the 3D scene stays a thin rendering layer.

import { distanceKm } from './topology.mjs';

const DEFAULT_LEVELS_KV = [138, 69];
const MIN_YARD_M = 60;
const MAX_YARD_M = 220;

/** Approximate width/depth (m) of an outline ring of [lon, lat] points. */
export function outlineSizeM(outline) {
  if (!outline || outline.length < 4) return null;
  const lons = outline.map(p => p[0]);
  const lats = outline.map(p => p[1]);
  const [w, e, s, n] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  return { width: distanceKm([w, s], [e, s]) * 1000, depth: distanceKm([w, s], [w, n]) * 1000 };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Small stable hash so the same substation always gets the same layout details. */
function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * substation: summary from assignments.summarizeSubstation(), or null for a
 * generic model. Returns everything SubstationScene needs to build geometry.
 */
export function modelParams(substation) {
  const levels = (substation?.voltagesKv?.length ? substation.voltagesKv : DEFAULT_LEVELS_KV)
    .filter(kv => kv >= 10).slice(0, 3);
  const size = outlineSizeM(substation?.outline);
  const seed = hash(substation?.id ?? 'generic');
  return {
    generic: !substation,
    name: substation?.name ?? 'Generic substation',
    voltageLabel: levels.length ? levels.map(kv => `${kv} kV`).join(' / ') : 'unknown voltage',
    levelsKv: levels,
    yard: { width: clamp(size?.width ?? 110, MIN_YARD_M, MAX_YARD_M),
      depth: clamp(size?.depth ?? 80, MIN_YARD_M, MAX_YARD_M) },
    transformers: clamp(levels.length >= 2 ? levels.length - 1 + (seed % 2) : 1, 1, 3),
    // One bay (gantry + busbar + incoming tower line) per voltage level, scaled by voltage.
    bays: levels.map((kv, i) => ({
      kv,
      height: clamp(8 + kv / 25, 9, 22),          // taller structures for higher voltage
      towers: kv >= 300 ? 2 : 1 + ((seed >> (i + 1)) % 2),
      side: i % 2 === 0 ? 1 : -1,                 // alternate incoming sides
    })),
    breakers: clamp(levels.length * 3, 3, 9),
    seed,
  };
}

// Glow is reserved for an actual oscillation: none when normal; amber -> red
// with severity. (A text label is always shown too.)
export const SEVERITY_GLOW = {
  normal: '#000000',
  mild: '#E0A33A',
  moderate: '#E07B39',
  severe: '#E5484D',
  preview: '#000000',
};
