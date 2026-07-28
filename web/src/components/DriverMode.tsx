import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import {
  estimateDriveSeconds, formatDistance, formatDuration, formatEta, navigationUrl,
} from '../lib/geo.ts';
import { primaryBadge, rankStops, sortOption, SORT_OPTIONS } from '../lib/sorting.ts';
import { iconFor } from './MapCanvas.tsx';

/**
 * Full-screen view for the phone in the cradle. Everything here is sized to be
 * read and hit at a glance: one decision (the next stop), three actions, and a
 * short list of alternatives in whatever order the driver asked for.
 */
export function DriverMode({ onExit }: { onExit: () => void }) {
  const { stops, sortMode, myPos, trip, typicalCents, imperial, unreadChat } = useStore();
  const patchStop = useStore((s) => s.patchStop);
  const setSort = useStore((s) => s.setSort);

  const [realEta, setRealEta] = useState<{ stopId: string; seconds: number; metres: number } | null>(
    null,
  );

  const ranked = useMemo(
    () =>
      rankStops(stops, sortMode, {
        me: myPos,
        dest:
          trip?.dest_lat != null && trip?.dest_lng != null
            ? { lat: trip.dest_lat, lng: trip.dest_lng }
            : null,
        typicalCents,
      }).filter((r) => r.stop.status === 'queued'),
    [stops, sortMode, myPos, trip?.dest_lat, trip?.dest_lng, typicalCents],
  );

  const next = ranked[0];
  const rest = ranked.slice(1, 6);

  // Straight-line ETA is fine for the list; for the stop we're actually driving
  // to, spend one routing call on a real road distance and time.
  useEffect(() => {
    if (!next || !myPos) return setRealEta(null);
    let cancelled = false;
    const target = next.stop;
    api
      .route([myPos, { lat: target.lat, lng: target.lng }])
      .then(({ route }) => {
        if (!cancelled) {
          setRealEta({ stopId: target.id, seconds: route.durationS, metres: route.distanceM });
        }
      })
      .catch(() => {
        if (!cancelled) setRealEta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [next?.stop.id, myPos?.lat.toFixed(3), myPos?.lng.toFixed(3)]);

  const useReal = realEta && next && realEta.stopId === next.stop.id;
  const metres = useReal ? realEta.metres : next?.metrics.distanceM ?? null;
  const seconds = useReal
    ? realEta.seconds
    : metres != null
      ? estimateDriveSeconds(metres)
      : null;

  const activeSort = sortOption(sortMode);
  const sortIsUsable = !(activeSort.needsMe && !myPos) &&
    !(activeSort.needsDest && (trip?.dest_lat == null || trip?.dest_lng == null));

  return (
    <div className="driver">
      <div className="driver-top">
        <span className="driver-label">Driver mode</span>
        <span className="grow" />
        {unreadChat > 0 && <span className="chip chip-accent">{unreadChat} new</span>}
        <button className="btn btn-ghost" onClick={onExit}>
          Exit
        </button>
      </div>

      {!myPos && (
        <div className="map-note map-note-warn">
          No location yet — distances and “nearest” are unavailable. Allow location access, or
          long-press the map outside driver mode to place yourself.
        </div>
      )}

      {next ? (
        <div className="driver-card">
          <div>
            <span className="driver-label" style={{ color: 'var(--text-faint)' }}>
              Next stop · {iconFor(next.stop.category)} {next.stop.category.replace('_', ' ')}
            </span>
            <div className="driver-name">{next.stop.name}</div>
            {next.stop.notes && (
              <div className="muted" style={{ marginTop: 6 }}>{next.stop.notes}</div>
            )}
          </div>

          <div className="driver-stats">
            <div className="driver-stat">
              <span>Distance</span>
              <b>{metres != null ? formatDistance(metres, imperial) : '—'}</b>
            </div>
            <div className="driver-stat">
              <span>Drive</span>
              <b>{seconds != null ? formatDuration(seconds) : '—'}</b>
            </div>
            <div className="driver-stat">
              <span>Arrive</span>
              <b>{seconds != null ? formatEta(seconds) : '—'}</b>
            </div>
            {next.metrics.costCents != null && (
              <div className="driver-stat">
                <span>Est. each</span>
                <b>
                  {next.metrics.costCents === 0
                    ? 'Free'
                    : `$${(next.metrics.costCents / 100).toFixed(0)}`}
                </b>
              </div>
            )}
          </div>

          <div className="driver-actions">
            <a
              className="btn btn-primary driver-nav"
              href={navigationUrl({ lat: next.stop.lat, lng: next.stop.lng })}
              target="_blank"
              rel="noreferrer"
            >
              ➤ Navigate there
            </a>
            <button
              className="btn"
              onClick={() => patchStop(next.stop.id, { status: 'arrived' })}
            >
              ✓ Arrived
            </button>
            <button
              className="btn"
              onClick={() => patchStop(next.stop.id, { status: 'skipped' })}
            >
              ✕ Skip
            </button>
          </div>
        </div>
      ) : (
        <div className="driver-card">
          <div className="driver-name">Queue is clear</div>
          <div className="muted">
            Nothing left to stop for. Ask a passenger to add something, or head for{' '}
            {trip?.dest_name ?? 'the destination'}.
          </div>
        </div>
      )}

      <div>
        <div className="row" style={{ gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
          {SORT_OPTIONS.filter((o) => o.key !== 'recent').map((opt) => {
            const blocked =
              (opt.needsMe && !myPos) ||
              (opt.needsDest && (trip?.dest_lat == null || trip?.dest_lng == null));
            return (
              <button
                key={opt.key}
                className={`sort-btn ${sortMode === opt.key ? 'sort-btn-active' : ''}`}
                style={{ padding: '10px 15px', fontSize: 14 }}
                disabled={!!blocked}
                onClick={() => setSort(opt.key)}
              >
                {opt.short}
              </button>
            );
          })}
        </div>
        {!sortIsUsable && (
          <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
            Showing trip order instead — {activeSort.label.toLowerCase()} needs more data.
          </div>
        )}
      </div>

      <div className="driver-upnext">
        {rest.map(({ stop, metrics }) => {
          const badge = primaryBadge(metrics, sortMode, imperial);
          return (
            <button
              key={stop.id}
              className="driver-upnext-row"
              onClick={() => {
                // Promote it to the front of the planned order so it becomes "next".
                const ids = [
                  stop.id,
                  ...stops
                    .filter((s) => s.id !== stop.id)
                    .sort((a, b) => a.order_index - b.order_index)
                    .map((s) => s.id),
                ];
                void useStore.getState().reorder(ids);
                setSort('queue');
              }}
            >
              <span style={{ fontSize: 21 }}>{iconFor(stop.category)}</span>
              <span className="grow">
                <b className="truncate" style={{ display: 'block' }}>{stop.name}</b>
                <span className="faint" style={{ fontSize: 12 }}>
                  {metrics.netVotes !== 0 && `${metrics.netVotes > 0 ? '+' : ''}${metrics.netVotes} votes · `}
                  tap to make it next
                </span>
              </span>
              <span
                className={`badge-metric ${
                  badge.tone === 'good' ? 'badge-metric-good' : badge.tone === 'warn' ? 'badge-metric-warn' : ''
                }`}
              >
                {badge.text}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
