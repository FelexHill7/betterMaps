import { rankStops, metricsFor, primaryBadge, type SortContext } from './sorting.ts';
import { distanceM, detourM, formatDistance, formatDuration, formatMoney, pointAlong, boundsOf } from './geo.ts';
import type { Stop } from './types.ts';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  PASS', label); }
  else { fail++; console.log('  FAIL', label, extra); }
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// Phoenix -> Flagstaff corridor. Real coordinates so the numbers are checkable.
const PHOENIX = { lat: 33.4484, lng: -112.0740 };
const FLAGSTAFF = { lat: 35.1983, lng: -111.6513 };

let n = 0;
function stop(over: Partial<Stop>): Stop {
  n += 1;
  return {
    id: `s${n}`, trip_id: 't', name: `Stop ${n}`, category: 'fast_food', address: null,
    lat: 34, lng: -112, order_index: n, status: 'queued',
    price_level: null, est_cost_cents: null, rating: null, rating_count: null,
    notes: null, source: 'search', external_ref: null, added_by: 'u1',
    created_at: 1000 + n, arrived_at: null, up_votes: 0, down_votes: 0, voters: '',
    ...over,
  };
}

const ctx = (over: Partial<SortContext> = {}): SortContext => ({
  me: PHOENIX, dest: FLAGSTAFF, typicalCents: { fast_food: 1200, viewpoint: 0, restaurant: 2800 },
  ...over,
});

console.log('\n== geo primitives ==');
// Phoenix -> Flagstaff is ~195 km straight line
ok('haversine Phoenix->Flagstaff ~196km', near(distanceM(PHOENIX, FLAGSTAFF), 196_000, 4_000),
  String(Math.round(distanceM(PHOENIX, FLAGSTAFF))));
ok('distance is symmetric', distanceM(PHOENIX, FLAGSTAFF) === distanceM(FLAGSTAFF, PHOENIX));
ok('zero distance to self', distanceM(PHOENIX, PHOENIX) === 0);

// A point exactly on the line adds no detour; one far off-axis adds a lot.
const midway = { lat: 34.32, lng: -111.86 };
ok('on-route point ~zero detour', detourM(PHOENIX, midway, FLAGSTAFF) < 3_000,
  String(Math.round(detourM(PHOENIX, midway, FLAGSTAFF))));
const wayOff = { lat: 34.32, lng: -114.5 };
ok('off-route point has big detour', detourM(PHOENIX, wayOff, FLAGSTAFF) > 100_000,
  String(Math.round(detourM(PHOENIX, wayOff, FLAGSTAFF))));
ok('detour never negative', detourM(PHOENIX, FLAGSTAFF, FLAGSTAFF) >= 0);
// A stop behind you costs roughly double the backtrack
const behind = { lat: 33.0, lng: -112.2 };
ok('backwards stop costs ~2x the backtrack',
  near(detourM(PHOENIX, behind, FLAGSTAFF), 2 * distanceM(PHOENIX, behind), 12_000),
  `${Math.round(detourM(PHOENIX, behind, FLAGSTAFF))} vs ${Math.round(2 * distanceM(PHOENIX, behind))}`);

console.log('\n== formatting ==');
ok('feet under a fifth of a mile', formatDistance(150, true).endsWith('ft'), formatDistance(150, true));
ok('one decimal under 10mi', formatDistance(8000, true) === '5.0 mi', formatDistance(8000, true));
ok('whole miles above 10', formatDistance(80_000, true) === '50 mi', formatDistance(80_000, true));
ok('metric km', formatDistance(8000, false) === '8.0 km', formatDistance(8000, false));
ok('duration h+m', formatDuration(5040) === '1h 24m', formatDuration(5040));
ok('duration mins', formatDuration(600) === '10 min', formatDuration(600));
ok('sub-minute', formatDuration(20) === '<1 min', formatDuration(20));
ok('money whole dollars', formatMoney(1200) === '$12', formatMoney(1200));
ok('money with cents', formatMoney(1250) === '$12.50', formatMoney(1250));
ok('null money', formatMoney(null) === '—');

console.log('\n== nearest ==');
const close = stop({ name: 'Close', lat: 33.55, lng: -112.05 });
const mid = stop({ name: 'Mid', lat: 34.30, lng: -111.90 });
const far = stop({ name: 'Far', lat: 35.10, lng: -111.70 });
let order = rankStops([far, close, mid], 'nearest', ctx()).map((r) => r.stop.name);
ok('nearest orders by distance', order.join() === 'Close,Mid,Far', order.join());

console.log('\n== detour ==');
// OffRoute is genuinely closer in a straight line (~86km vs ~130km) but sits
// sideways off the corridor, so visiting it costs ~116km extra versus ~2km.
// This is the case the whole detour sort exists for.
const offRoute = stop({ name: 'OffRoute', lat: 33.50, lng: -113.00 });
const onRoute = stop({ name: 'OnRoute', lat: 34.60, lng: -111.80 });
ok('  premise: OffRoute really is nearer',
  distanceM(PHOENIX, { lat: 33.50, lng: -113.00 }) < distanceM(PHOENIX, { lat: 34.60, lng: -111.80 }));
order = rankStops([offRoute, onRoute], 'detour', ctx()).map((r) => r.stop.name);
ok('detour prefers on-route over merely close', order[0] === 'OnRoute', order.join());
ok('  and nearest disagrees, as it should',
  rankStops([offRoute, onRoute], 'nearest', ctx())[0].stop.name === 'OffRoute');
// with no destination, detour degrades to distance rather than breaking
order = rankStops([far, close], 'detour', ctx({ dest: null })).map((r) => r.stop.name);
ok('detour falls back to distance with no dest', order.join() === 'Close,Far', order.join());

console.log('\n== votes / rating / cost ==');
const loved = stop({ name: 'Loved', up_votes: 4, down_votes: 0 });
const meh = stop({ name: 'Meh', up_votes: 1, down_votes: 1 });
const hated = stop({ name: 'Hated', up_votes: 0, down_votes: 3 });
order = rankStops([meh, hated, loved], 'votes', ctx()).map((r) => r.stop.name);
ok('votes sorts by net score', order.join() === 'Loved,Meh,Hated', order.join());

const rated5 = stop({ name: 'Five', rating: 5 });
const rated3 = stop({ name: 'Three', rating: 3 });
const unrated = stop({ name: 'Unrated', rating: null, rating_count: 80 });
order = rankStops([rated3, unrated, rated5], 'rating', ctx()).map((r) => r.stop.name);
ok('rating puts unrated last', order.join() === 'Five,Three,Unrated', order.join());

const free = stop({ name: 'Free', category: 'viewpoint', est_cost_cents: 0 });
const cheap = stop({ name: 'Cheap', category: 'fast_food', est_cost_cents: 900 });
const pricey = stop({ name: 'Pricey', category: 'restaurant', est_cost_cents: 4200 });
order = rankStops([pricey, free, cheap], 'cheapest', ctx()).map((r) => r.stop.name);
ok('cheapest sorts ascending', order.join() === 'Free,Cheap,Pricey', order.join());
// unpriced stops fall back to the category estimate rather than sorting as free
const noPrice = stop({ name: 'NoPrice', category: 'restaurant', est_cost_cents: null });
order = rankStops([noPrice, cheap], 'cheapest', ctx()).map((r) => r.stop.name);
ok('unpriced uses category typical', order.join() === 'Cheap,NoPrice', order.join());
ok('  and is flagged as an estimate', metricsFor(noPrice, ctx()).costIsEstimate === true);
ok('  with the category value', metricsFor(noPrice, ctx()).costCents === 2800);

console.log('\n== status precedence ==');
const visited = stop({ name: 'Visited', status: 'arrived', lat: 33.45, lng: -112.07 });
const skipped = stop({ name: 'Skipped', status: 'skipped', lat: 33.46, lng: -112.07 });
const queued = stop({ name: 'Queued', status: 'queued', lat: 35.0, lng: -111.7 });
order = rankStops([visited, skipped, queued], 'nearest', ctx()).map((r) => r.stop.name);
ok('queued outranks done even when farther', order.join() === 'Queued,Visited,Skipped', order.join());

console.log('\n== stability & purity ==');
const input = [far, close, mid];
const before = input.map((s) => s.id).join();
rankStops(input, 'nearest', ctx());
ok('does not mutate caller array order', input.map((s) => s.id).join() === before);
const tieA = stop({ name: 'TieA', order_index: 1, up_votes: 2 });
const tieB = stop({ name: 'TieB', order_index: 2, up_votes: 2 });
order = rankStops([tieB, tieA], 'votes', ctx()).map((r) => r.stop.name);
ok('ties break on planned order', order.join() === 'TieA,TieB', order.join());

console.log('\n== badges explain the sort ==');
ok('nearest badge shows distance', /mi$/.test(primaryBadge(metricsFor(close, ctx()), 'nearest', true).text),
  primaryBadge(metricsFor(close, ctx()), 'nearest', true).text);
ok('nearest badge warns with no position',
  primaryBadge(metricsFor(close, ctx({ me: null })), 'nearest', true).tone === 'warn');
ok('detour badge says on the way when free',
  primaryBadge(metricsFor(stop({ lat: PHOENIX.lat, lng: PHOENIX.lng }), ctx()), 'detour', true).text === 'on the way');
ok('votes badge signs the number',
  primaryBadge(metricsFor(loved, ctx()), 'votes', true).text === '+4',
  primaryBadge(metricsFor(loved, ctx()), 'votes', true).text);
ok('votes badge flags negatives as warn',
  primaryBadge(metricsFor(hated, ctx()), 'votes', true).tone === 'warn');
ok('rating badge marks crew scores',
  primaryBadge(metricsFor(rated5, ctx()), 'rating', true).text.includes('crew'));
ok('cheapest badge marks estimates',
  primaryBadge(metricsFor(noPrice, ctx()), 'cheapest', true).text.includes('est'),
  primaryBadge(metricsFor(noPrice, ctx()), 'cheapest', true).text);
ok('free reads as Free', primaryBadge(metricsFor(free, ctx()), 'cheapest', true).text === 'Free');

console.log('\n== polyline interpolation ==');
const path: Array<[number, number]> = [[33.0, -112.0], [34.0, -112.0], [35.0, -112.0]];
const start = pointAlong(path, 0);
const half = pointAlong(path, 0.5);
const end = pointAlong(path, 1);
ok('t=0 is the first vertex', !!start && near(start.point.lat, 33.0, 0.01));
ok('t=0.5 is the middle', !!half && near(half.point.lat, 34.0, 0.05), String(half?.point.lat));
ok('t=1 is the last vertex', !!end && near(end.point.lat, 35.0, 0.01), String(end?.point.lat));
ok('heading points north', !!half && near(half.heading, 0, 1), String(half?.heading));
ok('degenerate path returns null', pointAlong([[1, 1]], 0.5) === null);

console.log('\n== bounds ==');
const b = boundsOf([PHOENIX, FLAGSTAFF]);
ok('bounds contain both points',
  !!b && b[0][0] <= PHOENIX.lat && b[1][0] >= FLAGSTAFF.lat && b[0][1] <= FLAGSTAFF.lng);
const single = boundsOf([PHOENIX]);
ok('single point is padded', !!single && single[1][0] - single[0][0] > 0);
ok('empty bounds are null', boundsOf([]) === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
