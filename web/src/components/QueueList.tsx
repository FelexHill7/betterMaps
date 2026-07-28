import { useMemo } from 'react';
import { useStore } from '../store.ts';
import { primaryBadge, rankStops, type RankedStop } from '../lib/sorting.ts';
import { formatDistance, formatMoney } from '../lib/geo.ts';
import { iconFor } from './MapCanvas.tsx';
import type { Stop } from '../lib/types.ts';

interface Props {
  onOpenStop: (stop: Stop) => void;
  onAddStop: () => void;
}

export function QueueList({ onOpenStop, onAddStop }: Props) {
  const { stops, sortMode, myPos, trip, typicalCents, imperial, user, members } = useStore();
  const vote = useStore((s) => s.vote);
  const reorder = useStore((s) => s.reorder);

  const ranked = useMemo(
    () =>
      rankStops(stops, sortMode, {
        me: myPos,
        dest:
          trip?.dest_lat != null && trip?.dest_lng != null
            ? { lat: trip.dest_lat, lng: trip.dest_lng }
            : null,
        typicalCents,
      }),
    [stops, sortMode, myPos, trip?.dest_lat, trip?.dest_lng, typicalCents],
  );

  const queued = ranked.filter((r) => r.stop.status === 'queued');
  const nextId = queued[0]?.stop.id ?? null;

  const myVote = (stop: Stop): -1 | 0 | 1 => {
    if (!user) return 0;
    const entry = (stop.voters ?? '').split(',').find((e) => e.startsWith(`${user.id}:`));
    if (!entry) return 0;
    return entry.endsWith(':-1') ? -1 : 1;
  };

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? 'someone';

  /** Moves a stop within the planned order. Only offered in trip-order mode,
   *  where the displayed sequence is the thing being edited. */
  const move = (stopId: string, delta: -1 | 1) => {
    const ids = [...stops].sort((a, b) => a.order_index - b.order_index).map((s) => s.id);
    const from = ids.indexOf(stopId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void reorder(ids);
  };

  if (!stops.length) {
    return (
      <div className="empty">
        <div className="empty-icon">🗺️</div>
        <b>Nothing in the queue yet</b>
        <div>
          Add the places anyone wants to hit — burger joints, overlooks, gas — and the driver can
          re-sort them by whatever matters right now.
        </div>
        <button className="btn btn-primary" onClick={onAddStop} style={{ marginTop: 4 }}>
          Add the first stop
        </button>
      </div>
    );
  }

  const orderable = sortMode === 'queue';
  const orderIds = [...stops].sort((a, b) => a.order_index - b.order_index).map((s) => s.id);

  return (
    <div className="queue">
      {ranked.map((entry, i) => (
        <StopRow
          key={entry.stop.id}
          entry={entry}
          rank={i + 1}
          isNext={entry.stop.id === nextId}
          imperial={imperial}
          sortMode={sortMode}
          myVote={myVote(entry.stop)}
          addedBy={nameOf(entry.stop.added_by)}
          orderable={orderable}
          canMoveUp={orderable && orderIds.indexOf(entry.stop.id) > 0}
          canMoveDown={orderable && orderIds.indexOf(entry.stop.id) < orderIds.length - 1}
          onMove={move}
          onVote={(v) => vote(entry.stop.id, v)}
          onOpen={() => onOpenStop(entry.stop)}
        />
      ))}
    </div>
  );
}

interface RowProps {
  entry: RankedStop;
  rank: number;
  isNext: boolean;
  imperial: boolean;
  sortMode: ReturnType<typeof useStore.getState>['sortMode'];
  myVote: -1 | 0 | 1;
  addedBy: string;
  orderable: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (stopId: string, delta: -1 | 1) => void;
  onVote: (value: -1 | 0 | 1) => void;
  onOpen: () => void;
}

function StopRow({
  entry, rank, isNext, imperial, sortMode, myVote, addedBy,
  orderable, canMoveUp, canMoveDown, onMove, onVote, onOpen,
}: RowProps) {
  const { stop, metrics } = entry;
  const badge = primaryBadge(metrics, sortMode, imperial);
  const done = stop.status !== 'queued';

  return (
    <div
      className={`stop-row ${isNext ? 'stop-row-next' : ''} ${done ? 'stop-row-done' : ''}`}
    >
      <div className="stop-rank">
        {orderable ? (
          <>
            <button
              className="vote-btn"
              disabled={!canMoveUp}
              title="Move earlier"
              onClick={() => onMove(stop.id, -1)}
            >
              ▲
            </button>
            <b>{rank}</b>
            <button
              className="vote-btn"
              disabled={!canMoveDown}
              title="Move later"
              onClick={() => onMove(stop.id, 1)}
            >
              ▼
            </button>
          </>
        ) : (
          <>
            <b>{rank}</b>
            <span className="stop-icon">{iconFor(stop.category)}</span>
          </>
        )}
      </div>

      <button className="stop-main" onClick={onOpen} style={{ textAlign: 'left' }}>
        <div className="stop-name">
          {done ? <s>{stop.name}</s> : stop.name}
          {isNext && <span className="chip chip-accent">Next up</span>}
          {stop.status === 'arrived' && <span className="chip chip-good">✓ Visited</span>}
          {stop.status === 'skipped' && <span className="chip">Skipped</span>}
        </div>
        <div className="stop-meta">
          {metrics.costCents != null && (
            <em>
              {metrics.costCents === 0 ? 'Free' : formatMoney(metrics.costCents)}
              {metrics.costIsEstimate && metrics.costCents > 0 ? ' est' : ''}
            </em>
          )}
          {metrics.rating != null && <em>{metrics.rating.toFixed(1)}★</em>}
          {sortMode !== 'nearest' && metrics.distanceM != null && (
            <span>{formatDistance(metrics.distanceM, imperial)} away</span>
          )}
          <span>by {addedBy}</span>
        </div>
        {stop.notes && <div className="stop-notes">{stop.notes}</div>}
      </button>

      <div className="stop-side">
        <div
          className={`badge-metric ${
            badge.tone === 'good' ? 'badge-metric-good' : badge.tone === 'warn' ? 'badge-metric-warn' : ''
          }`}
        >
          {badge.text}
        </div>
        <div className="vote-group">
          <button
            className={`vote-btn ${myVote === 1 ? 'vote-btn-on-up' : ''}`}
            title="I want to stop here"
            onClick={() => onVote(myVote === 1 ? 0 : 1)}
          >
            ▲
          </button>
          <span className="vote-count">{metrics.netVotes}</span>
          <button
            className={`vote-btn ${myVote === -1 ? 'vote-btn-on-down' : ''}`}
            title="Rather skip it"
            onClick={() => onVote(myVote === -1 ? 0 : -1)}
          >
            ▼
          </button>
        </div>
      </div>
    </div>
  );
}
