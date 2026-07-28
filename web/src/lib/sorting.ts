import type { Stop } from './types.ts';
import { detourM, distanceM, estimateDriveSeconds, formatDistance, formatDuration, formatMoney, priceGlyph, type LatLng } from './geo.ts';

export type SortMode =
  | 'queue'
  | 'nearest'
  | 'detour'
  | 'votes'
  | 'rating'
  | 'cheapest'
  | 'recent';

export interface SortOption {
  key: SortMode;
  label: string;
  short: string;
  hint: string;
  /** Sorts that are meaningless without a current position. */
  needsMe?: boolean;
  /** Sorts that additionally need somewhere to be heading. */
  needsDest?: boolean;
}

export const SORT_OPTIONS: SortOption[] = [
  { key: 'nearest', label: 'Nearest to me', short: 'Nearest', hint: 'Closest first, straight-line from where you are now', needsMe: true },
  { key: 'detour', label: 'Least detour', short: 'Detour', hint: 'Cheapest to add without losing ground toward the destination', needsMe: true, needsDest: true },
  { key: 'votes', label: 'Most wanted', short: 'Votes', hint: 'What the car actually voted for' },
  { key: 'rating', label: 'Best rated', short: 'Rated', hint: 'Crew ratings first, then how well-known the place is' },
  { key: 'cheapest', label: 'Cheapest', short: 'Cheapest', hint: 'Lowest estimated spend per person' },
  { key: 'queue', label: 'Trip order', short: 'Planned', hint: 'The order you planned, drag to rearrange' },
  { key: 'recent', label: 'Just added', short: 'Newest', hint: 'Most recently added first' },
];

export const sortOption = (key: SortMode) =>
  SORT_OPTIONS.find((o) => o.key === key) ?? SORT_OPTIONS[0];

export interface SortContext {
  /** Where the phone (usually the driver's) is right now. */
  me: LatLng | null;
  /** Where the trip is ultimately headed, if set. */
  dest: LatLng | null;
  /** Fallback per-person cost by category, from the server's category table. */
  typicalCents: Record<string, number>;
}

/** Everything derived about a stop that the UI wants to show or sort on. */
export interface StopMetrics {
  distanceM: number | null;
  detourM: number | null;
  etaSeconds: number | null;
  netVotes: number;
  /** 0-5 crew rating, or null if nobody has rated it yet. */
  rating: number | null;
  /** 0-100 OSM prominence, stored in rating_count on import. */
  prominence: number | null;
  costCents: number | null;
  costIsEstimate: boolean;
  priceLevel: number | null;
}

export function metricsFor(stop: Stop, ctx: SortContext): StopMetrics {
  const at = { lat: stop.lat, lng: stop.lng };
  const dist = ctx.me ? distanceM(ctx.me, at) : null;
  const detour = ctx.me && ctx.dest ? detourM(ctx.me, at, ctx.dest) : null;

  const explicitCost = stop.est_cost_cents;
  const fallbackCost = ctx.typicalCents[stop.category];
  const costCents = explicitCost ?? fallbackCost ?? null;

  return {
    distanceM: dist,
    detourM: detour,
    etaSeconds: dist == null ? null : estimateDriveSeconds(dist),
    netVotes: (stop.up_votes ?? 0) - (stop.down_votes ?? 0),
    rating: stop.rating,
    prominence: stop.rating_count,
    costCents,
    costIsEstimate: explicitCost == null,
    priceLevel: stop.price_level,
  };
}

/**
 * Missing data always sorts last, in both directions — a stop nobody has rated
 * is not the best-rated stop. These are separate functions rather than one with
 * a direction flag: swapping the arguments to reverse the order would also
 * reverse the null handling, which is the opposite of what we want.
 */
function ascNullsLast(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

function descNullsLast(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

export interface RankedStop {
  stop: Stop;
  metrics: StopMetrics;
}

/**
 * Orders the queue for display. Arrived and skipped stops always sink below
 * live ones — the driver's list should only ever open on things still ahead.
 */
export function rankStops(stops: Stop[], mode: SortMode, ctx: SortContext): RankedStop[] {
  const ranked: RankedStop[] = stops.map((stop) => ({ stop, metrics: metricsFor(stop, ctx) }));

  const statusRank = (s: Stop) => (s.status === 'queued' ? 0 : s.status === 'arrived' ? 1 : 2);

  const compare = (a: RankedStop, b: RankedStop): number => {
    switch (mode) {
      case 'nearest':
        return ascNullsLast(a.metrics.distanceM, b.metrics.distanceM);
      case 'detour':
        // fall back to raw distance when we have no destination to detour from
        return a.metrics.detourM != null || b.metrics.detourM != null
          ? ascNullsLast(a.metrics.detourM, b.metrics.detourM)
          : ascNullsLast(a.metrics.distanceM, b.metrics.distanceM);
      case 'votes':
        return (
          b.metrics.netVotes - a.metrics.netVotes ||
          descNullsLast(a.metrics.rating, b.metrics.rating)
        );
      case 'rating':
        return (
          descNullsLast(a.metrics.rating, b.metrics.rating) ||
          descNullsLast(a.metrics.prominence, b.metrics.prominence) ||
          b.metrics.netVotes - a.metrics.netVotes
        );
      case 'cheapest':
        return (
          ascNullsLast(a.metrics.costCents, b.metrics.costCents) ||
          ascNullsLast(a.stop.price_level, b.stop.price_level)
        );
      case 'recent':
        return b.stop.created_at - a.stop.created_at;
      case 'queue':
      default:
        return a.stop.order_index - b.stop.order_index;
    }
  };

  return ranked.sort(
    (a, b) =>
      statusRank(a.stop) - statusRank(b.stop) ||
      compare(a, b) ||
      a.stop.order_index - b.stop.order_index,
  );
}

/**
 * The one number worth showing on a row, chosen to match the active sort — so
 * the list always explains its own order at a glance.
 */
export function primaryBadge(
  m: StopMetrics,
  mode: SortMode,
  imperial: boolean,
): { text: string; tone: 'neutral' | 'good' | 'warn' } {
  switch (mode) {
    case 'nearest':
      return m.distanceM == null
        ? { text: 'no location', tone: 'warn' }
        : { text: formatDistance(m.distanceM, imperial), tone: 'neutral' };
    case 'detour': {
      if (m.detourM == null) {
        return m.distanceM == null
          ? { text: 'set a destination', tone: 'warn' }
          : { text: formatDistance(m.distanceM, imperial), tone: 'neutral' };
      }
      if (m.detourM < 400) return { text: 'on the way', tone: 'good' };
      return { text: `+${formatDistance(m.detourM, imperial)}`, tone: 'neutral' };
    }
    case 'votes':
      return m.netVotes === 0
        ? { text: 'no votes yet', tone: 'neutral' }
        : { text: `${m.netVotes > 0 ? '+' : ''}${m.netVotes}`, tone: m.netVotes > 0 ? 'good' : 'warn' };
    case 'rating':
      if (m.rating != null) return { text: `${m.rating.toFixed(1)}★ crew`, tone: 'good' };
      if (m.prominence != null) return { text: `${m.prominence} known`, tone: 'neutral' };
      return { text: 'unrated', tone: 'neutral' };
    case 'cheapest':
      return m.costCents == null
        ? { text: '—', tone: 'neutral' }
        : {
            text: m.costCents === 0 ? 'Free' : `${formatMoney(m.costCents)}${m.costIsEstimate ? ' est' : ''}`,
            tone: m.costCents === 0 ? 'good' : 'neutral',
          };
    case 'recent':
    case 'queue':
    default:
      // No sort-specific metric to justify; show drive time if we know where we
      // are, otherwise the price bracket.
      if (m.etaSeconds != null) return { text: formatDuration(m.etaSeconds), tone: 'neutral' };
      return { text: priceGlyph(m.priceLevel), tone: 'neutral' };
  }
}
