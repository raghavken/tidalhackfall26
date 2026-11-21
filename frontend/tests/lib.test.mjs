// Unit tests for the pure frontend libraries. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { maxVoltageKv, parseVoltagesKv, voltageColor, VOLTAGE_BANDS, UNKNOWN_VOLTAGE_COLOR }
  from '../lib/voltage.mjs';
import { buildQuery, isTransmissionLine, isTransmissionSubstation, parseBbox, parseOverpass,
  bboxInside, SNAPSHOT_BBOX, fetchInfrastructure } from '../lib/overpass.mjs';
import { assign, loadAssignments, loadPrefs, savePrefs, stationFor, summarizeSubstation, unassign }
  from '../lib/assignments.mjs';
import { classifyLines, distanceKm } from '../lib/topology.mjs';
import { modelParams, outlineSizeM } from '../lib/substationModel.mjs';

test('voltage parsing', () => {
  assert.deepEqual(parseVoltagesKv('138000;69000'), [138, 69]);
  assert.deepEqual(parseVoltagesKv('345000;23000;138000'), [345, 138, 23]);
  assert.deepEqual(parseVoltagesKv('345 kV'), [345]);
  assert.deepEqual(parseVoltagesKv('69000;69000'), [69]);
  assert.deepEqual(parseVoltagesKv('unknown'), []);
  assert.deepEqual(parseVoltagesKv(undefined), []);
  assert.equal(maxVoltageKv('138000;345000'), 345);
});

test('voltage colours follow the bands', () => {
  assert.equal(voltageColor(345), VOLTAGE_BANDS[0].color);
  assert.equal(voltageColor(230), VOLTAGE_BANDS[1].color);
  assert.equal(voltageColor(138), VOLTAGE_BANDS[2].color);
  assert.equal(voltageColor(69), VOLTAGE_BANDS[4].color);
  assert.equal(voltageColor(null), UNKNOWN_VOLTAGE_COLOR);
  assert.equal(voltageColor(34.5), UNKNOWN_VOLTAGE_COLOR);
});

test('bbox validation', () => {
  assert.deepEqual(parseBbox('30.2,-96.9,31,-95.9'), [30.2, -96.9, 31, -95.9]);
  assert.throws(() => parseBbox('1,2,3'));
  assert.throws(() => parseBbox('31,-96,30,-95'), /inverted/);
  assert.throws(() => parseBbox('29,-98,31,-95'), /too large/);
  assert.ok(bboxInside([30.5, -96.5, 30.7, -96.2], SNAPSHOT_BBOX));
  assert.ok(!bboxInside([29.5, -96.5, 30.7, -96.2], SNAPSHOT_BBOX));
  assert.match(buildQuery([30, -97, 31, -96]), /\(30,-97,31,-96\)/);
});

test('map data is limited to the United States', () => {
  assert.throws(() => parseBbox('51.3,-0.3,51.6,0.1'), /United States/);     // London
  assert.throws(() => parseBbox('19.2,-99.3,19.6,-98.9'), /United States/);  // Mexico City
  assert.throws(() => parseBbox('50,-123.5,50.5,-123'), /United States/);    // British Columbia
  assert.deepEqual(parseBbox('29.7,-95.45,29.8,-95.3'), [29.7, -95.45, 29.8, -95.3]); // Houston
  assert.ok(parseBbox('48.8,-123,49.3,-122.5'));  // border areas allowed; query clips to US border
  const q = buildQuery([48.8, -123, 49.3, -122.5]);
  assert.match(q, /area\["ISO3166-1"="US"\]\[admin_level=2\]->\.us/);
  for (const kind of ['substation', 'plant', 'line']) {
    assert.match(q, new RegExp(`"power"="${kind}"\\]\\(area\\.us\\)`));
  }
});

test('transmission filters', () => {
  assert.ok(isTransmissionSubstation({ power: 'substation', voltage: '138000;12470' }));
  assert.ok(isTransmissionSubstation({ power: 'substation', substation: 'transmission' }));
  assert.ok(!isTransmissionSubstation({ power: 'substation', substation: 'distribution', voltage: '138000' }));
  assert.ok(!isTransmissionSubstation({ power: 'substation', voltage: '34500' }));
  assert.ok(!isTransmissionSubstation({ power: 'substation' }));
  assert.ok(isTransmissionLine({ power: 'line', voltage: '345000' }));
  assert.ok(isTransmissionLine({ power: 'line' }));            // unknown voltage kept, drawn grey
  assert.ok(!isTransmissionLine({ power: 'line', voltage: '25000' }));
  assert.ok(!isTransmissionLine({ power: 'minor_line', voltage: '138000' }));
});

const sample = {
  elements: [
    { type: 'way', id: 1, tags: { power: 'substation', name: 'Big Sub', voltage: '345000;138000' },
      bounds: { minlat: 30, minlon: -96, maxlat: 30.002, maxlon: -95.998 },
      geometry: [{ lat: 30, lon: -96 }, { lat: 30, lon: -95.998 }, { lat: 30.002, lon: -95.998 },
        { lat: 30.002, lon: -96 }, { lat: 30, lon: -96 }] },
    { type: 'node', id: 2, lat: 30.1, lon: -96.1, tags: { power: 'substation', voltage: '12470' } },
    { type: 'node', id: 3, lat: 30.2, lon: -96.2, tags: { power: 'plant', name: 'Gas Plant', 'plant:source': 'gas' } },
    { type: 'way', id: 4, tags: { power: 'line', voltage: '138000' },
      geometry: [{ lat: 30.001, lon: -95.999 }, { lat: 30.3, lon: -96.3 }] },
    { type: 'way', id: 5, tags: { power: 'line', voltage: '12000' },
      geometry: [{ lat: 30, lon: -96 }, { lat: 30.1, lon: -96.1 }] },
    { type: 'node', id: 2, lat: 30.1, lon: -96.1, tags: { power: 'substation', voltage: '12470' } },
  ],
};

test('Overpass parsing', () => {
  const d = parseOverpass(sample);
  assert.equal(d.substations.features.length, 1);           // distribution one dropped
  const sub = d.substations.features[0].properties;
  assert.equal(sub.name, 'Big Sub');
  assert.deepEqual(sub.voltagesKv, [345, 138]);
  assert.equal(sub.maxKv, 345);
  assert.equal(sub.outline.length, 5);
  assert.equal(d.outlines.features.length, 1);
  assert.equal(d.plants.features[0].properties.source, 'gas');
  assert.equal(d.lines.features.length, 1);                 // 12 kV line dropped
  assert.equal(d.lines.features[0].properties.maxKv, 138);
});

test('fetchInfrastructure falls back to the next server', async () => {
  const calls = [];
  const fakeFetch = async url => {
    calls.push(url);
    if (calls.length === 1) return { ok: false, status: 502 };
    return { ok: true, json: async () => sample };
  };
  const d = await fetchInfrastructure([30, -97, 31, -96], { fetchImpl: fakeFetch,
    urls: ['https://a.example/api', 'https://b.example/api'] });
  assert.equal(calls.length, 2);
  assert.equal(d.substations.features.length, 1);
  await assert.rejects(fetchInfrastructure([30, -97, 31, -96], {
    fetchImpl: async () => { throw new Error('offline'); }, urls: ['https://a.example/api'] }),
    /Overpass unavailable/);
});

function fakeStorage() {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
}

test('assignments persist and a substation holds one station', () => {
  const storage = fakeStorage();
  const sub = summarizeSubstation(parseOverpass(sample).substations.features[0]);
  let a = loadAssignments(storage);
  assert.equal(a.North, null);
  a = assign(storage, a, 'North', sub);
  assert.equal(loadAssignments(storage).North.name, 'Big Sub');
  a = assign(storage, a, 'South', sub);                     // moves, not duplicates
  assert.equal(a.North, null);
  assert.equal(stationFor(a, sub.id), 'South');
  a = unassign(storage, a, 'South');
  assert.equal(loadAssignments(storage).South, null);
  assert.throws(() => assign(storage, a, 'Central', sub));
});

test('assignments survive broken storage', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(loadAssignments(broken).East, null);
  assert.deepEqual(loadPrefs(broken), { showLines: true });
  const storage = fakeStorage();
  storage.setItem('oc.assignments.v1', '{not json');
  assert.equal(loadAssignments(storage).West, null);
});

test('map prefs', () => {
  const storage = fakeStorage();
  assert.equal(loadPrefs(storage).showLines, true);
  savePrefs(storage, { showLines: false });
  assert.equal(loadPrefs(storage).showLines, false);
});

test('topology: lines touching and connecting alarmed stations', () => {
  const a = { lngLat: [-96, 30], outline: null };
  const b = { lngLat: [-96.3, 30.3], outline: null };
  const lines = [
    { properties: { id: 'ab' }, geometry: { coordinates: [[-96.001, 30.001], [-96.299, 30.299]] } },
    { properties: { id: 'a-only' }, geometry: { coordinates: [[-96, 30], [-97, 31]] } },
    { properties: { id: 'none' }, geometry: { coordinates: [[-98, 32], [-99, 33]] } },
  ];
  const { touching, connecting } = classifyLines(lines, [a, b]);
  assert.deepEqual([...connecting], ['ab']);
  assert.deepEqual([...touching].sort(), ['a-only', 'ab']);
  assert.equal(classifyLines(lines, []).touching.size, 0);
  assert.ok(Math.abs(distanceKm([-96.334, 30.628], [-96.334, 31.628]) - 111.2) < 0.5);
});

test('3D model parameters', () => {
  const generic = modelParams(null);
  assert.equal(generic.generic, true);
  assert.deepEqual(generic.levelsKv, [138, 69]);
  const big = modelParams({ id: 'way/1', name: 'Big', voltagesKv: [345, 138, 23],
    outline: [[-96, 30], [-95.998, 30], [-95.998, 30.002], [-96, 30.002], [-96, 30]] });
  assert.equal(big.bays.length, 3);
  assert.ok(big.bays[0].height > big.bays[1].height);      // 345 kV taller than 138 kV
  assert.ok(big.transformers >= 1 && big.transformers <= 3);
  assert.ok(big.yard.width >= 60 && big.yard.width <= 220);
  assert.equal(big.voltageLabel, '345 kV / 138 kV / 23 kV');
  assert.deepEqual(modelParams({ id: 'x', voltagesKv: [138] }), modelParams({ id: 'x', voltagesKv: [138] }));
  const size = outlineSizeM([[-96, 30], [-95.998, 30], [-95.998, 30.002], [-96, 30.002], [-96, 30]]);
  assert.ok(Math.abs(size.width - 192.7) < 2 && Math.abs(size.depth - 222.4) < 2);
});

test('snapshot file is valid and covers the Brazos Valley', () => {
  const snap = JSON.parse(readFileSync(new URL('../data/infra-snapshot.json', import.meta.url)));
  assert.deepEqual(snap.bbox, SNAPSHOT_BBOX);
  assert.ok(snap.substations.features.length >= 10);
  assert.ok(snap.lines.features.length >= 50);
  for (const f of snap.substations.features) {
    const [lon, lat] = f.geometry.coordinates;
    assert.ok(lat >= SNAPSHOT_BBOX[0] - 0.05 && lat <= SNAPSHOT_BBOX[2] + 0.05, f.properties.name);
    assert.ok(lon >= SNAPSHOT_BBOX[1] - 0.05 && lon <= SNAPSHOT_BBOX[3] + 0.05, f.properties.name);
  }
});
