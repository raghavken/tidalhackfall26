// Which transmission line segments touch which assigned stations.
// OSM lines usually end inside a substation's fence, so we treat a line as
// touching a station when one of its endpoints is within `toleranceKm` of the
// station's centre, or inside its outline's bounding box.

const EARTH_KM = 6371;

export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

function outlineBox(outline) {
  if (!outline?.length) return null;
  const xs = outline.map(p => p[0]);
  const ys = outline.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function near(point, station, toleranceKm) {
  if (distanceKm(point, station.lngLat) <= toleranceKm) return true;
  const box = outlineBox(station.outline);
  return Boolean(box && point[0] >= box[0] && point[0] <= box[2] &&
    point[1] >= box[1] && point[1] <= box[3]);
}

/**
 * Classify line features against the alarmed stations (substation summaries).
 * Returns { touching, connecting } Sets of line ids: `touching` lines have at
 * least one end at an alarmed station; `connecting` lines have their two ends
 * at two different alarmed stations.
 */
export function classifyLines(lineFeatures, stations, toleranceKm = 0.6) {
  const touching = new Set();
  const connecting = new Set();
  if (!stations.length) return { touching, connecting };
  for (const line of lineFeatures) {
    const coords = line.geometry.coordinates;
    const ends = [coords[0], coords[coords.length - 1]];
    const hits = ends.map(end => stations.findIndex(s => near(end, s, toleranceKm)));
    if (hits.some(i => i >= 0)) touching.add(line.properties.id);
    if (hits[0] >= 0 && hits[1] >= 0 && hits[0] !== hits[1]) connecting.add(line.properties.id);
  }
  return { touching, connecting };
}
