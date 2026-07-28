export interface User {
  id: string;
  name: string;
  color: string;
  emoji: string;
  created_at: number;
}

export interface Member extends User {
  role: 'driver' | 'passenger' | 'organizer' | string;
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
  stop_count?: number;
}

export type StopStatus = 'queued' | 'arrived' | 'skipped';

export interface Stop {
  id: string;
  trip_id: string;
  name: string;
  category: string;
  address: string | null;
  lat: number;
  lng: number;
  order_index: number;
  status: StopStatus;
  price_level: number | null;
  est_cost_cents: number | null;
  rating: number | null;
  /** Reused to carry OSM prominence (0-100) for places we imported. */
  rating_count: number | null;
  notes: string | null;
  source: string;
  external_ref: string | null;
  added_by: string;
  created_at: number;
  arrived_at: number | null;
  up_votes: number;
  down_votes: number;
  /** "userId:1,userId:-1" — flattened from the votes table. */
  voters: string;
}

export interface Message {
  id: string;
  trip_id: string;
  user_id: string | null;
  kind: 'text' | 'system' | 'stop_ref' | string;
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

export interface Category {
  key: string;
  label: string;
  icon: string;
  typicalCents: number;
  priceLevel: number;
}

export interface PlaceResult {
  ref: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  category: string;
  prominence: number | null;
  priceLevel: number | null;
  estCostCents: number | null;
  tags: Record<string, string>;
  visits: number;
  crewRating: number | null;
}

export interface RouteResult {
  distanceM: number;
  durationS: number;
  legs: Array<{ distanceM: number; durationS: number }>;
  geometry: Array<[number, number]>;
}

export interface TripSnapshot {
  trip: Trip;
  members: Member[];
  stops: Stop[];
  messages: Message[];
  expenses: Expense[];
}

export interface LivePosition {
  lat: number;
  lng: number;
  heading: number | null;
  speed: number | null;
  at: number;
}

export type ServerEvent =
  | { type: 'hello'; userId: string }
  | { type: 'subscribed'; tripId: string }
  | { type: 'error'; message: string }
  | { type: 'stop:added'; tripId: string; stop: Stop; by: string }
  | { type: 'stop:updated'; tripId: string; stop: Stop }
  | { type: 'stop:removed'; tripId: string; stopId: string }
  | { type: 'stops:reordered'; tripId: string; stops: Stop[] }
  | { type: 'message:new'; tripId: string; message: Message }
  | { type: 'member:joined'; tripId: string; members: Member[] }
  | { type: 'member:updated'; tripId: string; members: Member[] }
  | {
      type: 'member:location';
      tripId: string;
      userId: string;
      lat: number;
      lng: number;
      heading: number | null;
      speed: number | null;
      at: number;
    }
  | { type: 'trip:updated'; tripId: string; trip: Trip }
  | { type: 'expense:changed'; tripId: string; expenses: Expense[] }
  | { type: 'presence'; tripId: string; online: string[] };
