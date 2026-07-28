import { useState } from 'react';
import { useStore } from '../store.ts';
import { distanceM, formatDistance, formatDuration, estimateDriveSeconds, navigationUrl } from '../lib/geo.ts';
import { iconFor } from './MapCanvas.tsx';
import type { Stop } from '../lib/types.ts';

export function StopDetail({ stop, onClose }: { stop: Stop; onClose: () => void }) {
  const { categories, myPos, imperial, members, expenses } = useStore();
  const patchStop = useStore((s) => s.patchStop);
  const removeStop = useStore((s) => s.removeStop);
  const addExpense = useStore((s) => s.addExpense);
  const send = useStore((s) => s.send);

  const [notes, setNotes] = useState(stop.notes ?? '');
  const [cost, setCost] = useState(
    stop.est_cost_cents != null ? (stop.est_cost_cents / 100).toFixed(2) : '',
  );
  const [spend, setSpend] = useState('');
  const [saving, setSaving] = useState(false);

  const away = myPos ? distanceM(myPos, stop) : null;
  const addedBy = members.find((m) => m.id === stop.added_by);
  const stopExpenses = expenses.filter((e) => e.stop_id === stop.id);
  const spentHere = stopExpenses.reduce((sum, e) => sum + e.amount_cents, 0);

  async function saveDetails() {
    setSaving(true);
    const parsed = cost.trim() === '' ? null : Math.round(Number(cost) * 100);
    await patchStop(stop.id, {
      notes: notes.trim(),
      ...(Number.isFinite(parsed as number) || parsed === null ? { estCostCents: parsed } : {}),
    });
    setSaving(false);
    onClose();
  }

  async function logSpend() {
    const amount = Math.round(Number(spend) * 100);
    if (!Number.isFinite(amount) || amount <= 0) return;
    await addExpense({ amountCents: amount, label: stop.name, stopId: stop.id });
    setSpend('');
  }

  async function rate(stars: number) {
    // Rating something implies you were there — check in if we haven't already.
    await patchStop(stop.id, {
      rating: stars,
      ...(stop.status === 'queued' ? { status: 'arrived' } : {}),
    });
  }

  const category = categories.find((c) => c.key === stop.category);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span style={{ fontSize: 22 }}>{iconFor(stop.category)}</span>
          <h2>{stop.name}</h2>
          <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {stop.address && <div className="faint" style={{ fontSize: 13 }}>{stop.address}</div>}

          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {category && <span className="chip">{category.label}</span>}
            {away != null && (
              <span className="chip">
                {formatDistance(away, imperial)} · ~{formatDuration(estimateDriveSeconds(away))}
              </span>
            )}
            <span className="chip">
              {stop.up_votes} up · {stop.down_votes} down
            </span>
            {stop.status === 'arrived' && <span className="chip chip-good">✓ Visited</span>}
            {stop.status === 'skipped' && <span className="chip">Skipped</span>}
            {addedBy && (
              <span className="chip">
                {addedBy.emoji} added by {addedBy.name}
              </span>
            )}
          </div>

          <div className="field">
            <label>Crew rating</label>
            <div className="row">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className="btn btn-ghost btn-icon"
                  title={`${n} star${n > 1 ? 's' : ''}`}
                  onClick={() => rate(n)}
                  style={{
                    color: stop.rating != null && stop.rating >= n ? 'var(--warn)' : 'var(--text-faint)',
                    fontSize: 17,
                  }}
                >
                  ★
                </button>
              ))}
              <span className="muted" style={{ fontSize: 13 }}>
                {stop.rating != null ? `${stop.rating.toFixed(1)} / 5` : 'not rated yet'}
              </span>
            </div>
          </div>

          <div className="field">
            <label htmlFor="stop-notes">Notes for the crew</label>
            <input
              id="stop-notes"
              className="input"
              value={notes}
              placeholder="Order the animal-style fries"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
            <div className="field grow">
              <label htmlFor="stop-cost">Est. per person ($)</label>
              <input
                id="stop-cost"
                className="input"
                type="number"
                min="0"
                step="0.50"
                value={cost}
                placeholder="12.00"
                onChange={(e) => setCost(e.target.value)}
              />
            </div>
            <div className="field grow">
              <label htmlFor="stop-spend">Log what you paid ($)</label>
              <div className="row">
                <input
                  id="stop-spend"
                  className="input grow"
                  type="number"
                  min="0"
                  step="0.01"
                  value={spend}
                  placeholder="0.00"
                  onChange={(e) => setSpend(e.target.value)}
                />
                <button className="btn" disabled={!spend.trim()} onClick={logSpend}>
                  Log
                </button>
              </div>
            </div>
          </div>
          {spentHere > 0 && (
            <div className="faint" style={{ fontSize: 12 }}>
              ${(spentHere / 100).toFixed(2)} logged here across {stopExpenses.length}{' '}
              {stopExpenses.length === 1 ? 'payment' : 'payments'}
            </div>
          )}

          <div className="row" style={{ flexWrap: 'wrap', gap: 7 }}>
            {stop.status !== 'queued' ? (
              <button className="btn" onClick={() => patchStop(stop.id, { status: 'queued' })}>
                Put back in queue
              </button>
            ) : (
              <>
                <button
                  className="btn btn-primary"
                  onClick={() => patchStop(stop.id, { status: 'arrived' })}
                >
                  ✓ Check in
                </button>
                <button className="btn" onClick={() => patchStop(stop.id, { status: 'skipped' })}>
                  Skip it
                </button>
              </>
            )}
            <a
              className="btn"
              href={navigationUrl({ lat: stop.lat, lng: stop.lng })}
              target="_blank"
              rel="noreferrer"
            >
              ➤ Navigate
            </a>
            <button
              className="btn"
              onClick={() => {
                void send(`Thoughts on ${stop.name}?`, stop.id);
                onClose();
              }}
            >
              💬 Ask the car
            </button>
          </div>
        </div>

        <div className="modal-foot">
          <button
            className="btn btn-ghost btn-danger"
            onClick={() => {
              void removeStop(stop.id);
              onClose();
            }}
          >
            Remove
          </button>
          <span className="grow" />
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={saveDetails}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
