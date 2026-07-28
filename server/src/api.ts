import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as store from './db.ts';
import { broadcast } from './realtime.ts';
import {
  CATEGORIES, categoryDef, searchPlaces, nearbyPlaces, reverseGeocode, routeThrough,
} from './places.ts';

export const api = Router();

// ---------------------------------------------------------------- plumbing

interface Ctx {
  user: store.User;
  trip: store.Trip;
}
/** Populated by requireAuth / requireMember; keyed off the request object. */
const ctx = new WeakMap<Request, Partial<Ctx>>();
const get = (req: Request) => ctx.get(req) ?? {};
const put = (req: Request, patch: Partial<Ctx>) => ctx.set(req, { ...get(req), ...patch });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Wraps an async handler so rejections reach the error middleware. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const user = token ? store.userByToken(token) : null;
  if (!user) return next(new HttpError(401, 'Sign in first'));
  put(req, { user });
  next();
}

function requireMember(req: Request, _res: Response, next: NextFunction): void {
  const { user } = get(req);
  const trip = store.tripById(req.params.tripId);
  if (!trip) return next(new HttpError(404, 'Trip not found'));
  if (!user || !store.isMember(trip.id, user.id)) {
    return next(new HttpError(403, 'You are not on this trip'));
  }
  put(req, { trip });
  next();
}

function str(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required`);
  const v = value.trim();
  if (v.length > max) throw new HttpError(400, `${field} must be under ${max} characters`);
  return v;
}

function coord(value: unknown, field: string, limit: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw new HttpError(400, `${field} is invalid`);
  return n;
}

function optPlace(value: unknown, field: string) {
  if (value == null) return null;
  const p = value as Record<string, unknown>;
  return {
    name: str(p.name, `${field}.name`),
    lat: coord(p.lat, `${field}.lat`, 90),
    lng: coord(p.lng, `${field}.lng`, 180),
  };
}

/** Pushes a system line into the trip timeline and fans it out. */
function systemNote(tripId: string, body: string, stopId: string | null = null): void {
  const message = store.addMessage(tripId, null, body, 'system', stopId);
  broadcast(tripId, { type: 'message:new', tripId, message });
}

// ---------------------------------------------------------------- session

api.post('/session', (req, res) => {
  const name = str(req.body?.name, 'name', 40);
  const { user, token } = store.createUser(name);
  res.status(201).json({ user, token });
});

api.get('/session', requireAuth, (req, res) => {
  res.json({ user: get(req).user, trips: store.tripsForUser(get(req).user!.id) });
});

api.patch('/session', requireAuth, (req, res) => {
  const user = get(req).user!;
  const name = str(req.body?.name, 'name', 40);
  store.renameUser(user.id, name);
  // every trip they're on should see the new name
  for (const trip of store.tripsForUser(user.id)) {
    broadcast(trip.id, { type: 'member:updated', tripId: trip.id, members: store.members(trip.id) });
  }
  res.json({ user: { ...user, name } });
});

// ---------------------------------------------------------------- trips

api.get('/trips', requireAuth, (req, res) => {
  res.json({ trips: store.tripsForUser(get(req).user!.id) });
});

api.post('/trips', requireAuth, (req, res) => {
  const body = req.body ?? {};
  const trip = store.createTrip(get(req).user!.id, {
    name: str(body.name, 'name', 80),
    origin: optPlace(body.origin, 'origin'),
    dest: optPlace(body.dest, 'dest'),
    startsOn: typeof body.startsOn === 'string' ? body.startsOn : null,
    budgetCents: Number.isFinite(Number(body.budgetCents)) ? Math.max(0, Math.round(Number(body.budgetCents))) : 0,
  });
  res.status(201).json({ trip });
});

api.post('/trips/join', requireAuth, (req, res) => {
  const user = get(req).user!;
  const code = str(req.body?.code, 'code', 12).toUpperCase();
  const trip = store.tripByCode(code);
  if (!trip) throw new HttpError(404, `No trip with code ${code}`);

  const wasMember = store.isMember(trip.id, user.id);
  store.addMember(trip.id, user.id);
  if (!wasMember) {
    broadcast(trip.id, { type: 'member:joined', tripId: trip.id, members: store.members(trip.id) });
    systemNote(trip.id, `${user.name} joined the trip`);
  }
  res.json({ trip });
});

/** One call returns everything a phone needs to render the trip. */
api.get('/trips/:tripId', requireAuth, requireMember, (req, res) => {
  const trip = get(req).trip!;
  res.json({
    trip,
    members: store.members(trip.id),
    stops: store.stops(trip.id),
    messages: store.messages(trip.id),
    expenses: store.expenses(trip.id),
  });
});

api.patch('/trips/:tripId', requireAuth, requireMember, (req, res) => {
  const trip = get(req).trip!;
  const body = req.body ?? {};
  const patch: store.TripDraft = { name: body.name ? str(body.name, 'name', 80) : trip.name };
  if ('origin' in body) patch.origin = optPlace(body.origin, 'origin');
  if ('dest' in body) patch.dest = optPlace(body.dest, 'dest');
  if ('startsOn' in body) patch.startsOn = typeof body.startsOn === 'string' ? body.startsOn : null;
  if ('budgetCents' in body) patch.budgetCents = Math.max(0, Math.round(Number(body.budgetCents) || 0));

  const updated = store.updateTrip(trip.id, patch)!;
  broadcast(trip.id, { type: 'trip:updated', tripId: trip.id, trip: updated });
  res.json({ trip: updated });
});

api.post('/trips/:tripId/role', requireAuth, requireMember, (req, res) => {
  const { user, trip } = get(req) as Ctx;
  const role = str(req.body?.role, 'role', 20);
  if (!['driver', 'passenger', 'organizer'].includes(role)) {
    throw new HttpError(400, 'role must be driver, passenger or organizer');
  }
  store.setRole(trip.id, user.id, role);
  broadcast(trip.id, { type: 'member:updated', tripId: trip.id, members: store.members(trip.id) });
  if (role === 'driver') systemNote(trip.id, `${user.name} is driving`);
  res.json({ members: store.members(trip.id) });
});

api.post('/trips/:tripId/leave', requireAuth, requireMember, (req, res) => {
  const { user, trip } = get(req) as Ctx;
  store.leaveTrip(trip.id, user.id);
  broadcast(trip.id, { type: 'member:updated', tripId: trip.id, members: store.members(trip.id) });
  systemNote(trip.id, `${user.name} left the trip`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- stops

api.post('/trips/:tripId/stops', requireAuth, requireMember, (req, res) => {
  const { user, trip } = get(req) as Ctx;
  const b = req.body ?? {};
  const category = typeof b.category === 'string' && categoryDef(b.category) ? b.category : 'other';

  const stop = store.addStop(trip.id, user.id, {
    name: str(b.name, 'name', 120),
    category,
    address: typeof b.address === 'string' ? b.address.slice(0, 300) : null,
    lat: coord(b.lat, 'lat', 90),
    lng: coord(b.lng, 'lng', 180),
    priceLevel: b.priceLevel == null ? null : Math.max(0, Math.min(4, Math.round(Number(b.priceLevel)))),
    estCostCents: b.estCostCents == null ? null : Math.max(0, Math.round(Number(b.estCostCents))),
    rating: b.rating == null ? null : Math.max(0, Math.min(5, Number(b.rating))),
    ratingCount: b.prominence == null ? null : Math.round(Number(b.prominence)),
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 500) : null,
    source: ['search', 'nearby', 'pin'].includes(b.source) ? b.source : 'search',
    externalRef: typeof b.externalRef === 'string' ? b.externalRef : null,
  });

  broadcast(trip.id, { type: 'stop:added', tripId: trip.id, stop, by: user.name });
  systemNote(trip.id, `${user.name} added ${stop.name} to the queue`, stop.id);
  res.status(201).json({ stop });
});

api.patch('/trips/:tripId/stops/:stopId', requireAuth, requireMember, (req, res) => {
  const { user, trip } = get(req) as Ctx;
  const existing = store.stopById(req.params.stopId);
  if (!existing || existing.trip_id !== trip.id) throw new HttpError(404, 'Stop not found');

  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (typeof b.name === 'string') patch.name = str(b.name, 'name', 120);
  if (typeof b.notes === 'string') patch.notes = b.notes.slice(0, 500);
  if (typeof b.category === 'string' && categoryDef(b.category)) patch.category = b.category;
  if (b.priceLevel !== undefined) {
    patch.price_level = b.priceLevel == null ? null : Math.max(0, Math.min(4, Math.round(Number(b.priceLevel))));
  }
  if (b.estCostCents !== undefined) {
    patch.est_cost_cents = b.estCostCents == null ? null : Math.max(0, Math.round(Number(b.estCostCents)));
  }
  if (b.rating !== undefined) {
    patch.rating = b.rating == null ? null : Math.max(0, Math.min(5, Number(b.rating)));
  }
  if (typeof b.status === 'string') {
    if (!['queued', 'arrived', 'skipped'].includes(b.status)) {
      throw new HttpError(400, 'status must be queued, arrived or skipped');
    }
    patch.status = b.status;
  }
  if (b.lat !== undefined && b.lng !== undefined) {
    patch.lat = coord(b.lat, 'lat', 90);
    patch.lng = coord(b.lng, 'lng', 180);
  }

  const stop = store.updateStop(existing.id, patch)!;
  broadcast(trip.id, { type: 'stop:updated', tripId: trip.id, stop });

  if (patch.status && patch.status !== existing.status) {
    const verb = patch.status === 'arrived' ? 'checked in at' : patch.status === 'skipped' ? 'skipped' : 're-queued';
    systemNote(trip.id, `${user.name} ${verb} ${stop.name}`, stop.id);
  }
  res.json({ stop });
});

api.delete('/trips/:tripId/stops/:stopId', requireAuth, requireMember, (req, res) => {
  const { user, trip } = get(req) as Ctx;
  const stop = store.stopById(req.params.stopId);
  if (!stop || stop.trip_id !== trip.id) throw new HttpError(404, 'Stop not found');
  store.removeStop(stop.id);
  broadcast(trip.id, { type: 'stop:removed', tripId: trip.id, stopId: stop.id });
  systemNote(trip.id, `${user.name} removed ${stop.name}`);
  res.json({ ok: true });
});

api.post('/trips/:tripId/stops/reorder', requireAuth, requireMember, (req, res) => {
  const trip = get(req).trip!;
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new HttpError(400, 'ids must be an array of stop ids');
  }
  const stops = store.reorderStops(trip.id, ids as string[]);
  broadcast(trip.id, { type: 'stops:reordered', tripId: trip.id, stops });
  res.json({ stops });
});

api.post('/trips/:tripId/stops/:stopId/vote', requireAuth, requireMember, (req, res) => {
  const { user, trip } = get(req) as Ctx;
  const stop = store.stopById(req.params.stopId);
  if (!stop || stop.trip_id !== trip.id) throw new HttpError(404, 'Stop not found');

  // Validate before normalising: Math.sign would happily turn a client bug like
  // value: 7 into a legitimate upvote and hide it.
  const value = Number(req.body?.value);
  if (value !== -1 && value !== 0 && value !== 1) {
    throw new HttpError(400, 'value must be -1, 0 or 1');
  }
  store.castVote(stop.id, user.id, value);

  const updated = store.stopById(stop.id)!;
  broadcast(trip.id, { type: 'stop:updated', tripId: trip.id, stop: updated });
  res.json({ stop: updated });
});

// ---------------------------------------------------------------- chat

api.post('/trips/:tripId/messages', requireAuth, requireMember, (req, res) => {
  const { user, trip } = get(req) as Ctx;
  const body = str(req.body?.body, 'body', 1000);
  const stopId = typeof req.body?.stopId === 'string' ? req.body.stopId : null;
  const message = store.addMessage(trip.id, user.id, body, stopId ? 'stop_ref' : 'text', stopId);
  broadcast(trip.id, { type: 'message:new', tripId: trip.id, message });
  res.status(201).json({ message });
});

api.get('/trips/:tripId/messages', requireAuth, requireMember, (req, res) => {
  res.json({ messages: store.messages(get(req).trip!.id) });
});

// ---------------------------------------------------------------- expenses

api.post('/trips/:tripId/expenses', requireAuth, requireMember, (req, res) => {
  const { user, trip } = get(req) as Ctx;
  const amountCents = Math.round(Number(req.body?.amountCents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new HttpError(400, 'amountCents must be a positive number');
  }
  const label = str(req.body?.label, 'label', 80);
  const stopId = typeof req.body?.stopId === 'string' ? req.body.stopId : null;

  store.addExpense(trip.id, user.id, { amountCents, label, stopId });
  const expenses = store.expenses(trip.id);
  broadcast(trip.id, { type: 'expense:changed', tripId: trip.id, expenses });
  systemNote(trip.id, `${user.name} paid $${(amountCents / 100).toFixed(2)} for ${label}`, stopId);
  res.status(201).json({ expenses });
});

api.delete('/trips/:tripId/expenses/:expenseId', requireAuth, requireMember, (req, res) => {
  const trip = get(req).trip!;
  store.removeExpense(req.params.expenseId, trip.id);
  const expenses = store.expenses(trip.id);
  broadcast(trip.id, { type: 'expense:changed', tripId: trip.id, expenses });
  res.json({ expenses });
});

// ---------------------------------------------------------------- places

api.get('/places/categories', (_req, res) => {
  res.json({
    categories: CATEGORIES.map((c) => ({
      key: c.key, label: c.label, icon: c.icon,
      typicalCents: c.typicalCents, priceLevel: c.priceLevel,
    })),
  });
});

api.get('/places/search', requireAuth, wrap(async (req, res) => {
  const q = str(req.query.q, 'q', 200);
  const near =
    req.query.lat && req.query.lng
      ? { lat: coord(req.query.lat, 'lat', 90), lng: coord(req.query.lng, 'lng', 180) }
      : undefined;
  const results = await searchPlaces(q, { near });
  res.json({ results: store.withVisitCounts(results) });
}));

api.get('/places/nearby', requireAuth, wrap(async (req, res) => {
  const category = str(req.query.category, 'category', 40);
  const lat = coord(req.query.lat, 'lat', 90);
  const lng = coord(req.query.lng, 'lng', 180);
  const radius = Math.min(50_000, Math.max(500, Number(req.query.radius) || 8000));
  const out = await nearbyPlaces(category, lat, lng, radius);
  res.json({ ...out, results: store.withVisitCounts(out.results) });
}));

api.get('/places/reverse', requireAuth, wrap(async (req, res) => {
  const lat = coord(req.query.lat, 'lat', 90);
  const lng = coord(req.query.lng, 'lng', 180);
  res.json({ result: await reverseGeocode(lat, lng) });
}));

api.post('/route', requireAuth, wrap(async (req, res) => {
  const points = req.body?.points;
  if (!Array.isArray(points)) throw new HttpError(400, 'points must be an array');
  const clean = points.map((p: unknown, i: number) => {
    const o = p as Record<string, unknown>;
    return { lat: coord(o?.lat, `points[${i}].lat`, 90), lng: coord(o?.lng, `points[${i}].lng`, 180) };
  });
  res.json({ route: await routeThrough(clean) });
}));

// ---------------------------------------------------------------- errors

api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : (err as { status?: number })?.status ?? 500;
  const message = err instanceof Error ? err.message : 'Unexpected error';
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: message });
});
