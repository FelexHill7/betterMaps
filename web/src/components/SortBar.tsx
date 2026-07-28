import { useStore } from '../store.ts';
import { SORT_OPTIONS, sortOption } from '../lib/sorting.ts';

/**
 * The driver's control. Sorts that need data we don't have are disabled with the
 * reason spelled out, rather than silently producing a meaningless order.
 */
export function SortBar() {
  const sortMode = useStore((s) => s.sortMode);
  const setSort = useStore((s) => s.setSort);
  const myPos = useStore((s) => s.myPos);
  const trip = useStore((s) => s.trip);

  const hasDest = trip?.dest_lat != null && trip?.dest_lng != null;
  const active = sortOption(sortMode);

  const blockedReason = (needsMe?: boolean, needsDest?: boolean): string | null => {
    if (needsMe && !myPos) return 'Needs your location';
    if (needsDest && !hasDest) return 'Needs a trip destination';
    return null;
  };

  return (
    <div className="sortbar">
      <div className="sortbar-scroll">
        {SORT_OPTIONS.map((opt) => {
          const blocked = blockedReason(opt.needsMe, opt.needsDest);
          return (
            <button
              key={opt.key}
              className={`sort-btn ${sortMode === opt.key ? 'sort-btn-active' : ''}`}
              disabled={!!blocked}
              title={blocked ?? opt.hint}
              onClick={() => setSort(opt.key)}
            >
              {opt.short}
            </button>
          );
        })}
      </div>
      <div className="sort-hint">
        {blockedReason(active.needsMe, active.needsDest) ?? active.hint}
      </div>
    </div>
  );
}
