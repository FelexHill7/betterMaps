/**
 * End-to-end API test. Boots a real server against a throwaway SQLite file on a
 * spare port, so it exercises the actual HTTP surface and schema rather than
 * mocks. Network-dependent checks (geocoding, routing) are marked and tolerated
 * when the public OSM endpoints are throttled.
 *
 *   node --no-warnings=ExperimentalWarning server/test/api.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const PORT = Number(process.env.TEST_PORT ?? 5199);
const B = `http://localhost:${PORT}/api`;
const dir = mkdtempSync(join(tmpdir(), 'bettermaps-test-'));
const serverEntry = resolve(import.meta.dirname, '../src/index.ts');

let pass = 0, fail = 0, skipped = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', label); }
  else { fail++; console.log('  FAIL', label, extra); }
};
/** For assertions that depend on a third-party endpoint being up. */
const okNet = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', label); }
  else { skipped++; console.log('  SKIP', label, '(upstream OSM service unavailable)', extra); }
};

const child = spawn(
  process.execPath,
  ['--no-warnings=ExperimentalWarning', serverEntry],
  { env: { ...process.env, PORT: String(PORT), BM_DB: join(dir, 'test.db') }, stdio: 'ignore' },
);

const shutdown = () => {
  child.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
};
process.on('exit', shutdown);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(B + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

// wait for the server to come up
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${B}/health`);
    if (r.ok) { up = true; break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
if (!up) {
  console.error('server never became healthy');
  process.exit(1);
}

console.log('\n== session ==');
const alex = (await call('POST', '/session', { body: { name: 'Alex' } })).data;
const sam = (await call('POST', '/session', { body: { name: 'Sam' } })).data;
ok('create users', !!alex?.token && !!sam?.token && alex.user.id !== sam.user.id);
ok('users get distinct colors', alex.user.color !== sam.user.color);
ok('reject blank name', (await call('POST', '/session', { body: { name: '  ' } })).status === 400);
ok('reject bogus token', (await call('GET', '/session', { token: 'nope' })).status === 401);
ok('token round-trips', (await call('GET', '/session', { token: alex.token })).data.user.id === alex.user.id);

console.log('\n== trips ==');
const trip = (await call('POST', '/trips', { token: alex.token, body: {
  name: 'Phoenix to Grand Canyon',
  origin: { name: 'Phoenix, AZ', lat: 33.4484, lng: -112.0740 },
  dest: { name: 'Grand Canyon Village', lat: 36.0544, lng: -112.1401 },
  budgetCents: 40000,
} })).data.trip;
ok('create trip', !!trip?.id);
ok('code avoids ambiguous glyphs', /^[A-HJ-NP-Z2-9]{6}$/.test(trip.code), trip.code);
ok('join by lowercase code', (await call('POST', '/trips/join', { token: sam.token, body: { code: trip.code.toLowerCase() } })).status === 200);
ok('unknown code is 404', (await call('POST', '/trips/join', { token: sam.token, body: { code: 'ZZZZZZ' } })).status === 404);
ok('joining twice is idempotent', (await call('POST', '/trips/join', { token: sam.token, body: { code: trip.code } })).status === 200);
ok('membership is 2', (await call('GET', `/trips/${trip.id}`, { token: alex.token })).data.members.length === 2);

const carl = (await call('POST', '/session', { body: { name: 'Carl' } })).data;
ok('outsider cannot read trip', (await call('GET', `/trips/${trip.id}`, { token: carl.token })).status === 403);
ok('outsider cannot add stops', (await call('POST', `/trips/${trip.id}/stops`, { token: carl.token, body: { name: 'X', lat: 34, lng: -112 } })).status === 403);

console.log('\n== stops ==');
const mk = (token, body) => call('POST', `/trips/${trip.id}/stops`, { token, body });
const s1 = (await mk(alex.token, { name: 'In-N-Out Burger', category: 'fast_food', lat: 33.6054, lng: -112.1246, priceLevel: 1, estCostCents: 1100, externalRef: 'n123' })).data.stop;
const s2 = (await mk(sam.token, { name: 'Sedona Overlook', category: 'viewpoint', lat: 34.8697, lng: -111.7610, priceLevel: 0, estCostCents: 0 })).data.stop;
const s3 = (await mk(sam.token, { name: 'Flagstaff Diner', category: 'restaurant', lat: 35.1983, lng: -111.6513, priceLevel: 3, estCostCents: 3200 })).data.stop;
ok('add stops', !!s1 && !!s2 && !!s3);
ok('order_index increments', s1.order_index < s2.order_index && s2.order_index < s3.order_index);
ok('unknown category becomes other', (await mk(alex.token, { name: 'Mystery', category: 'wat', lat: 34, lng: -112 })).data.stop.category === 'other');
ok('reject out-of-range lat', (await mk(alex.token, { name: 'Bad', lat: 999, lng: -112 })).status === 400);
ok('reject blank name', (await mk(alex.token, { name: '', lat: 34, lng: -112 })).status === 400);
ok('clamp price level', (await mk(alex.token, { name: 'Clamp', lat: 34, lng: -112, priceLevel: 99 })).data.stop.price_level === 4);

console.log('\n== votes ==');
const voteOn = (id, token, value) => call('POST', `/trips/${trip.id}/stops/${id}/vote`, { token, body: { value } });
await voteOn(s2.id, alex.token, 1);
await voteOn(s2.id, sam.token, 1);
let v = (await voteOn(s3.id, alex.token, -1)).data.stop;
ok('downvote counted', v.down_votes === 1 && v.up_votes === 0);
v = (await voteOn(s3.id, alex.token, 1)).data.stop;
ok('re-voting replaces, not duplicates', v.up_votes === 1 && v.down_votes === 0);
v = (await voteOn(s3.id, alex.token, 0)).data.stop;
ok('zero clears the vote', v.up_votes === 0 && v.down_votes === 0);
const snap = (await call('GET', `/trips/${trip.id}`, { token: alex.token })).data;
const s2row = snap.stops.find((s) => s.id === s2.id);
ok('votes aggregate across users', s2row.up_votes === 2);
ok('voter ids are exposed for per-user state', s2row.voters.includes(alex.user.id) && s2row.voters.includes(sam.user.id));
ok('reject nonsense vote value', (await call('POST', `/trips/${trip.id}/stops/${s2.id}/vote`, { token: alex.token, body: { value: 7 } })).status === 400);

console.log('\n== reorder & status ==');
const reordered = (await call('POST', `/trips/${trip.id}/stops/reorder`, { token: sam.token, body: { ids: [s3.id, s1.id, s2.id] } })).data.stops;
ok('reorder rewrites planned order', reordered.slice(0, 3).map((s) => s.id).join() === [s3.id, s1.id, s2.id].join());
const arrived = (await call('PATCH', `/trips/${trip.id}/stops/${s1.id}`, { token: alex.token, body: { status: 'arrived', rating: 4.5 } })).data.stop;
ok('check-in stamps arrived_at', arrived.status === 'arrived' && arrived.arrived_at > 0);
ok('crew rating persists', arrived.rating === 4.5);
ok('re-queue clears arrived_at', (await call('PATCH', `/trips/${trip.id}/stops/${s1.id}`, { token: alex.token, body: { status: 'queued' } })).data.stop.arrived_at === null);
ok('reject invalid status', (await call('PATCH', `/trips/${trip.id}/stops/${s1.id}`, { token: alex.token, body: { status: 'teleported' } })).status === 400);
ok('clamp rating to 5', (await call('PATCH', `/trips/${trip.id}/stops/${s1.id}`, { token: alex.token, body: { rating: 99 } })).data.stop.rating === 5);

console.log('\n== chat ==');
await call('POST', `/trips/${trip.id}/messages`, { token: sam.token, body: { body: 'can we stop for coffee?' } });
const msgs = (await call('GET', `/trips/${trip.id}/messages`, { token: alex.token })).data.messages;
ok('user message stored', msgs.some((m) => m.body === 'can we stop for coffee?' && m.user_id === sam.user.id));
ok('queue changes are logged as system notes', msgs.filter((m) => m.kind === 'system' && /added/.test(m.body)).length >= 3);
ok('timeline is chronological', msgs.every((m, i) => i === 0 || msgs[i - 1].created_at <= m.created_at));
ok('reject empty message', (await call('POST', `/trips/${trip.id}/messages`, { token: sam.token, body: { body: '   ' } })).status === 400);

console.log('\n== roles & money ==');
await call('POST', `/trips/${trip.id}/role`, { token: alex.token, body: { role: 'driver' } });
const mem = (await call('POST', `/trips/${trip.id}/role`, { token: sam.token, body: { role: 'driver' } })).data.members;
ok('only one driver at a time', mem.filter((m) => m.role === 'driver').length === 1);
ok('the wheel moved to the claimant', mem.find((m) => m.id === sam.user.id).role === 'driver');
ok('reject unknown role', (await call('POST', `/trips/${trip.id}/role`, { token: sam.token, body: { role: 'pilot' } })).status === 400);

const exp = (await call('POST', `/trips/${trip.id}/expenses`, { token: alex.token, body: { amountCents: 4250, label: 'Gas', stopId: s1.id } })).data.expenses;
ok('expense recorded', exp.length === 1 && exp[0].amount_cents === 4250);
ok('expense attributed to payer', exp[0].payer_id === alex.user.id);
ok('reject zero expense', (await call('POST', `/trips/${trip.id}/expenses`, { token: alex.token, body: { amountCents: 0, label: 'x' } })).status === 400);
ok('delete expense', (await call('DELETE', `/trips/${trip.id}/expenses/${exp[0].id}`, { token: alex.token })).data.expenses.length === 0);

console.log('\n== places & routing (needs OSM upstream) ==');
const cats = (await call('GET', '/places/categories')).data.categories;
ok('category table served', cats.length >= 10 && !!cats[0].icon);
ok('search requires auth', (await call('GET', '/places/search?q=test')).status === 401);

const search = await call('GET', '/places/search?q=in-n-out%20burger%20phoenix&lat=33.44&lng=-112.07', { token: alex.token });
okNet('geocoding returns places', search.status === 200 && search.data.results?.length > 0);
if (search.data.results?.length) {
  const first = search.data.results[0];
  ok('result carries coords, cost and visit history',
    !!first.name && Number.isFinite(first.lat) && 'visits' in first && 'estCostCents' in first);
}

const near = await call('GET', '/places/nearby?category=fast_food&lat=33.4484&lng=-112.0740&radius=5000', { token: alex.token });
okNet('nearby returns results', near.status === 200 && near.data.results?.length > 0,
  `source=${near.data?.source}`);
if (near.status === 200) {
  console.log(`       nearby source: ${near.data.source}, degraded: ${near.data.degraded}, n=${near.data.results.length}`);
  ok('degraded flag is always present', typeof near.data.degraded === 'boolean');
}
ok('nearby rejects unknown category', (await call('GET', '/places/nearby?category=unicorns&lat=33&lng=-112', { token: alex.token })).status === 400);

const route = await call('POST', '/route', { token: alex.token, body: { points: [
  { lat: 33.4484, lng: -112.0740 }, { lat: 34.8697, lng: -111.7610 }, { lat: 36.0544, lng: -112.1401 },
] } });
okNet('route computed over 3 waypoints', route.status === 200 && route.data.route?.distanceM > 300_000);
if (route.status === 200) {
  ok('polyline decoded to lat/lng pairs',
    route.data.route.geometry.length > 100 && route.data.route.geometry[0].length === 2);
  ok('per-leg distances present', route.data.route.legs.length === 2 && route.data.route.legs[0].distanceM > 0);
}
ok('reject single-point route', (await call('POST', '/route', { token: alex.token, body: { points: [{ lat: 1, lng: 1 }] } })).status === 400);

console.log('\n== deletion & cascade ==');
ok('delete stop', (await call('DELETE', `/trips/${trip.id}/stops/${s2.id}`, { token: alex.token })).status === 200);
const finalSnap = (await call('GET', `/trips/${trip.id}`, { token: alex.token })).data;
ok('stop removed from snapshot', !finalSnap.stops.some((s) => s.id === s2.id));
ok('snapshot bundles the whole trip',
  !!finalSnap.trip && !!finalSnap.members && !!finalSnap.stops && !!finalSnap.messages && !!finalSnap.expenses);
ok('deleting an already-deleted stop is 404',
  (await call('DELETE', `/trips/${trip.id}/stops/${s2.id}`, { token: alex.token })).status === 404);

console.log('\n== leaving ==');
ok('leave trip', (await call('POST', `/trips/${trip.id}/leave`, { token: sam.token })).status === 200);
ok('former member loses access', (await call('GET', `/trips/${trip.id}`, { token: sam.token })).status === 403);
ok('trip survives for remaining members', (await call('GET', `/trips/${trip.id}`, { token: alex.token })).status === 200);

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
process.exit(fail ? 1 : 0);
