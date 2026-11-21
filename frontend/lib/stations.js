// Shared station identity. The simulator/backend name stations North/East/
// South/West; the interface labels them 1–4. Colours are restrained trace
// colours (red and amber are reserved for warnings and faults).
export const STATION_NAMES = ['North', 'East', 'South', 'West'];
export const STATION_LABEL = { North: '1', East: '2', South: '3', West: '4' };
export const STATION_COLORS = { North: '#60A5FA', East: '#4FD1C5', South: '#C4A7E7', West: '#D4D4D8' };
export const SEVERITY_ORDER = ['normal', 'mild', 'moderate', 'severe'];

/** "Station 1" etc. */
export const stationTitle = name => `Station ${STATION_LABEL[name] ?? name}`;
