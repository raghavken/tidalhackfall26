// Voltage tag parsing and the voltage colour scale used on the map.

/**
 * Parse an OSM `voltage` tag into kV values, highest first.
 * OSM uses volts ("138000;69000"); values under 1000 are treated as kV already.
 * Junk entries are skipped. Returns [] when nothing usable is found.
 */
export function parseVoltagesKv(tag) {
  if (tag === undefined || tag === null) return [];
  const values = String(tag)
    .split(/[;,]/)
    .map(part => Number.parseFloat(part.replace(/[^0-9.]/g, '')))
    .filter(v => Number.isFinite(v) && v > 0)
    .map(v => (v >= 1000 ? v / 1000 : v))
    .map(v => Math.round(v * 10) / 10);
  return [...new Set(values)].sort((a, b) => b - a);
}

export function maxVoltageKv(tag) {
  return parseVoltagesKv(tag)[0] ?? null;
}

// Colour bands (OpenInfraMap-like). Order matters: first match wins.
export const VOLTAGE_BANDS = [
  { minKv: 300, label: '345 kV', color: '#b26bff' },
  { minKv: 200, label: '230 kV', color: '#4f8cff' },
  { minKv: 130, label: '138 kV', color: '#ff4d5e' },
  { minKv: 100, label: '115 kV', color: '#ff6d3a' },
  { minKv: 60, label: '69 kV', color: '#ffa13d' },
];
export const UNKNOWN_VOLTAGE_COLOR = '#7d8a9c';

export function voltageColor(kv) {
  if (kv === null || kv === undefined || !Number.isFinite(kv)) return UNKNOWN_VOLTAGE_COLOR;
  return (VOLTAGE_BANDS.find(band => kv >= band.minKv) || { color: UNKNOWN_VOLTAGE_COLOR }).color;
}

/** MapLibre expression version of voltageColor for the `maxKv` feature property. */
export function voltageColorExpression() {
  const expr = ['case', ['!', ['has', 'maxKv']], UNKNOWN_VOLTAGE_COLOR];
  for (const band of VOLTAGE_BANDS) expr.push(['>=', ['get', 'maxKv'], band.minKv], band.color);
  expr.push(UNKNOWN_VOLTAGE_COLOR);
  return expr;
}

/** Line width grows with voltage: ~1.4 px at 69 kV up to ~2.6 px at 345 kV. */
export function voltageWidthExpression() {
  return ['interpolate', ['linear'], ['coalesce', ['get', 'maxKv'], 60],
    60, 1.4, 138, 1.8, 345, 2.6];
}
