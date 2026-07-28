export interface LatLng {
  lat: number;
  lng: number;
}

const R_EARTH_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, in degrees clockwise from north. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Extra straight-line distance added by visiting `via` between `from` and `to`.
 * This is what actually matters on a road trip: a taco place two miles off the
 * highway beats one that is closer as the crow flies but backwards.
 * Returns metres; 0 means the stop is effectively free (already on the way).
 */
export function detourM(from: LatLng, via: LatLng, to: LatLng): number {
  const direct = distanceM(from, to);
  const viaStop = distanceM(from, via) + distanceM(via, to);
  return Math.max(0, viaStop - direct);
}

/** Interpolates along a polyline by fraction (0-1) of total length. */
export function pointAlong(
  path: Array<[number, number]>,
  fraction: number,
): { point: LatLng; heading: number } | null {
  if (path.length < 2) return null;
  const segments: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = distanceM(
      { lat: path[i - 1][0], lng: path[i - 1][1] },
      { lat: path[i][0], lng: path[i][1] },
    );
    segments.push(d);
    total += d;
  }
  if (total === 0) return null;

  let target = Math.max(0, Math.min(1, fraction)) * total;
  for (let i = 0; i < segments.length; i++) {
    if (target > segments[i]) {
      target -= segments[i];
      continue;
    }
    const a = { lat: path[i][0], lng: path[i][1] };
    const b = { lat: path[i + 1][0], lng: path[i + 1][1] };
    const t = segments[i] === 0 ? 0 : target / segments[i];
    return {
      point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
      heading: bearingDeg(a, b),
    };
  }
  const last = path[path.length - 1];
  const prev = path[path.length - 2];
  return {
    point: { lat: last[0], lng: last[1] },
    heading: bearingDeg({ lat: prev[0], lng: prev[1] }, { lat: last[0], lng: last[1] }),
  };
}

// ---------------------------------------------------------------- formatting

const MI_PER_M = 0.000621371;

export function formatDistance(metres: number, imperial = true): string {
  if (!Number.isFinite(metres)) return '—';
  if (imperial) {
    const miles = metres * MI_PER_M;
    if (miles < 0.19) return `${Math.round(metres * 3.28084 / 10) * 10} ft`;
    if (miles < 10) return `${miles.toFixed(1)} mi`;
    return `${Math.round(miles)} mi`;
  }
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Rough drive time with no routing call — good enough for list badges. */
const ASSUMED_ROAD_SPEED_MPS = 24.6; // ~55 mph, plus the usual detour factor below
export function estimateDriveSeconds(straightLineM: number): number {
  return (straightLineM * 1.25) / ASSUMED_ROAD_SPEED_MPS;
}

export function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return cents % 100 === 0
    ? `$${(cents / 100).toFixed(0)}`
    : `$${(cents / 100).toFixed(2)}`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatEta(seconds: number): string {
  const at = new Date(Date.now() + seconds * 1000);
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function priceGlyph(level: number | null | undefined): string {
  if (level == null) return '—';
  return level === 0 ? 'Free' : '$'.repeat(Math.min(4, level));
}

/**
 * Turn-by-turn handoff. We don't reinvent navigation — the phone already has a
 * good one. Google's universal URL opens the native app on Android and iOS and
 * falls back to the web map on desktop.
 */
export function navigationUrl(dest: LatLng): string {
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', `${dest.lat.toFixed(6)},${dest.lng.toFixed(6)}`);
  url.searchParams.set('travelmode', 'driving');
  return url.toString();
}

export function boundsOf(points: LatLng[]): [[number, number], [number, number]] | null {
  if (!points.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  // pad degenerate single-point bounds so fitBounds doesn't zoom to the max
  if (maxLat - minLat < 0.01) { minLat -= 0.005; maxLat += 0.005; }
  if (maxLng - minLng < 0.01) { minLng -= 0.005; maxLng += 0.005; }
  return [[minLat, minLng], [maxLat, maxLng]];
}
