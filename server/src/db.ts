import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.BM_DB ?? resolve(import.meta.dirname, '../data/bettermaps.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  origin_name TEXT, origin_lat REAL, origin_lng REAL,
  dest_name   TEXT, dest_lat   REAL, dest_lng   REAL,
  starts_on   TEXT,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_members (
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'passenger',
  joined_at   INTEGER NOT NULL,
  last_lat    REAL, last_lng REAL, last_heading REAL, last_speed REAL,
  last_loc_at INTEGER,
  PRIMARY KEY (trip_id, user_id)
);

CREATE TABLE IF NOT EXISTS stops (
  id           TEXT PRIMARY KEY,
  trip_id      TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'other',
  address      TEXT,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  order_index  REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  price_level  INTEGER,
  est_cost_cents INTEGER,
  rating       REAL,
  rating_count INTEGER,
  notes        TEXT,
  source       TEXT NOT NULL DEFAULT 'search',
  external_ref TEXT,
  added_by     TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  arrived_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stops_trip ON stops(trip_id, status);

CREATE TABLE IF NOT EXISTS votes (
  stop_id   TEXT NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (stop_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'text',
  body       TEXT NOT NULL,
  stop_id    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_trip ON messages(trip_id, created_at);

CREATE TABLE IF NOT EXISTS expenses (
  id           TEXT PRIMARY KEY,
  trip_id      TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  stop_id      TEXT REFERENCES stops(id) ON DELETE SET NULL,
  payer_id     TEXT NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  label        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id);
`);

/**
 * node:sqlite hands back `Record<string, SQLOutputValue>`. The schema above is
 * the real contract, so these two helpers are the single place where loose rows
 * become typed ones.
 */
const rowsAs = <T>(rows: unknown[]): T[] => rows as unknown as T[];
const rowAs = <T>(row: unknown): T | null => (row as T | undefined) ?? null;

// ---------------------------------------------------------------- row types

export interface User {
  id: string;
  name: string;
  color: string;
  emoji: string;
  created_at: number;
}

export interface Member extends User {
  role: string;
  joined_at: number;
  last_lat: number | null;
  last_lng: number | null;
  last_heading: number | null;
  last_speed: number | null;
  last_loc_at: number | null;
}

export interface Trip {
  id: string;
  code: string;
  name: string;
  origin_name: string | null;
  origin_lat: number | null;
  origin_lng: number | null;
  dest_name: string | null;
  dest_lat: number | null;
  dest_lng: number | null;
  starts_on: string | null;
  budget_cents: number;
  created_by: string;
  created_at: number;
}

export interface Stop {
  id: string;
  trip_id: string;
  name: string;
  category: string;
  address: string | null;
  lat: number;
  lng: number;
  order_index: number;
  status: string;
  price_level: number | null;
  est_cost_cents: number | null;
  rating: number | null;
  rating_count: number | null;
  notes: string | null;
  source: string;
  external_ref: string | null;
  added_by: string;
  created_at: number;
  arrived_at: number | null;
  /** joined aggregates */
  up_votes?: number;
  down_votes?: number;
  voters?: string;
}

export interface Message {
  id: string;
  trip_id: string;
  user_id: string | null;
  kind: string;
  body: string;
  stop_id: string | null;
  created_at: number;
}

export interface Expense {
  id: string;
  trip_id: string;
  stop_id: string | null;
  payer_id: string;
  amount_cents: number;
  label: string;
  created_at: number;
}

// ---------------------------------------------------------------- helpers

const MEMBER_PALETTE = [
  '#ff8a4c', '#4cc9f0', '#b5e48c', '#f72585', '#ffd166',
  '#9d8df1', '#06d6a0', '#ef476f', '#5390d9', '#e07a5f',
];
const EMOJI_POOL = ['🦊', '🐻', '🐳', '🦉', '🐢', '🦕', '🐙', '🦜', '🐝', '🦁'];

const now = () => Date.now();
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Trip codes skip 0/O/1/I so they can be read aloud in a moving car. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newTripCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = randomBytes(6);
    let code = '';
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    const taken = db.prepare('SELECT 1 FROM trips WHERE code = ?').get(code);
    if (!taken) return code;
  }
  throw new Error('could not allocate a unique trip code');
}

// ---------------------------------------------------------------- users

export function createUser(name: string): { user: User; token: string } {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const seed = rowAs<{ n: number }>(db.prepare('SELECT COUNT(*) AS n FROM users').get())!;
  const user: User = {
    id,
    name,
    color: MEMBER_PALETTE[seed.n % MEMBER_PALETTE.length],
    emoji: EMOJI_POOL[seed.n % EMOJI_POOL.length],
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO users (id, name, color, emoji, token_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(user.id, user.name, user.color, user.emoji, hashToken(token), user.created_at);
  return { user, token };
}

export function userByToken(token: string): User | null {
  return rowAs<User>(db
    .prepare('SELECT id, name, color, emoji, created_at FROM users WHERE token_hash = ?')
    .get(hashToken(token)));
}

export function renameUser(id: string, name: string): void {
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
}

// ---------------------------------------------------------------- trips

export interface TripDraft {
  name: string;
  origin?: { name: string; lat: number; lng: number } | null;
  dest?: { name: string; lat: number; lng: number } | null;
  startsOn?: string | null;
  budgetCents?: number;
}

export function createTrip(userId: string, draft: TripDraft): Trip {
  const id = randomUUID();
  const code = newTripCode();
  db.prepare(
    `INSERT INTO trips (id, code, name, origin_name, origin_lat, origin_lng,
                        dest_name, dest_lat, dest_lng, starts_on, budget_cents, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, code, draft.name,
    draft.origin?.name ?? null, draft.origin?.lat ?? null, draft.origin?.lng ?? null,
    draft.dest?.name ?? null, draft.dest?.lat ?? null, draft.dest?.lng ?? null,
    draft.startsOn ?? null, draft.budgetCents ?? 0, userId, now(),
  );
  addMember(id, userId, 'organizer');
  return tripById(id)!;
}

export function tripById(id: string): Trip | null {
  return rowAs<Trip>(db.prepare('SELECT * FROM trips WHERE id = ?').get(id));
}

export function tripByCode(code: string): Trip | null {
  return rowAs<Trip>(db
    .prepare('SELECT * FROM trips WHERE code = ?')
    .get(code.trim().toUpperCase()));
}

export function updateTrip(id: string, patch: Partial<TripDraft>): Trip | null {
  const trip = tripById(id);
  if (!trip) return null;
  db.prepare(
    `UPDATE trips SET name = ?, origin_name = ?, origin_lat = ?, origin_lng = ?,
       dest_name = ?, dest_lat = ?, dest_lng = ?, starts_on = ?, budget_cents = ?
     WHERE id = ?`,
  ).run(
    patch.name ?? trip.name,
    patch.origin !== undefined ? patch.origin?.name ?? null : trip.origin_name,
    patch.origin !== undefined ? patch.origin?.lat ?? null : trip.origin_lat,
    patch.origin !== undefined ? patch.origin?.lng ?? null : trip.origin_lng,
    patch.dest !== undefined ? patch.dest?.name ?? null : trip.dest_name,
    patch.dest !== undefined ? patch.dest?.lat ?? null : trip.dest_lat,
    patch.dest !== undefined ? patch.dest?.lng ?? null : trip.dest_lng,
    patch.startsOn !== undefined ? patch.startsOn ?? null : trip.starts_on,
    patch.budgetCents ?? trip.budget_cents,
    id,
  );
  return tripById(id);
}

export function tripsForUser(userId: string): Array<Trip & { stop_count: number }> {
  return rowsAs<Trip & { stop_count: number }>(db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM stops s WHERE s.trip_id = t.id AND s.status = 'queued') AS stop_count
     FROM trips t
     JOIN trip_members m ON m.trip_id = t.id
     WHERE m.user_id = ?
     ORDER BY t.created_at DESC`,
  ).all(userId));
}

// ---------------------------------------------------------------- members

export function addMember(tripId: string, userId: string, role = 'passenger'): void {
  db.prepare(
    `INSERT INTO trip_members (trip_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (trip_id, user_id) DO NOTHING`,
  ).run(tripId, userId, role, now());
}

export function isMember(tripId: string, userId: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM trip_members WHERE trip_id = ? AND user_id = ?')
    .get(tripId, userId);
}

export function members(tripId: string): Member[] {
  return rowsAs<Member>(db.prepare(
    `SELECT u.id, u.name, u.color, u.emoji, u.created_at,
            m.role, m.joined_at, m.last_lat, m.last_lng, m.last_heading, m.last_speed, m.last_loc_at
     FROM trip_members m JOIN users u ON u.id = m.user_id
     WHERE m.trip_id = ? ORDER BY m.joined_at`,
  ).all(tripId));
}

/** Only one driver at a time — claiming the wheel demotes whoever had it. */
export function setRole(tripId: string, userId: string, role: string): void {
  if (role === 'driver') {
    db.prepare(
      `UPDATE trip_members SET role = 'passenger' WHERE trip_id = ? AND role = 'driver'`,
    ).run(tripId);
  }
  db.prepare('UPDATE trip_members SET role = ? WHERE trip_id = ? AND user_id = ?')
    .run(role, tripId, userId);
}

export function recordLocation(
  tripId: string, userId: string,
  loc: { lat: number; lng: number; heading?: number | null; speed?: number | null },
): void {
  db.prepare(
    `UPDATE trip_members SET last_lat = ?, last_lng = ?, last_heading = ?, last_speed = ?, last_loc_at = ?
     WHERE trip_id = ? AND user_id = ?`,
  ).run(loc.lat, loc.lng, loc.heading ?? null, loc.speed ?? null, now(), tripId, userId);
}

export function leaveTrip(tripId: string, userId: string): void {
  db.prepare('DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?').run(tripId, userId);
}

// ---------------------------------------------------------------- stops

export interface StopDraft {
  name: string;
  category?: string;
  address?: string | null;
  lat: number;
  lng: number;
  priceLevel?: number | null;
  estCostCents?: number | null;
  rating?: number | null;
  ratingCount?: number | null;
  notes?: string | null;
  source?: string;
  externalRef?: string | null;
}

export function addStop(tripId: string, userId: string, draft: StopDraft): Stop {
  const id = randomUUID();
  const tail = rowAs<{ mx: number }>(db
    .prepare('SELECT COALESCE(MAX(order_index), 0) AS mx FROM stops WHERE trip_id = ?')
    .get(tripId))!;
  db.prepare(
    `INSERT INTO stops (id, trip_id, name, category, address, lat, lng, order_index, status,
       price_level, est_cost_cents, rating, rating_count, notes, source, external_ref, added_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, tripId, draft.name, draft.category ?? 'other', draft.address ?? null,
    draft.lat, draft.lng, tail.mx + 1,
    draft.priceLevel ?? null, draft.estCostCents ?? null,
    draft.rating ?? null, draft.ratingCount ?? null, draft.notes ?? null,
    draft.source ?? 'search', draft.externalRef ?? null, userId, now(),
  );
  return stopById(id)!;
}

const STOP_SELECT = `
  SELECT s.*,
    COALESCE(SUM(CASE WHEN v.value > 0 THEN 1 ELSE 0 END), 0) AS up_votes,
    COALESCE(SUM(CASE WHEN v.value < 0 THEN 1 ELSE 0 END), 0) AS down_votes,
    COALESCE(GROUP_CONCAT(v.user_id || ':' || v.value), '') AS voters
  FROM stops s LEFT JOIN votes v ON v.stop_id = s.id`;

export function stopById(id: string): Stop | null {
  return rowAs<Stop>(db
    .prepare(`${STOP_SELECT} WHERE s.id = ? GROUP BY s.id`)
    .get(id));
}

export function stops(tripId: string): Stop[] {
  return rowsAs<Stop>(db
    .prepare(`${STOP_SELECT} WHERE s.trip_id = ? GROUP BY s.id ORDER BY s.order_index`)
    .all(tripId));
}

export function updateStop(id: string, patch: Record<string, unknown>): Stop | null {
  const allowed = [
    'name', 'category', 'address', 'lat', 'lng', 'status', 'price_level',
    'est_cost_cents', 'rating', 'notes', 'order_index',
  ];
  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  for (const key of allowed) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      const v = patch[key];
      args.push(v === undefined || v === '' ? null : (v as string | number));
    }
  }
  if (patch.status === 'arrived') {
    sets.push('arrived_at = ?');
    args.push(now());
  } else if (patch.status === 'queued') {
    sets.push('arrived_at = ?');
    args.push(null);
  }
  if (!sets.length) return stopById(id);
  args.push(id);
  db.prepare(`UPDATE stops SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return stopById(id);
}

export function removeStop(id: string): void {
  db.prepare('DELETE FROM stops WHERE id = ?').run(id);
}

/** Rewrites order_index to match the supplied id sequence. */
export function reorderStops(tripId: string, orderedIds: string[]): Stop[] {
  const stmt = db.prepare('UPDATE stops SET order_index = ? WHERE id = ? AND trip_id = ?');
  db.exec('BEGIN');
  try {
    orderedIds.forEach((id, i) => stmt.run(i + 1, id, tripId));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return stops(tripId);
}

export function castVote(stopId: string, userId: string, value: number): void {
  if (value === 0) {
    db.prepare('DELETE FROM votes WHERE stop_id = ? AND user_id = ?').run(stopId, userId);
    return;
  }
  db.prepare(
    `INSERT INTO votes (stop_id, user_id, value, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (stop_id, user_id) DO UPDATE SET value = excluded.value`,
  ).run(stopId, userId, value > 0 ? 1 : -1, now());
}

// ---------------------------------------------------------------- chat

export function addMessage(
  tripId: string, userId: string | null, body: string,
  kind = 'text', stopId: string | null = null,
): Message {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO messages (id, trip_id, user_id, kind, body, stop_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, tripId, userId, kind, body, stopId, now());
  return rowAs<Message>(db.prepare('SELECT * FROM messages WHERE id = ?').get(id))!;
}

export function messages(tripId: string, limit = 200): Message[] {
  const rows = rowsAs<Message>(db.prepare(
    'SELECT * FROM messages WHERE trip_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(tripId, limit));
  return rows.reverse();
}

// ---------------------------------------------------------------- expenses

export function addExpense(
  tripId: string, payerId: string,
  e: { amountCents: number; label: string; stopId?: string | null },
): Expense {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO expenses (id, trip_id, stop_id, payer_id, amount_cents, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, tripId, e.stopId ?? null, payerId, Math.round(e.amountCents), e.label, now());
  return rowAs<Expense>(db.prepare('SELECT * FROM expenses WHERE id = ?').get(id))!;
}

export function expenses(tripId: string): Expense[] {
  return rowsAs<Expense>(db
    .prepare('SELECT * FROM expenses WHERE trip_id = ? ORDER BY created_at DESC')
    .all(tripId));
}

export function removeExpense(id: string, tripId: string): void {
  db.prepare('DELETE FROM expenses WHERE id = ? AND trip_id = ?').run(id, tripId);
}

// ---------------------------------------------------------------- place history

/**
 * How many times this install has actually checked in at each place, and what
 * the crew scored it. OSM carries no review data, so "highest rated / most
 * visited" is built from the group's own history instead of invented.
 */
export function withVisitCounts<T extends { ref: string }>(
  places: T[],
): Array<T & { visits: number; crewRating: number | null }> {
  if (!places.length) return [];
  const refs = places.map((p) => p.ref);
  const holes = refs.map(() => '?').join(',');
  const rows = rowsAs<{ ref: string; visits: number; crew_rating: number | null }>(db.prepare(
    `SELECT external_ref AS ref,
            SUM(CASE WHEN status = 'arrived' THEN 1 ELSE 0 END) AS visits,
            AVG(rating) AS crew_rating
     FROM stops WHERE external_ref IN (${holes})
     GROUP BY external_ref`,
  ).all(...refs));

  const byRef = new Map(rows.map((r) => [r.ref, r]));
  return places.map((p) => {
    const hit = byRef.get(p.ref);
    return {
      ...p,
      visits: hit?.visits ?? 0,
      crewRating: hit?.crew_rating != null ? Number(hit.crew_rating) : null,
    };
  });
}
