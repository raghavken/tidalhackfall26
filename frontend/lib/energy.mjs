// Detector energy display. The FPGA reports I² + Q² where I and Q are sums of
// frequency deviations in mHz, so the raw value is in mHz². 1 Hz² = 10⁶ mHz²,
// so dividing by 10⁶ gives Hz²: the alarm threshold 2,250,000 is 2.25 Hz².

export const MHZ2_PER_HZ2 = 1e6;
export const ALARM_THRESHOLD_RAW = 2_250_000;
export const BAND_EDGES_RAW = [
  { raw: 2_250_000, label: 'alarm · mild', alarm: true },
  { raw: 9_000_000, label: 'moderate' },
  { raw: 36_000_000, label: 'severe' },
];

/** Raw detector energy (mHz²) -> Hz². */
export const toHz2 = raw => raw / MHZ2_PER_HZ2;

/** Number only, with precision scaled to size: 81.1, 4.44, 0.041, <0.001. */
export function formatHz2Value(raw) {
  const v = toHz2(raw);
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.001) return v.toFixed(3);
  return v > 0 ? '<0.001' : '0';
}

/** "81.1 Hz²" */
export const formatEnergy = raw => `${formatHz2Value(raw)} Hz²`;

/** Exact raw value for tooltips: "81,104,257 mHz² (raw I²+Q²)" */
export const rawEnergyTitle = raw => `${Math.round(raw).toLocaleString('en-US')} mHz² (raw detector I²+Q²)`;
