// Download the pre-built map regions (lib/regions.mjs), in order, retrying the
// overloaded public Overpass servers patiently (lib/overpassRetry.mjs).
// Regions that already have a file are skipped unless --force is given.
// Usage (from frontend/):
//   npm run regions                 # all missing regions
//   npm run regions -- houston      # just these ids
//   npm run regions -- --force      # re-download everything
import { mkdir, writeFile, access } from 'node:fs/promises';
import { REGIONS, regionFile } from '../lib/regions.mjs';
import { buildQuery, parseOverpass, summarize } from '../lib/overpass.mjs';
import { overpassWithRetry } from '../lib/overpassRetry.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter(a => !a.startsWith('--'));
const dataDir = new URL('../data/', import.meta.url);
await mkdir(new URL('regions/', dataDir), { recursive: true });
const exists = url => access(url).then(() => true, () => false);
const results = [];

for (const region of REGIONS) {
  if (only.length && !only.includes(region.id)) continue;
  const target = new URL(regionFile(region), dataDir);
  if (!force && await exists(target)) {
    console.log(`skip  ${region.id} (already downloaded)`);
    continue;
  }
  const t0 = Date.now();
  try {
    // Interior regions skip the (expensive) US-border clip; border regions keep it.
    const query = buildQuery(region.bbox, { usBorder: Boolean(region.border), timeoutS: 140 });
    const data = parseOverpass(await overpassWithRetry(query, { log: m => console.log(`      ${region.id}: ${m}`) }));
    await writeFile(target, JSON.stringify({ region: region.id, name: region.name, bbox: region.bbox,
      fetchedAt: new Date().toISOString(),
      source: 'OpenStreetMap contributors via Overpass API (ODbL)', ...data }));
    console.log(`ok    ${region.id} in ${Math.round((Date.now() - t0) / 1000)} s`, summarize(data));
    results.push([region.id, 'ok']);
  } catch (error) {
    console.log(`FAIL  ${region.id}: ${error.message}`);
    results.push([region.id, 'FAILED']);
  }
}
console.log('summary:', JSON.stringify(results));
