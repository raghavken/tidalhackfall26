// GET /infra?bbox=south,west,north,east
// Real power infrastructure (OpenStreetMap) for the map. United States only.
//  - Areas inside the Brazos Valley snapshot are served from the snapshot (fast, offline-safe).
//  - Other areas are fetched live from Overpass, cached in memory.
//  - If the live query fails, the snapshot is returned with live_unavailable: true.
// Lives under /infra because /api/* is rewritten to the FastAPI simulator.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SNAPSHOT_BBOX, bboxInside, fetchInfrastructure, parseBbox } from '../../lib/overpass.mjs';

export const dynamic = 'force-dynamic';

const cache = new Map(); // bbox key -> response body
const CACHE_LIMIT = 30;
let snapshotPromise = null;

function loadSnapshot() {
  snapshotPromise ??= readFile(path.join(process.cwd(), 'data', 'infra-snapshot.json'), 'utf8')
    .then(JSON.parse)
    .catch(error => { snapshotPromise = null; throw error; });
  return snapshotPromise;
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  let bbox;
  try {
    bbox = params.has('bbox') ? parseBbox(params.get('bbox')) : SNAPSHOT_BBOX;
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  if (bboxInside(bbox, SNAPSHOT_BBOX) && params.get('live') !== '1') {
    return json({ ...(await loadSnapshot()), source: 'snapshot' });
  }

  const key = bbox.map(v => v.toFixed(3)).join(',');
  if (cache.has(key)) return json({ ...cache.get(key), source: 'live (cached)' });

  try {
    const data = await fetchInfrastructure(bbox);
    const body = { bbox, fetchedAt: new Date().toISOString(), ...data };
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, body);
    return json({ ...body, source: 'live' });
  } catch (error) {
    return json({ ...(await loadSnapshot()), source: 'snapshot', live_unavailable: true,
      warning: 'Live map data unavailable (' + error.message + '); showing the Brazos Valley snapshot.' });
  }
}
