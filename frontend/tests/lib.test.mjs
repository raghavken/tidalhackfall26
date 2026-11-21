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
  assert.deepEqual(loadPrefs(broken), { showLines: true, categories: ['hospital', 'military', 'water', 'oil_gas'] });
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

// -- pre-downloaded regions ------------------------------------------------------
import { existsSync } from 'node:fs';
import { REGIONS, regionFor, regionFile, regionById } from '../lib/regions.mjs';

test('region list is valid and US-only', () => {
  const ids = REGIONS.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(REGIONS.slice(0, 4).map(r => r.group), Array(4).fill('South Texas')); // South Texas first
  for (const r of REGIONS) assert.deepEqual(parseBbox(r.bbox), r.bbox, r.id); // in US, <= 1.5 degrees
  assert.equal(regionFile(regionById('brazos-valley')), 'infra-snapshot.json');
  assert.equal(regionFile(regionById('houston')), 'regions/houston.json');
});

test('regionFor picks the region that covers the view', () => {
  const inHouston = [29.70, -95.45, 29.80, -95.30];
  assert.equal(regionFor(inHouston).region.id, 'houston');
  assert.equal(regionFor(inHouston).contained, true);
  const mostlyHouston = [29.40, -95.60, 29.90, -95.10];           // spills past the south edge
  assert.equal(regionFor(mostlyHouston).region.id, 'houston');
  assert.equal(regionFor(mostlyHouston).contained, false);
  assert.equal(regionFor([35.0, -101.9, 35.3, -101.6]), null);     // Amarillo: not pre-loaded
  assert.equal(regionFor(inHouston, { available: ['austin'] }), null); // file missing -> no match
});

test('border regions clip to the US; interior ones can skip it', () => {
  assert.ok(REGIONS.find(r => r.id === 'laredo').border);
  const q = buildQuery([29.7, -95.45, 29.8, -95.3], { usBorder: false, timeoutS: 200 });
  assert.doesNotMatch(q, /area\.us/);
  assert.match(q, /\[timeout:200\]/);
});

test('downloaded region files are valid', () => {
  for (const r of REGIONS) {
    const url = new URL(`../data/${regionFile(r)}`, import.meta.url);
    if (!existsSync(url)) continue; // not downloaded yet
    const data = JSON.parse(readFileSync(url));
    assert.ok(data.substations.features.length > 0, r.id);
    for (const f of data.substations.features) {
      const [lon, lat] = f.geometry.coordinates;
      assert.ok(lat >= r.bbox[0] - 0.05 && lat <= r.bbox[2] + 0.05 && lon >= r.bbox[1] - 0.05 &&
        lon <= r.bbox[3] + 0.05, `${r.id}: ${f.properties.name}`);
    }
  }
});

// -- Phase 2: critical facilities --------------------------------------------------
import { CATEGORIES, attributeFacilities, buildFacilitiesQuery, categorize, criticality, describeImpact,
  isMajorPipeline, parseFacilities } from '../lib/critical.mjs';

test('facility categories', () => {
  assert.equal(CATEGORIES.length, 8);
  assert.equal(categorize({ amenity: 'hospital' }), 'hospital');
  assert.equal(categorize({ landuse: 'military' }), 'military');
  assert.equal(categorize({ military: 'base' }), 'military');
  assert.equal(categorize({ military: 'bunker' }), null);                 // minor military features skipped
  assert.equal(categorize({ man_made: 'wastewater_plant' }), 'water');
  assert.equal(categorize({ industrial: 'refinery' }), 'oil_gas');
  assert.equal(categorize({ amenity: 'police' }), 'emergency');
  assert.equal(categorize({ aeroway: 'aerodrome', iata: 'CLL' }), 'airport');
  assert.equal(categorize({ aeroway: 'aerodrome', 'aerodrome:type': 'private' }), null); // private strip
  assert.equal(categorize({ telecom: 'data_center' }), 'data_center');
  assert.equal(categorize({ amenity: 'university', name: 'Texas A&M University' }), 'university');
  assert.ok(isMajorPipeline({ man_made: 'pipeline', substance: 'gas', operator: 'Enterprise' }));
  assert.ok(!isMajorPipeline({ man_made: 'pipeline', substance: 'gas' }));      // unnamed: not major
  assert.ok(!isMajorPipeline({ man_made: 'pipeline', substance: 'water', name: 'X' }));
  const q = buildFacilitiesQuery([30, -97, 31, -96], { usBorder: false });
  assert.doesNotMatch(q, /area\.us/);
  assert.match(q, /hospital/);
  assert.match(buildFacilitiesQuery([30, -97, 31, -96]), /\(area\.us\)/);
});

const subs = [
  { properties: { id: 'node/1', name: 'Alpha' }, geometry: { coordinates: [-96.30, 30.60] } },
  { properties: { id: 'node/2', name: 'Bravo' }, geometry: { coordinates: [-96.00, 30.60] } },
];
const fac = (id, category, lon, lat, name = null) =>
  ({ properties: { id, category, name }, geometry: { coordinates: [lon, lat] } });

test('facilities attribute to the nearest substation within 10 km, once each', () => {
  const facilities = [
    fac('h1', 'hospital', -96.29, 30.61, 'St. Joseph'),        // ~1.5 km from Alpha
    fac('h2', 'hospital', -96.02, 30.60),                      // ~2 km from Bravo
    fac('u1', 'university', -96.28, 30.59, 'Texas A&M University'),
    fac('far', 'water', -97.50, 31.50),                        // > 10 km from both
  ];
  const { bySubstation, attributedTo } = attributeFacilities(facilities, subs);
  assert.equal(attributedTo.get('h1'), 'node/1');
  assert.equal(attributedTo.get('h2'), 'node/2');
  assert.equal(attributedTo.has('far'), false);
  assert.equal(bySubstation.get('node/1').score, 5 + 2);      // hospital + university weights
  assert.equal(bySubstation.get('node/2').score, 5);
  assert.equal(describeImpact(bySubstation.get('node/1')), '1 hospital, Texas A&M University');
  assert.equal(describeImpact(undefined), '');
  const c = criticality({ substations: { features: subs }, facilities: { features: facilities } });
  assert.equal(c.halos.features.length, 2);
  assert.equal(c.attributionLines.features.length, 3);
  assert.equal(c.nearestOf.get('u1'), 'Alpha');
  assert.equal(criticality({ substations: { features: subs } }).halos.features.length, 0); // no facility data
});

test('Overpass facility parsing', () => {
  const d = parseFacilities({ elements: [
    { type: 'way', id: 9, center: { lat: 30.6, lon: -96.3 }, tags: { amenity: 'hospital', name: 'H' } },
    { type: 'node', id: 10, lat: 30.6, lon: -96.3, tags: { amenity: 'cafe' } },
    { type: 'way', id: 11, tags: { man_made: 'pipeline', substance: 'gas', operator: 'Op' },
      geometry: [{ lat: 30, lon: -96 }, { lat: 30.1, lon: -96.1 }] },
    { type: 'way', id: 9, center: { lat: 30.6, lon: -96.3 }, tags: { amenity: 'hospital', name: 'H' } },
  ] });
  assert.equal(d.facilities.features.length, 1);
  assert.equal(d.facilities.features[0].properties.category, 'hospital');
  assert.equal(d.pipelines.features.length, 1);
});

test('facility category prefs persist', () => {
  const storage = fakeStorage();
  savePrefs(storage, { showLines: true, categories: ['hospital', 'airport', 'nonsense'] });
  assert.deepEqual(loadPrefs(storage).categories, ['hospital', 'airport']);
});

// -- Nemotron report formatting -----------------------------------------------------
import { inlineSegments, parseReport } from '../lib/reportFormat.mjs';

test('Nemotron text becomes structured report blocks', () => {
  const text = `Assessment:
A sustained 0.25 Hz oscillation is present at North and South.
The stations move in opposite phase.

Key measurements:
- North: energy 80,974,778 (severe)
- South: energy 4,416,674 (mild)

**Recommended follow-up**
1. Request a longer window.
2. Compare damping.`;
  const blocks = parseReport(text);
  assert.deepEqual(blocks.map(b => b.type), ['h', 'p', 'h', 'list', 'h', 'list']);
  assert.equal(blocks[0].text, 'Assessment');
  assert.equal(blocks[1].text, 'A sustained 0.25 Hz oscillation is present at North and South. The stations move in opposite phase.');
  assert.equal(blocks[3].ordered, false);
  assert.equal(blocks[3].items.length, 2);
  assert.equal(blocks[4].text, 'Recommended follow-up');
  assert.equal(blocks[5].ordered, true);
  assert.deepEqual(parseReport('Just one plain sentence.'), [{ type: 'p', text: 'Just one plain sentence.' }]);
  assert.deepEqual(parseReport(''), []);
  assert.deepEqual(inlineSegments('North is **severe** now'),
    [{ text: 'North is ', bold: false }, { text: 'severe', bold: true }, { text: ' now', bold: false }]);
});

// -- energy display ----------------------------------------------------------------
import { formatEnergy, toHz2, rawEnergyTitle, ALARM_THRESHOLD_RAW } from '../lib/energy.mjs';

test('detector energy shown in Hz² (raw mHz² ÷ 10⁶)', () => {
  assert.equal(toHz2(ALARM_THRESHOLD_RAW), 2.25);
  assert.equal(formatEnergy(2_250_000), '2.25 Hz²');
  assert.equal(formatEnergy(81_104_257), '81.1 Hz²');
  assert.equal(formatEnergy(4_443_970), '4.44 Hz²');
  assert.equal(formatEnergy(150_000_000), '150 Hz²');
  assert.equal(formatEnergy(40_925), '0.041 Hz²');
  assert.equal(formatEnergy(52), '<0.001 Hz²');
  assert.equal(formatEnergy(0), '0 Hz²');
  assert.equal(rawEnergyTitle(81_104_257), '81,104,257 mHz² (raw detector I²+Q²)');
});
