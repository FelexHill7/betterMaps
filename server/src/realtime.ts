import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import * as store from './db.ts';

/**
 * Live trip channel. Mutations always travel over REST (easy to retry, easy to
 * curl); this socket is the fan-out path that tells everyone else what changed,
 * plus the ingest path for high-frequency vehicle positions, which we
 * deliberately keep off HTTP.
 */

export type ServerEvent =
  | { type: 'hello'; userId: string }
  | { type: 'subscribed'; tripId: string }
  | { type: 'error'; message: string }
  | { type: 'stop:added'; tripId: string; stop: store.Stop; by: string }
  | { type: 'stop:updated'; tripId: string; stop: store.Stop }
  | { type: 'stop:removed'; tripId: string; stopId: string }
  | { type: 'stops:reordered'; tripId: string; stops: store.Stop[] }
  | { type: 'message:new'; tripId: string; message: store.Message }
  | { type: 'member:joined'; tripId: string; members: store.Member[] }
  | { type: 'member:updated'; tripId: string; members: store.Member[] }
  | { type: 'member:location'; tripId: string; userId: string; lat: number; lng: number; heading: number | null; speed: number | null; at: number }
  | { type: 'trip:updated'; tripId: string; trip: store.Trip }
  | { type: 'expense:changed'; tripId: string; expenses: store.Expense[] }
  | { type: 'presence'; tripId: string; online: string[] };

interface Client {
  socket: WebSocket;
  userId: string;
  tripId: string | null;
  alive: boolean;
}

const clients = new Set<Client>();

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

/** Broadcast to everyone subscribed to a trip, optionally skipping one user. */
export function broadcast(tripId: string, event: ServerEvent, exceptUserId?: string): void {
  for (const c of clients) {
    if (c.tripId !== tripId) continue;
    if (exceptUserId && c.userId === exceptUserId) continue;
    send(c.socket, event);
  }
}

function onlineIn(tripId: string): string[] {
  return [...new Set([...clients].filter((c) => c.tripId === tripId).map((c) => c.userId))];
}

function announcePresence(tripId: string): void {
  broadcast(tripId, { type: 'presence', tripId, online: onlineIn(tripId) });
}

/** Positions arrive several times a minute per phone; only persist occasionally. */
const lastPersist = new Map<string, number>();
const PERSIST_EVERY_MS = 15_000;

export function attachRealtime(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const user = token ? store.userByToken(token) : null;

    if (!user) {
      send(socket, { type: 'error', message: 'invalid token' });
      socket.close(4401, 'unauthorized');
      return;
    }

    const client: Client = { socket, userId: user.id, tripId: null, alive: true };
    clients.add(client);
    send(socket, { type: 'hello', userId: user.id });

    socket.on('pong', () => { client.alive = true; });

    socket.on('message', (raw) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(socket, { type: 'error', message: 'malformed frame' });
      }

      switch (msg.type) {
        case 'subscribe': {
          const tripId = String(msg.tripId ?? '');
          if (!store.isMember(tripId, client.userId)) {
            return send(socket, { type: 'error', message: 'not a member of that trip' });
          }
          const previous = client.tripId;
          client.tripId = tripId;
          send(socket, { type: 'subscribed', tripId });
          if (previous && previous !== tripId) announcePresence(previous);
          announcePresence(tripId);
          break;
        }

        case 'location': {
          if (!client.tripId) return;
          const lat = Number(msg.lat);
          const lng = Number(msg.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
          const heading = Number.isFinite(Number(msg.heading)) ? Number(msg.heading) : null;
          const speed = Number.isFinite(Number(msg.speed)) ? Number(msg.speed) : null;

          const pkey = `${client.tripId}:${client.userId}`;
          const at = Date.now();
          if (at - (lastPersist.get(pkey) ?? 0) > PERSIST_EVERY_MS) {
            lastPersist.set(pkey, at);
            store.recordLocation(client.tripId, client.userId, { lat, lng, heading, speed });
          }
          // relay live to the rest of the car regardless of persistence cadence
          broadcast(
            client.tripId,
            { type: 'member:location', tripId: client.tripId, userId: client.userId, lat, lng, heading, speed, at },
            client.userId,
          );
          break;
        }

        case 'ping':
          send(socket, { type: 'hello', userId: client.userId });
          break;
      }
    });

    socket.on('close', () => {
      clients.delete(client);
      if (client.tripId) announcePresence(client.tripId);
    });

    socket.on('error', () => {
      clients.delete(client);
    });
  });

  // Reap sockets that died without a close frame — common when a phone loses signal.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.socket.terminate();
        clients.delete(c);
        if (c.tripId) announcePresence(c.tripId);
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));
}
