import { create } from 'zustand';
import { api, ApiError, getToken, setToken, type NewStop } from './lib/api.ts';
import { socket, type ConnectionState } from './lib/socket.ts';
import type {
  Category, Expense, LivePosition, Member, Message, RouteResult, ServerEvent, Stop, Trip, User,
} from './lib/types.ts';
import type { LatLng } from './lib/geo.ts';
import type { SortMode } from './lib/sorting.ts';

const LAST_TRIP_KEY = 'bettermaps.lastTrip';
const UNITS_KEY = 'bettermaps.imperial';

interface State {
  // session
  user: User | null;
  booting: boolean;
  trips: Trip[];

  // active trip
  trip: Trip | null;
  members: Member[];
  stops: Stop[];
  messages: Message[];
  expenses: Expense[];
  loadingTrip: boolean;

  // live
  connection: ConnectionState;
  online: string[];
  live: Record<string, LivePosition>;
  myPos: LivePosition | null;
  locationError: string | null;
  simulating: boolean;

  // route
  route: RouteResult | null;
  routeError: string | null;
  routing: boolean;

  // ui
  sortMode: SortMode;
  imperial: boolean;
  categories: Category[];
  typicalCents: Record<string, number>;
  unreadChat: number;
  toast: { text: string; tone: 'info' | 'error' } | null;
  driverMode: boolean;

  // actions
  boot: () => Promise<void>;
  signUp: (name: string) => Promise<void>;
  rename: (name: string) => Promise<void>;
  signOut: () => void;
  createTrip: (draft: Parameters<typeof api.createTrip>[0]) => Promise<Trip>;
  joinTrip: (code: string) => Promise<Trip>;
  openTrip: (tripId: string) => Promise<void>;
  closeTrip: () => void;
  refreshTrips: () => Promise<void>;
  updateTrip: (patch: Record<string, unknown>) => Promise<void>;
  claimRole: (role: string) => Promise<void>;
  leaveTrip: () => Promise<void>;

  addStop: (stop: NewStop) => Promise<Stop | null>;
  patchStop: (stopId: string, patch: Record<string, unknown>) => Promise<void>;
  removeStop: (stopId: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
  vote: (stopId: string, value: -1 | 0 | 1) => Promise<void>;

  send: (body: string, stopId?: string | null) => Promise<void>;
  addExpense: (e: { amountCents: number; label: string; stopId?: string | null }) => Promise<void>;
  removeExpense: (id: string) => Promise<void>;

  setSort: (mode: SortMode) => void;
  toggleUnits: () => void;
  setDriverMode: (on: boolean) => void;
  markChatRead: () => void;
  notify: (text: string, tone?: 'info' | 'error') => void;
  dismissToast: () => void;

  setMyPos: (pos: LivePosition | null, opts?: { broadcast?: boolean }) => void;
  setLocationError: (msg: string | null) => void;
  setSimulating: (on: boolean) => void;
  recomputeRoute: () => Promise<void>;
}

/** Keeps a stop list ordered by order_index after in-place updates. */
const byOrder = (a: Stop, b: Stop) => a.order_index - b.order_index;

/**
 * Appends a message unless we already have it. The server broadcasts every
 * message to the whole trip, and that echo routinely beats the POST response
 * back to the sender — so both paths must be idempotent or the same message
 * lands twice.
 */
const withMessage = (existing: Message[], message: Message): Message[] =>
  existing.some((m) => m.id === message.id) ? existing : [...existing, message];

export const useStore = create<State>((set, get) => ({
  user: null,
  booting: true,
  trips: [],

  trip: null,
  members: [],
  stops: [],
  messages: [],
  expenses: [],
  loadingTrip: false,

  connection: 'offline',
  online: [],
  live: {},
  myPos: null,
  locationError: null,
  simulating: false,

  route: null,
  routeError: null,
  routing: false,

  sortMode: 'nearest',
  imperial: localStorage.getItem(UNITS_KEY) !== 'false',
  categories: [],
  typicalCents: {},
  unreadChat: 0,
  toast: null,
  driverMode: false,

  // -------------------------------------------------------------- session

  async boot() {
    // categories are static and needed everywhere; fetch regardless of auth
    api.categories()
      .then(({ categories }) =>
        set({
          categories,
          typicalCents: Object.fromEntries(categories.map((c) => [c.key, c.typicalCents])),
        }),
      )
      .catch(() => undefined);

    const token = getToken();
    if (!token) return set({ booting: false });

    try {
      const { user, trips } = await api.me();
      set({ user, trips, booting: false });
      socket.connect(token);
      const last = localStorage.getItem(LAST_TRIP_KEY);
      if (last && trips.some((t) => t.id === last)) await get().openTrip(last);
    } catch (err) {
      // a stale token from a wiped database shouldn't trap the user on a spinner
      if (err instanceof ApiError && err.status === 401) setToken(null);
      set({ booting: false });
    }
  },

  async signUp(name) {
    const { user, token } = await api.signUp(name);
    setToken(token);
    set({ user, trips: [] });
    socket.connect(token);
  },

  async rename(name) {
    const { user } = await api.rename(name);
    set({ user });
  },

  signOut() {
    socket.disconnect();
    setToken(null);
    localStorage.removeItem(LAST_TRIP_KEY);
    set({
      user: null, trips: [], trip: null, members: [], stops: [], messages: [],
      expenses: [], route: null, live: {}, online: [], driverMode: false,
    });
  },

  // -------------------------------------------------------------- trips

  async refreshTrips() {
    const { trips } = await api.trips();
    set({ trips });
  },

  async createTrip(draft) {
    const { trip } = await api.createTrip(draft);
    set({ trips: [trip, ...get().trips] });
    await get().openTrip(trip.id);
    return trip;
  },

  async joinTrip(code) {
    const { trip } = await api.joinTrip(code);
    const others = get().trips.filter((t) => t.id !== trip.id);
    set({ trips: [trip, ...others] });
    await get().openTrip(trip.id);
    return trip;
  },

  async openTrip(tripId) {
    set({ loadingTrip: true });
    try {
      const snap = await api.snapshot(tripId);
      localStorage.setItem(LAST_TRIP_KEY, tripId);
      // seed live positions from whatever each phone last reported
      const live: Record<string, LivePosition> = {};
      for (const m of snap.members) {
        if (m.last_lat != null && m.last_lng != null && m.last_loc_at != null) {
          live[m.id] = {
            lat: m.last_lat, lng: m.last_lng,
            heading: m.last_heading, speed: m.last_speed, at: m.last_loc_at,
          };
        }
      }
      set({
        trip: snap.trip,
        members: snap.members,
        stops: [...snap.stops].sort(byOrder),
        messages: snap.messages,
        expenses: snap.expenses,
        live,
        loadingTrip: false,
        unreadChat: 0,
        route: null,
        routeError: null,
      });
      socket.subscribe(tripId);
      void get().recomputeRoute();
    } catch (err) {
      set({ loadingTrip: false });
      get().notify(err instanceof Error ? err.message : 'Could not open that trip', 'error');
      throw err;
    }
  },

  closeTrip() {
    socket.subscribe(null);
    localStorage.removeItem(LAST_TRIP_KEY);
    set({
      trip: null, members: [], stops: [], messages: [], expenses: [],
      route: null, routeError: null, live: {}, online: [], driverMode: false,
    });
  },

  async updateTrip(patch) {
    const trip = get().trip;
    if (!trip) return;
    const { trip: updated } = await api.updateTrip(trip.id, patch);
    set({ trip: updated, trips: get().trips.map((t) => (t.id === updated.id ? updated : t)) });
    void get().recomputeRoute();
  },

  async claimRole(role) {
    const trip = get().trip;
    if (!trip) return;
    const { members } = await api.setRole(trip.id, role);
    set({ members });
  },

  async leaveTrip() {
    const trip = get().trip;
    if (!trip) return;
    await api.leaveTrip(trip.id);
    set({ trips: get().trips.filter((t) => t.id !== trip.id) });
    get().closeTrip();
  },

  // -------------------------------------------------------------- stops

  async addStop(stop) {
    const trip = get().trip;
    if (!trip) return null;
    try {
      const { stop: created } = await api.addStop(trip.id, stop);
      // the socket echo is skipped for our own action, so apply it locally
      set({ stops: [...get().stops.filter((s) => s.id !== created.id), created].sort(byOrder) });
      void get().recomputeRoute();
      return created;
    } catch (err) {
      get().notify(err instanceof Error ? err.message : 'Could not add that stop', 'error');
      return null;
    }
  },

  async patchStop(stopId, patch) {
    const trip = get().trip;
    if (!trip) return;
    const previous = get().stops;
    // optimistic: status flips and votes must feel instant in a moving car
    set({
      stops: previous
        .map((s) => (s.id === stopId ? ({ ...s, ...patch } as Stop) : s))
        .sort(byOrder),
    });
    try {
      const { stop } = await api.updateStop(trip.id, stopId, patch);
      set({ stops: get().stops.map((s) => (s.id === stop.id ? stop : s)).sort(byOrder) });
      if ('lat' in patch || 'status' in patch) void get().recomputeRoute();
    } catch (err) {
      set({ stops: previous });
      get().notify(err instanceof Error ? err.message : 'Update failed', 'error');
    }
  },

  async removeStop(stopId) {
    const trip = get().trip;
    if (!trip) return;
    const previous = get().stops;
    set({ stops: previous.filter((s) => s.id !== stopId) });
    try {
      await api.removeStop(trip.id, stopId);
      void get().recomputeRoute();
    } catch (err) {
      set({ stops: previous });
      get().notify(err instanceof Error ? err.message : 'Could not remove that stop', 'error');
    }
  },

  async reorder(ids) {
    const trip = get().trip;
    if (!trip) return;
    const previous = get().stops;
    const rank = new Map(ids.map((id, i) => [id, i + 1]));
    set({
      stops: previous
        .map((s) => ({ ...s, order_index: rank.get(s.id) ?? s.order_index }))
        .sort(byOrder),
    });
    try {
      const { stops } = await api.reorder(trip.id, ids);
      set({ stops: [...stops].sort(byOrder) });
      void get().recomputeRoute();
    } catch (err) {
      set({ stops: previous });
      get().notify(err instanceof Error ? err.message : 'Could not reorder', 'error');
    }
  },

  async vote(stopId, value) {
    const trip = get().trip;
    const me = get().user;
    if (!trip || !me) return;

    const previous = get().stops;
    // recompute the aggregate locally so the tap registers immediately
    set({
      stops: previous.map((s) => {
        if (s.id !== stopId) return s;
        const entries = (s.voters ?? '')
          .split(',')
          .filter(Boolean)
          .filter((e) => !e.startsWith(`${me.id}:`));
        if (value !== 0) entries.push(`${me.id}:${value}`);
        const up = entries.filter((e) => e.endsWith(':1')).length;
        const down = entries.filter((e) => e.endsWith(':-1')).length;
        return { ...s, voters: entries.join(','), up_votes: up, down_votes: down };
      }),
    });
    try {
      const { stop } = await api.vote(trip.id, stopId, value);
      set({ stops: get().stops.map((s) => (s.id === stop.id ? stop : s)).sort(byOrder) });
    } catch (err) {
      set({ stops: previous });
      get().notify(err instanceof Error ? err.message : 'Vote failed', 'error');
    }
  },

  // -------------------------------------------------------------- chat & money

  async send(body, stopId) {
    const trip = get().trip;
    if (!trip || !body.trim()) return;
    try {
      const { message } = await api.send(trip.id, body.trim(), stopId ?? null);
      set({ messages: withMessage(get().messages, message) });
    } catch (err) {
      get().notify(err instanceof Error ? err.message : 'Message not sent', 'error');
    }
  },

  async addExpense(e) {
    const trip = get().trip;
    if (!trip) return;
    try {
      const { expenses } = await api.addExpense(trip.id, e);
      set({ expenses });
    } catch (err) {
      get().notify(err instanceof Error ? err.message : 'Could not save that expense', 'error');
    }
  },

  async removeExpense(id) {
    const trip = get().trip;
    if (!trip) return;
    const { expenses } = await api.removeExpense(trip.id, id);
    set({ expenses });
  },

  // -------------------------------------------------------------- ui

  setSort(sortMode) {
    set({ sortMode });
  },

  toggleUnits() {
    const imperial = !get().imperial;
    localStorage.setItem(UNITS_KEY, String(imperial));
    set({ imperial });
  },

  setDriverMode(driverMode) {
    set({ driverMode });
  },

  markChatRead() {
    set({ unreadChat: 0 });
  },

  notify(text, tone = 'info') {
    set({ toast: { text, tone } });
    window.setTimeout(() => {
      if (get().toast?.text === text) set({ toast: null });
    }, 4000);
  },

  dismissToast() {
    set({ toast: null });
  },

  // -------------------------------------------------------------- location

  setMyPos(pos, opts = {}) {
    set({ myPos: pos, locationError: pos ? null : get().locationError });
    if (pos && opts.broadcast !== false) {
      socket.pushLocation({ lat: pos.lat, lng: pos.lng, heading: pos.heading, speed: pos.speed });
    }
    const me = get().user;
    if (pos && me) set({ live: { ...get().live, [me.id]: pos } });
  },

  setLocationError(locationError) {
    set({ locationError });
  },

  setSimulating(simulating) {
    set({ simulating });
  },

  // -------------------------------------------------------------- routing

  async recomputeRoute() {
    const { trip, stops } = get();
    if (!trip) return;

    // The planned line: origin → queued stops in trip order → destination.
    const points: LatLng[] = [];
    if (trip.origin_lat != null && trip.origin_lng != null) {
      points.push({ lat: trip.origin_lat, lng: trip.origin_lng });
    }
    for (const s of [...stops].sort(byOrder)) {
      if (s.status === 'queued') points.push({ lat: s.lat, lng: s.lng });
    }
    if (trip.dest_lat != null && trip.dest_lng != null) {
      points.push({ lat: trip.dest_lat, lng: trip.dest_lng });
    }

    if (points.length < 2) return set({ route: null, routeError: null });

    // OSRM's public demo server caps waypoints; keep the ends and thin the middle.
    const capped =
      points.length <= 25
        ? points
        : [points[0], ...points.slice(1, -1).filter((_, i) => i % Math.ceil((points.length - 2) / 23) === 0), points[points.length - 1]];

    set({ routing: true, routeError: null });
    try {
      const { route } = await api.route(capped);
      set({ route, routing: false });
    } catch (err) {
      set({
        route: null,
        routing: false,
        routeError: err instanceof Error ? err.message : 'Routing unavailable',
      });
    }
  },
}));

// ------------------------------------------------------------------ socket wiring

socket.onStateChange((connection) => useStore.setState({ connection }));

socket.onEvent((event: ServerEvent) => {
  const state = useStore.getState();
  // Ignore anything for a trip we're no longer looking at.
  if ('tripId' in event && event.tripId !== state.trip?.id) return;

  switch (event.type) {
    case 'stop:added': {
      const stops = [...state.stops.filter((s) => s.id !== event.stop.id), event.stop].sort(byOrder);
      useStore.setState({ stops });
      if (event.stop.added_by !== state.user?.id) {
        state.notify(`${event.by} added ${event.stop.name}`);
      }
      void state.recomputeRoute();
      break;
    }
    case 'stop:updated':
      useStore.setState({
        stops: state.stops.map((s) => (s.id === event.stop.id ? event.stop : s)).sort(byOrder),
      });
      break;
    case 'stop:removed':
      useStore.setState({ stops: state.stops.filter((s) => s.id !== event.stopId) });
      void state.recomputeRoute();
      break;
    case 'stops:reordered':
      useStore.setState({ stops: [...event.stops].sort(byOrder) });
      void state.recomputeRoute();
      break;
    case 'message:new': {
      const messages = withMessage(state.messages, event.message);
      if (messages === state.messages) break; // already had it
      const mine = event.message.user_id === state.user?.id;
      useStore.setState({
        messages,
        unreadChat:
          mine || event.message.kind === 'system' ? state.unreadChat : state.unreadChat + 1,
      });
      break;
    }
    case 'member:joined':
    case 'member:updated':
      useStore.setState({ members: event.members });
      break;
    case 'member:location':
      useStore.setState({
        live: {
          ...state.live,
          [event.userId]: {
            lat: event.lat, lng: event.lng,
            heading: event.heading, speed: event.speed, at: event.at,
          },
        },
      });
      break;
    case 'trip:updated':
      useStore.setState({ trip: event.trip });
      void state.recomputeRoute();
      break;
    case 'expense:changed':
      useStore.setState({ expenses: event.expenses });
      break;
    case 'presence':
      useStore.setState({ online: event.online });
      break;
  }
});
