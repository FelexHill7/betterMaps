import type { ServerEvent } from './types.ts';

type Listener = (event: ServerEvent) => void;
export type ConnectionState = 'offline' | 'connecting' | 'live';

/** Probe cadence, and how long silence may last before we call it dead. */
const HEARTBEAT_MS = 5_000;
const STALE_AFTER_MS = 12_000;

/**
 * Trip socket with backoff reconnect. Phones drop signal constantly on a road
 * trip, so this is written to survive it: reconnect forever, and re-subscribe to
 * whatever trip we were on so the caller doesn't have to care.
 */
class TripSocket {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private tripId: string | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private attempt = 0;
  private retryTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastInbound = 0;
  private closedByUs = false;
  private _state: ConnectionState = 'offline';

  get state() {
    return this._state;
  }

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStateChange(fn: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private setState(s: ConnectionState) {
    if (this._state === s) return;
    this._state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  connect(token: string): void {
    if (this.token === token && this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.token = token;
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    if (!this.token) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.setState('connecting');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.lastInbound = Date.now();
      this.setState('live');
      if (this.tripId) this.send({ type: 'subscribe', tripId: this.tripId });
      this.startHeartbeat();
    };

    ws.onmessage = (evt) => {
      this.lastInbound = Date.now();
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(evt.data as string) as ServerEvent;
      } catch {
        return;
      }
      for (const fn of this.listeners) fn(parsed);
    };

    ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      this.setState('offline');
      if (this.closedByUs) return;
      // 0.5s, 1s, 2s, 4s … capped at 15s
      const delay = Math.min(15_000, 500 * 2 ** this.attempt++);
      this.retryTimer = window.setTimeout(() => this.open(), delay);
    };

    ws.onerror = () => {
      // onclose always follows; the reconnect is handled there
    };
  }

  /**
   * A phone that drives into a dead zone does not get a close frame — the socket
   * just goes quiet, and the UI would keep claiming "live" until TCP eventually
   * gives up. So we probe, and if nothing comes back we declare it dead
   * ourselves. On a road trip a stale "live" badge is worse than no badge.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastInbound > STALE_AFTER_MS) {
        this.ws.close(); // triggers onclose → reconnect with backoff
        return;
      }
      this.send({ type: 'ping' });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  subscribe(tripId: string | null): void {
    this.tripId = tripId;
    if (tripId) this.send({ type: 'subscribe', tripId });
  }

  /** Vehicle position — fire-and-forget, dropped silently while offline. */
  pushLocation(loc: { lat: number; lng: number; heading?: number | null; speed?: number | null }): void {
    this.send({ type: 'location', ...loc });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  /** The OS knows about the radio before our probe does — react immediately. */
  handleBrowserOffline(): void {
    if (!this.token) return;
    this.setState('offline');
    this.ws?.close();
  }

  handleBrowserOnline(): void {
    if (!this.token || this.closedByUs) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.attempt = 0; // came back deliberately; don't sit out a long backoff
    this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    this.tripId = null;
    this.token = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.setState('offline');
  }
}

export const socket = new TripSocket();

window.addEventListener('offline', () => socket.handleBrowserOffline());
window.addEventListener('online', () => socket.handleBrowserOnline());
