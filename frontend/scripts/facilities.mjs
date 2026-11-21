// Phase 2: download critical facilities (lib/critical.mjs) for every
// pre-downloaded region, into data/facilities/<region>.json. Kept separate
// from the power-grid files so those don't need re-downloading.
// Usage (from frontend/):  npm run facilities [-- <ids…>] [-- --force]
import { mkdir, writeFile, access } from 'node:fs/promises';
import { REGIONS } from '../lib/regions.mjs';
import { buildFacilitiesQuery, parseFacilities } from '../lib/critical.mjs';
import { overpassWithRetry } from '../lib/overpassRetry.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter(a => !a.startsWith('--'));
const dir = new URL('../data/facilities/', import.meta.url);
await mkdir(dir, { recursive: true });
const exists = url => access(url).then(() => true, () => false);
const results = [];

for (const region of REGIONS) {
  if (only.length && !only.includes(region.id)) continue;
  const target = new URL(`${region.id}.json`, dir);
  if (!force && await exists(target)) { console.log(`skip  ${region.id}`); continue; }
  const t0 = Date.now();
  try {
    const query = buildFacilitiesQuery(region.bbox, { usBorder: Boolean(region.border), timeoutS: 140 });
    const data = parseFacilities(await overpassWithRetry(query, { log: m => console.log(`      ${region.id}: ${m}`) }));
    await writeFile(target, JSON.stringify({ region: region.id, bbox: region.bbox,
      fetchedAt: new Date().toISOString(), source: 'OpenStreetMap contributors via Overpass API (ODbL)', ...data }));
    const counts = {};
    for (const f of data.facilities.features) counts[f.properties.category] = (counts[f.properties.category] ?? 0) + 1;
    console.log(`ok    ${region.id} in ${Math.round((Date.now() - t0) / 1000)} s`, counts,
      `pipelines: ${data.pipelines.features.length}`);
    results.push([region.id, 'ok']);
  } catch (error) {
    console.log(`FAIL  ${region.id}: ${error.message}`);
    results.push([region.id, 'FAILED']);
  }
}
console.log('summary:', JSON.stringify(results));
