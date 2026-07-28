import type {
  Category, Expense, Member, Message, PlaceResult, RouteResult, Stop, Trip, TripSnapshot, User,
} from './types.ts';

const TOKEN_KEY = 'bettermaps.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) =>
  t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach betterMaps — check your connection');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, 'Server sent a malformed response');
  }

  if (!res.ok) {
    const message = (payload as { error?: string })?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return payload as T;
}

const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, b?: unknown) => request<T>('POST', p, b);
const patch = <T>(p: string, b?: unknown) => request<T>('PATCH', p, b);
const del = <T>(p: string) => request<T>('DELETE', p);

const qs = (params: Record<string, string | number | undefined | null>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export interface NewStop {
  name: string;
  category?: string;
  address?: string | null;
  lat: number;
  lng: number;
  priceLevel?: number | null;
  estCostCents?: number | null;
  prominence?: number | null;
  notes?: string | null;
  source?: string;
  externalRef?: string | null;
}

export const api = {
  // session
  signUp: (name: string) => post<{ user: User; token: string }>('/session', { name }),
  me: () => get<{ user: User; trips: Trip[] }>('/session'),
  rename: (name: string) => patch<{ user: User }>('/session', { name }),

  // trips
  trips: () => get<{ trips: Trip[] }>('/trips'),
  createTrip: (draft: {
    name: string;
    origin?: { name: string; lat: number; lng: number } | null;
    dest?: { name: string; lat: number; lng: number } | null;
    startsOn?: string | null;
    budgetCents?: number;
  }) => post<{ trip: Trip }>('/trips', draft),
  joinTrip: (code: string) => post<{ trip: Trip }>('/trips/join', { code }),
  snapshot: (tripId: string) => get<TripSnapshot>(`/trips/${tripId}`),
  updateTrip: (tripId: string, patchBody: Record<string, unknown>) =>
    patch<{ trip: Trip }>(`/trips/${tripId}`, patchBody),
  setRole: (tripId: string, role: string) =>
    post<{ members: Member[] }>(`/trips/${tripId}/role`, { role }),
  leaveTrip: (tripId: string) => post<{ ok: true }>(`/trips/${tripId}/leave`),

  // stops
  addStop: (tripId: string, stop: NewStop) =>
    post<{ stop: Stop }>(`/trips/${tripId}/stops`, stop),
  updateStop: (tripId: string, stopId: string, patchBody: Record<string, unknown>) =>
    patch<{ stop: Stop }>(`/trips/${tripId}/stops/${stopId}`, patchBody),
  removeStop: (tripId: string, stopId: string) =>
    del<{ ok: true }>(`/trips/${tripId}/stops/${stopId}`),
  reorder: (tripId: string, ids: string[]) =>
    post<{ stops: Stop[] }>(`/trips/${tripId}/stops/reorder`, { ids }),
  vote: (tripId: string, stopId: string, value: -1 | 0 | 1) =>
    post<{ stop: Stop }>(`/trips/${tripId}/stops/${stopId}/vote`, { value }),

  // chat
  send: (tripId: string, body: string, stopId?: string | null) =>
    post<{ message: Message }>(`/trips/${tripId}/messages`, { body, stopId }),

  // money
  addExpense: (tripId: string, e: { amountCents: number; label: string; stopId?: string | null }) =>
    post<{ expenses: Expense[] }>(`/trips/${tripId}/expenses`, e),
  removeExpense: (tripId: string, expenseId: string) =>
    del<{ expenses: Expense[] }>(`/trips/${tripId}/expenses/${expenseId}`),

  // places
  categories: () => get<{ categories: Category[] }>('/places/categories'),
  search: (q: string, near?: { lat: number; lng: number }) =>
    get<{ results: PlaceResult[] }>(`/places/search${qs({ q, lat: near?.lat, lng: near?.lng })}`),
  nearby: (category: string, at: { lat: number; lng: number }, radius = 8000) =>
    get<{ results: PlaceResult[]; source: string; degraded: boolean; note?: string }>(
      `/places/nearby${qs({ category, lat: at.lat, lng: at.lng, radius })}`,
    ),
  reverse: (at: { lat: number; lng: number }) =>
    get<{ result: PlaceResult | null }>(`/places/reverse${qs({ lat: at.lat, lng: at.lng })}`),
  route: (points: Array<{ lat: number; lng: number }>) =>
    post<{ route: RouteResult }>('/route', { points }),
};
