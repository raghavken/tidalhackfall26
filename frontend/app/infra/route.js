// GET /infra                      -> the default region (Brazos Valley)
// GET /infra?region=<id>          -> a pre-downloaded region (lib/regions.mjs)
// GET /infra?regions=1            -> list of regions and whether each is downloaded
// GET /infra?bbox=s,w,n,e         -> the pre-downloaded region covering that view (instant);
//                                    otherwise an instant 404 {code: "not_preloaded"}.
// GET /infra?bbox=…&live=1        -> opt-in live Overpass query (US only, up to 60 s).
// Errors carry a clear message; the page keeps its current map instead of timing out.
// Lives under /infra because /api/* is rewritten to the FastAPI simulator.

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchInfrastructure, parseBbox } from '../../lib/overpass.mjs';
import { DEFAULT_REGION_ID, REGIONS, regionById, regionFile, regionFor } from '../../lib/regions.mjs';

export const dynamic = 'force-dynamic';

const LIVE_TIMEOUT_MS = 60000; // public Overpass servers often need 30–60 s
const cache = new Map();          // live results by bbox key
const CACHE_LIMIT = 30;
const regionData = new Map();     // region id -> Promise<data>

const dataPath = region => path.join(process.cwd(), 'data', regionFile(region));

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function availableRegions() {
  const checks = await Promise.all(REGIONS.map(r => access(dataPath(r)).then(() => r.id, () => null)));
  return checks.filter(Boolean);
}

function loadRegion(region) {
  if (!regionData.has(region.id)) {
    regionData.set(region.id, readFile(dataPath(region), 'utf8').then(JSON.parse)
      .catch(error => { regionData.delete(region.id); throw error; }));
  }
  return regionData.get(region.id);
}

// Phase 2: critical facilities, stored separately in data/facilities/<region>.json
const facilityData = new Map();
function loadFacilities(region) {
  if (!facilityData.has(region.id)) {
    facilityData.set(region.id, readFile(path.join(process.cwd(), 'data', 'facilities', `${region.id}.json`), 'utf8')
      .then(JSON.parse)
      .then(d => ({ facilities: d.facilities, pipelines: d.pipelines }))
      .catch(() => { facilityData.delete(region.id); return null; }));
  }
  return facilityData.get(region.id);
}

async function serveRegion(region, extra = {}) {
  const [data, facilities] = await Promise.all([loadRegion(region), loadFacilities(region)]);
  return json({ ...data, ...(facilities ?? {}), facilitiesAvailable: Boolean(facilities),
    bbox: region.bbox, region: { id: region.id, name: region.name },
    source: `pre-loaded: ${region.name}`, ...extra });
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const available = await availableRegions();

  if (params.has('regions')) {
    return json(REGIONS.map(({ id, name, group, bbox }) =>
      ({ id, name, group, bbox, available: available.includes(id) })));
  }

  if (params.has('region') || !params.has('bbox')) {
    const region = regionById(params.get('region') ?? DEFAULT_REGION_ID);
    if (!region) return json({ error: `unknown region ${params.get('region')}` }, 404);
    if (!available.includes(region.id)) {
      return json({ error: `${region.name} hasn't been downloaded yet (run npm run regions)` }, 404);
    }
    return serveRegion(region);
  }

  let bbox;
  try {
    bbox = parseBbox(params.get('bbox'));
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  // A pre-downloaded region covering this view is served instantly.
  const match = params.get('live') === '1' ? null : regionFor(bbox, { available });
  if (match) {
    return serveRegion(match.region, match.contained ? {} : {
      warning: `Showing the pre-loaded ${match.region.name} region, which covers most of this view.` });
  }

  const key = bbox.map(v => v.toFixed(3)).join(',');
  if (cache.has(key)) return json({ ...cache.get(key), source: 'live (cached)' });

  const names = REGIONS.filter(r => available.includes(r.id)).map(r => r.name).join(', ');
  if (params.get('live') !== '1') {
    return json({ code: 'not_preloaded', error: `This area isn't pre-loaded. Use "Jump to region" ` +
      `(${names}), or try a live load (slow: the public OpenStreetMap servers can take a minute).` }, 404);
  }

  try {
    const data = await fetchInfrastructure(bbox, { timeoutMs: LIVE_TIMEOUT_MS });
    const body = { bbox, fetchedAt: new Date().toISOString(), ...data };
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, body);
    return json({ ...body, source: 'live' });
  } catch {
    return json({ error: 'Live map data is unavailable here right now (the public OpenStreetMap servers ' +
      `are overloaded). Pre-loaded regions: ${names}. Use "Jump to region".` }, 503);
  }
}
