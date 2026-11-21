// Pre-downloaded map regions. The public Overpass servers are too slow for
// interactive use (30–60 s per area, often failing), so these regions are
// downloaded ahead of time (`npm run regions`) and served instantly by /infra.
// bbox = [south, west, north, east]. `border: true` regions touch Mexico, so
// their query is clipped to the US border.

import { SNAPSHOT_BBOX } from './overpass.mjs';

export const REGIONS = [
  // South Texas (downloaded first)
  { id: 'san-antonio', name: 'San Antonio', group: 'South Texas', bbox: [29.15, -98.95, 29.85, -98.15] },
  { id: 'corpus-christi', name: 'Corpus Christi', group: 'South Texas', bbox: [27.55, -97.75, 28.05, -97.05] },
  { id: 'laredo', name: 'Laredo', group: 'South Texas', bbox: [27.35, -99.65, 27.75, -99.25], border: true },
  { id: 'rio-grande-valley', name: 'Rio Grande Valley (McAllen–Brownsville)', group: 'South Texas',
    bbox: [25.85, -98.35, 26.45, -97.15], border: true },
  // Major Texas metros
  { id: 'houston', name: 'Houston', group: 'Major metros', bbox: [29.45, -95.85, 30.15, -94.95] },
  { id: 'dallas-fort-worth', name: 'Dallas–Fort Worth', group: 'Major metros', bbox: [32.55, -97.55, 33.15, -96.55] },
  { id: 'austin', name: 'Austin', group: 'Major metros', bbox: [30.05, -98.05, 30.60, -97.50] },
  // The original snapshot
  { id: 'brazos-valley', name: 'Brazos Valley (College Station)', group: 'Central Texas', bbox: SNAPSHOT_BBOX,
    file: 'infra-snapshot.json' },
];

export const DEFAULT_REGION_ID = 'brazos-valley';

export function regionFile(region) {
  return region.file ?? `regions/${region.id}.json`;
}

export function regionById(id) {
  return REGIONS.find(r => r.id === id) ?? null;
}

const area = ([s, w, n, e]) => Math.max(0, n - s) * Math.max(0, e - w);

function overlap(a, b) {
  return area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
}

/**
 * The pre-downloaded region to serve for a requested bbox, or null.
 * A region that fully contains the bbox wins; otherwise the region covering
 * the largest share of the bbox, if it covers at least `minShare` of it.
 * `available` limits the choice to regions whose file exists.
 */
export function regionFor(bbox, { available = REGIONS.map(r => r.id), minShare = 0.25 } = {}) {
  const candidates = REGIONS.filter(r => available.includes(r.id));
  const containing = candidates.filter(r => bbox[0] >= r.bbox[0] && bbox[1] >= r.bbox[1] &&
    bbox[2] <= r.bbox[2] && bbox[3] <= r.bbox[3]);
  if (containing.length) return { region: containing[0], contained: true };
  let best = null;
  let bestShare = 0;
  for (const r of candidates) {
    const share = overlap(bbox, r.bbox) / area(bbox);
    if (share > bestShare) { best = r; bestShare = share; }
  }
  return best && bestShare >= minShare ? { region: best, contained: false } : null;
}
