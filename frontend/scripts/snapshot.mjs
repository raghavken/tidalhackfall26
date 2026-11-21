// Download the offline snapshot of the Brazos Valley grid from Overpass.
// Usage (from frontend/):  npm run snapshot
import { writeFile } from 'node:fs/promises';
import { SNAPSHOT_BBOX, fetchInfrastructure, summarize } from '../lib/overpass.mjs';

const target = new URL('../data/infra-snapshot.json', import.meta.url);
console.log('Querying Overpass for bbox', SNAPSHOT_BBOX.join(','), '…');
const data = await fetchInfrastructure(SNAPSHOT_BBOX, { timeoutMs: 240000 });
const snapshot = { bbox: SNAPSHOT_BBOX, fetchedAt: new Date().toISOString(),
  source: 'OpenStreetMap contributors via Overpass API (ODbL)', ...data };
await writeFile(target, JSON.stringify(snapshot));
console.log('Wrote', target.pathname, summarize(data));
