/**
 * Outbound integrations for map data. Everything the browser needs from
 * OpenStreetMap goes through here so we can (a) send a proper User-Agent,
 * (b) honour Nominatim's 1-request-per-second policy from a single queue,
 * (c) cache aggressively — a carful of people searching "coffee" should hit
 * the network once — and (d) fall back when a public endpoint is down.
 */

const UA = 'betterMaps/0.1 (road-trip planner; https://github.com/local/bettermaps)';

// ---------------------------------------------------------------- cache

interface CacheEntry {
  expires: number;
  value: unknown;
}
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 500;

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  if (cache.size >= CACHE_MAX) {
    // drop the oldest insertion — Map preserves insertion order
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expires: Date.now() + ttlMs, value });
}

// ---------------------------------------------------------------- rate limit

let nominatimChain: Promise<unknown> = Promise.resolve();
const NOMINATIM_GAP_MS = 1100;
let lastNominatimAt = 0;

/** Serialises Nominatim calls with >=1.1s spacing, as their usage policy requires. */
function queueNominatim<T>(task: () => Promise<T>): Promise<T> {
  const run = nominatimChain.then(async () => {
    const wait = lastNominatimAt + NOMINATIM_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();
    return task();
  });
  // keep the chain alive even if this task rejects
  nominatimChain = run.catch(() => undefined);
  return run;
}

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
    const text = await res.text();
    if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
      throw new Error(`${new URL(url).host} returned non-JSON (likely rate limited)`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- categories

export interface CategoryDef {
  key: string;
  label: string;
  icon: string;
  /** OSM tag filters used for Overpass nearby search. */
  osm: string[];
  /** Free-text used for the Nominatim fallback. */
  query: string;
  /** Typical spend per person, in cents — a starting estimate people can edit. */
  typicalCents: number;
  priceLevel: number;
}

export const CATEGORIES: CategoryDef[] = [
  { key: 'fast_food', label: 'Fast food', icon: '🍔', osm: ['amenity=fast_food'], query: 'fast food', typicalCents: 1200, priceLevel: 1 },
  { key: 'restaurant', label: 'Restaurants', icon: '🍽️', osm: ['amenity=restaurant'], query: 'restaurant', typicalCents: 2800, priceLevel: 2 },
  { key: 'cafe', label: 'Coffee', icon: '☕', osm: ['amenity=cafe'], query: 'cafe coffee', typicalCents: 650, priceLevel: 1 },
  { key: 'fuel', label: 'Gas', icon: '⛽', osm: ['amenity=fuel'], query: 'gas station', typicalCents: 5500, priceLevel: 2 },
  { key: 'charging', label: 'EV charging', icon: '🔌', osm: ['amenity=charging_station'], query: 'ev charging station', typicalCents: 1800, priceLevel: 1 },
  { key: 'restroom', label: 'Restrooms', icon: '🚻', osm: ['amenity=toilets'], query: 'public toilets', typicalCents: 0, priceLevel: 0 },
  { key: 'rest_area', label: 'Rest stops', icon: '🅿️', osm: ['highway=rest_area', 'highway=services'], query: 'rest area', typicalCents: 0, priceLevel: 0 },
  { key: 'viewpoint', label: 'Viewpoints', icon: '🏞️', osm: ['tourism=viewpoint'], query: 'scenic viewpoint', typicalCents: 0, priceLevel: 0 },
  { key: 'attraction', label: 'Attractions', icon: '🎡', osm: ['tourism=attraction', 'tourism=museum'], query: 'tourist attraction', typicalCents: 1500, priceLevel: 2 },
  { key: 'park', label: 'Parks', icon: '🌳', osm: ['leisure=park', 'boundary=national_park'], query: 'park', typicalCents: 0, priceLevel: 0 },
  { key: 'lodging', label: 'Stay', icon: '🛏️', osm: ['tourism=hotel', 'tourism=motel', 'tourism=camp_site'], query: 'hotel motel', typicalCents: 12000, priceLevel: 3 },
  { key: 'grocery', label: 'Groceries', icon: '🛒', osm: ['shop=supermarket', 'shop=convenience'], query: 'supermarket', typicalCents: 2500, priceLevel: 1 },
];

const CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
export const categoryDef = (key: string) => CATEGORY_BY_KEY.get(key);

/** Maps an OSM tag set (or Nominatim class/type) onto one of our categories. */
function classify(tags: Record<string, string | undefined>): string {
  const probe = [
    `amenity=${tags.amenity}`, `tourism=${tags.tourism}`, `shop=${tags.shop}`,
    `leisure=${tags.leisure}`, `highway=${tags.highway}`, `boundary=${tags.boundary}`,
  ];
  for (const cat of CATEGORIES) {
    if (cat.osm.some((f) => probe.includes(f))) return cat.key;
  }
  if (tags.amenity === 'bar' || tags.amenity === 'pub') return 'restaurant';
  if (tags.shop) return 'grocery';
  if (tags.tourism) return 'attraction';
  return 'other';
}

// ---------------------------------------------------------------- results

export interface PlaceResult {
  ref: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  category: string;
  /** 0-100 from Nominatim `importance` / OSM notability tags. Not a review score. */
  prominence: number | null;
  priceLevel: number | null;
  estCostCents: number | null;
  /** Useful OSM tags worth surfacing: cuisine, drive-through, hours, etc. */
  tags: Record<string, string>;
}

function priceFor(category: string, tags: Record<string, string | undefined>) {
  const def = categoryDef(category);
  let level = def?.priceLevel ?? null;
  let cents = def?.typicalCents ?? null;
  // hotels sometimes carry a star rating we can use to nudge the estimate
  const stars = Number(tags.stars);
  if (category === 'lodging' && Number.isFinite(stars) && stars > 0) {
    level = Math.max(1, Math.min(4, Math.round(stars)));
    cents = 5000 + stars * 4000;
  }
  return { level, cents };
}

const KEEP_TAGS = [
  'cuisine', 'opening_hours', 'drive_through', 'takeaway', 'outdoor_seating',
  'brand', 'wheelchair', 'internet_access', 'fuel:diesel', 'stars', 'phone', 'website',
];

function pickTags(tags: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEEP_TAGS) {
    const v = tags[k];
    if (v) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- geocoding

interface NominatimPlace {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  importance?: number;
  class?: string;
  type?: string;
  address?: Record<string, string>;
  extratags?: Record<string, string> | null;
  namedetails?: Record<string, string> | null;
}

function fromNominatim(p: NominatimPlace): PlaceResult {
  const tags: Record<string, string | undefined> = {
    ...(p.extratags ?? {}),
    [p.class ?? 'x']: p.type,
  };
  const category = classify(tags);
  const { level, cents } = priceFor(category, tags);
  const label = p.name?.trim() || p.namedetails?.name?.trim() || p.display_name.split(',')[0];
  const rest = p.display_name.startsWith(label)
    ? p.display_name.slice(label.length).replace(/^,\s*/, '')
    : p.display_name;
  return {
    ref: p.osm_type && p.osm_id ? `${p.osm_type[0]}${p.osm_id}` : `p${p.place_id}`,
    name: label,
    address: rest || null,
    lat: Number(p.lat),
    lng: Number(p.lon),
    category,
    prominence: p.importance != null ? Math.round(Math.min(1, p.importance * 1.6) * 100) : null,
    priceLevel: level,
    estCostCents: cents,
    tags: pickTags(tags),
  };
}

interface SearchOpts {
  /** Bias ranking toward this point without excluding anything else. */
  near?: { lat: number; lng: number };
  /** Hard-limit results to a box this many metres around `near`. */
  withinM?: number;
  limit?: number;
}

/**
 * Free-text search. With `withinM` we hand Nominatim `bounded=1` so it filters
 * server-side — post-filtering a globally-ranked result set throws almost
 * everything away and often leaves nothing.
 */
export async function searchPlaces(q: string, opts: SearchOpts = {}): Promise<PlaceResult[]> {
  const { near, withinM, limit = 12 } = opts;
  const key = `search:${q}:${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : 'global'}:${withinM ?? 0}:${limit}`;
  const hit = cacheGet<PlaceResult[]>(key);
  if (hit) return hit;

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('extratags', '1');
  url.searchParams.set('namedetails', '1');

  if (near) {
    // Without withinM: ~1.4° (≈150km) of ranking bias — wide enough to catch the
    // next town, tight enough that local results win.
    const latDeg = withinM ? withinM / 111_320 : 1.4;
    const lngDeg = withinM
      ? withinM / (111_320 * Math.max(0.15, Math.cos((near.lat * Math.PI) / 180)))
      : 1.4;
    url.searchParams.set(
      'viewbox',
      [near.lng - lngDeg, near.lat + latDeg, near.lng + lngDeg, near.lat - latDeg]
        .map((n) => n.toFixed(6)).join(','),
    );
    if (withinM) url.searchParams.set('bounded', '1');
  }

  const raw = await queueNominatim(() => fetchJson<NominatimPlace[]>(url.toString()));
  const results = raw.map(fromNominatim);
  cacheSet(key, results, 10 * 60_000);
  return results;
}

export async function reverseGeocode(lat: number, lng: number): Promise<PlaceResult | null> {
  const key = `rev:${lat.toFixed(5)},${lng.toFixed(5)}`;
  const hit = cacheGet<PlaceResult | null>(key);
  if (hit !== undefined) return hit;

  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('extratags', '1');

  try {
    const raw = await queueNominatim(() => fetchJson<NominatimPlace>(url.toString()));
    const result = raw?.lat ? fromNominatim(raw) : null;
    cacheSet(key, result, 60 * 60_000);
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- nearby POIs

/** Mirrors in preference order. The canonical overpass-api.de host is the most
 *  heavily loaded and 504s regularly, so it sits last. */
const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
/** Overpass mirrors go down or throttle often; give up fast and fall back. */
const OVERPASS_TIMEOUT_MS = 7_000;

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function overpassNearby(
  cat: CategoryDef, lat: number, lng: number, radiusM: number,
): Promise<PlaceResult[]> {
  const filters = cat.osm
    .map((f) => {
      const [k, v] = f.split('=');
      return `nwr["${k}"="${v}"](around:${radiusM},${lat},${lng});`;
    })
    .join('\n');
  const query = `[out:json][timeout:6];(\n${filters}\n);out tags center 60;`;

  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const data = await fetchJson<{ elements: OverpassElement[] }>(
        endpoint,
        {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
        OVERPASS_TIMEOUT_MS,
      );
      return (data.elements ?? [])
        .map((el): PlaceResult | null => {
          const plat = el.lat ?? el.center?.lat;
          const plng = el.lon ?? el.center?.lon;
          const tags = el.tags ?? {};
          const name = tags.name ?? tags.brand ?? tags.operator;
          if (plat == null || plng == null || !name) return null;
          const { level, cents } = priceFor(cat.key, tags);
          const notable = (tags.wikidata ? 25 : 0) + (tags.brand ? 15 : 0) + (tags.website ? 5 : 0);
          return {
            ref: `${el.type[0]}${el.id}`,
            name,
            address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']]
              .filter(Boolean).join(' ') || null,
            lat: plat,
            lng: plng,
            category: cat.key,
            prominence: notable || null,
            priceLevel: level,
            estCostCents: cents,
            tags: pickTags(tags),
          };
        })
        .filter((p): p is PlaceResult => p !== null);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('all Overpass mirrors failed');
}

export interface NearbyResponse {
  results: PlaceResult[];
  source: 'overpass' | 'nominatim';
  degraded: boolean;
  note?: string;
}

/**
 * Category search around a point. Overpass gives far better coverage of
 * un-notable roadside places, so we try it first, but a road trip cannot
 * wait on a flaky mirror — after {@link OVERPASS_TIMEOUT_MS} we serve the
 * Nominatim bounded search instead and flag the response as degraded.
 */
export async function nearbyPlaces(
  categoryKey: string, lat: number, lng: number, radiusM = 8000,
): Promise<NearbyResponse> {
  const cat = categoryDef(categoryKey);
  if (!cat) throw Object.assign(new Error(`unknown category "${categoryKey}"`), { status: 400 });

  const key = `near:${categoryKey}:${lat.toFixed(3)},${lng.toFixed(3)}:${radiusM}`;
  const hit = cacheGet<NearbyResponse>(key);
  if (hit) return hit;

  let response: NearbyResponse;
  try {
    const results = await overpassNearby(cat, lat, lng, radiusM);
    response = { results, source: 'overpass', degraded: false };
  } catch (err) {
    // Widen the box a little: the fallback has far sparser coverage, so an exact
    // radius match would often come back empty on a rural highway.
    const results = await searchPlaces(cat.query, {
      near: { lat, lng },
      withinM: Math.max(radiusM * 1.5, 15_000),
      limit: 25,
    });
    response = {
      results: results.map((p) => ({ ...p, category: p.category === 'other' ? cat.key : p.category })),
      source: 'nominatim',
      degraded: true,
      note:
        `Detailed POI search is busy (${(err as Error).message}). ` +
        'Showing named places only — try again shortly for full coverage.',
    };
  }
  cacheSet(key, response, response.degraded ? 3 * 60_000 : 10 * 60_000);
  return response;
}

// ---------------------------------------------------------------- routing

export interface RouteLeg {
  distanceM: number;
  durationS: number;
}
export interface RouteResult {
  distanceM: number;
  durationS: number;
  legs: RouteLeg[];
  /** [lat, lng] pairs, ready for Leaflet. */
  geometry: Array<[number, number]>;
}

/** OSRM ships encoded polylines at 1e5 precision. */
function decodePolyline(str: string): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, byte: number;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

export async function routeThrough(
  points: Array<{ lat: number; lng: number }>,
): Promise<RouteResult> {
  if (points.length < 2) throw Object.assign(new Error('need at least 2 points'), { status: 400 });
  if (points.length > 25) throw Object.assign(new Error('too many waypoints (max 25)'), { status: 400 });

  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const key = `route:${coords}`;
  const hit = cacheGet<RouteResult>(key);
  if (hit) return hit;

  const url =
    `https://router.project-osrm.org/route/v1/driving/${coords}` +
    '?overview=full&geometries=polyline&annotations=false';
  const data = await fetchJson<{
    code: string;
    routes?: Array<{
      distance: number;
      duration: number;
      geometry: string;
      legs?: Array<{ distance: number; duration: number }>;
    }>;
  }>(url, {}, 15_000);

  const route = data.routes?.[0];
  if (data.code !== 'Ok' || !route) throw new Error(`no route found (${data.code})`);

  const result: RouteResult = {
    distanceM: route.distance,
    durationS: route.duration,
    legs: (route.legs ?? []).map((l) => ({ distanceM: l.distance, durationS: l.duration })),
    geometry: decodePolyline(route.geometry),
  };
  cacheSet(key, result, 30 * 60_000);
  return result;
}
