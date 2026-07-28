import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import { distanceM, formatDistance, formatMoney, type LatLng } from '../lib/geo.ts';
import { iconFor } from './MapCanvas.tsx';
import type { PlaceResult } from '../lib/types.ts';

interface Props {
  /** Set when the sheet was opened by dropping a pin on the map. */
  seedPoint?: LatLng | null;
  onClose: () => void;
}

type Tab = 'nearby' | 'search' | 'pin';

export function AddStopSheet({ seedPoint, onClose }: Props) {
  const { categories, myPos, trip, imperial } = useStore();
  const addStop = useStore((s) => s.addStop);
  const notify = useStore((s) => s.notify);
  const setMyPos = useStore((s) => s.setMyPos);

  const [tab, setTab] = useState<Tab>(seedPoint ? 'pin' : myPos ? 'nearby' : 'search');
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  // Manual-pin fields
  const [pinName, setPinName] = useState('');
  const [pinCategory, setPinCategory] = useState('other');
  const [pinAddress, setPinAddress] = useState<string | null>(null);
  const [resolvingPin, setResolvingPin] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  /** Anchor for "nearby" and for distance labels: live position, else trip start. */
  const anchor: LatLng | null =
    myPos ??
    (trip?.origin_lat != null && trip.origin_lng != null
      ? { lat: trip.origin_lat, lng: trip.origin_lng }
      : null);

  // Ask the geocoder what the dropped pin actually is, so the user gets a
  // sensible default name instead of raw coordinates.
  useEffect(() => {
    if (!seedPoint) return;
    setResolvingPin(true);
    api
      .reverse(seedPoint)
      .then(({ result }) => {
        if (result) {
          setPinName(result.name);
          setPinAddress(result.address);
          if (result.category !== 'other') setPinCategory(result.category);
        }
      })
      .catch(() => undefined)
      .finally(() => setResolvingPin(false));
  }, [seedPoint?.lat, seedPoint?.lng]);

  useEffect(() => {
    if (tab === 'search') searchRef.current?.focus();
  }, [tab]);

  async function runNearby(key: string) {
    if (!anchor) return setError('No location yet — search by name instead.');
    setCategory(key);
    setLoading(true);
    setError(null);
    setNote(null);
    try {
      const res = await api.nearby(key, anchor, 12_000);
      setResults(res.results);
      if (res.degraded && res.note) setNote(res.note);
      if (!res.results.length) setError('Nothing of that kind within about 7 miles.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setNote(null);
    try {
      const { results: found } = await api.search(query.trim(), anchor ?? undefined);
      setResults(found);
      if (!found.length) setError(`Nothing found for “${query.trim()}”.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function add(place: PlaceResult) {
    setAdding(place.ref);
    const created = await addStop({
      name: place.name,
      category: place.category,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
      priceLevel: place.priceLevel,
      estCostCents: place.estCostCents,
      prominence: place.prominence,
      source: tab === 'search' ? 'search' : 'nearby',
      externalRef: place.ref,
    });
    setAdding(null);
    if (created) {
      notify(`${place.name} added to the queue`);
      onClose();
    }
  }

  async function addPin() {
    if (!seedPoint || !pinName.trim()) return;
    setAdding('pin');
    const cat = categories.find((c) => c.key === pinCategory);
    const created = await addStop({
      name: pinName.trim(),
      category: pinCategory,
      address: pinAddress,
      lat: seedPoint.lat,
      lng: seedPoint.lng,
      priceLevel: cat?.priceLevel ?? null,
      estCostCents: cat?.typicalCents ?? null,
      source: 'pin',
    });
    setAdding(null);
    if (created) {
      notify(`${pinName.trim()} added to the queue`);
      onClose();
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Add a stop</h2>
          <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tabs" style={{ padding: '0 16px 10px' }}>
          {seedPoint && (
            <button
              className={`tab ${tab === 'pin' ? 'tab-active' : ''}`}
              onClick={() => setTab('pin')}
            >
              Dropped pin
            </button>
          )}
          <button
            className={`tab ${tab === 'nearby' ? 'tab-active' : ''}`}
            onClick={() => setTab('nearby')}
          >
            Nearby
          </button>
          <button
            className={`tab ${tab === 'search' ? 'tab-active' : ''}`}
            onClick={() => setTab('search')}
          >
            Search
          </button>
        </div>

        <div className="modal-body">
          {tab === 'pin' && seedPoint && (
            <>
              <div className="faint" style={{ fontSize: 12 }}>
                {seedPoint.lat.toFixed(5)}, {seedPoint.lng.toFixed(5)}
                {resolvingPin && ' · looking up what’s here…'}
              </div>
              {!myPos && (
                <button
                  className="btn btn-ghost btn-block"
                  onClick={() => {
                    setMyPos({ ...seedPoint, heading: null, speed: null, at: Date.now() });
                    notify('Position set — distance sorting is live');
                    onClose();
                  }}
                >
                  📍 Actually, this is where I am
                </button>
              )}
              <div className="field">
                <label htmlFor="pin-name">What is it?</label>
                <input
                  id="pin-name"
                  className="input"
                  value={pinName}
                  placeholder="Name this spot"
                  onChange={(e) => setPinName(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Kind of stop</label>
                <div className="cat-grid">
                  {categories.map((c) => (
                    <button
                      key={c.key}
                      className={`cat-btn ${pinCategory === c.key ? 'cat-btn-active' : ''}`}
                      onClick={() => setPinCategory(c.key)}
                    >
                      <span>{c.icon}</span>
                      <span>{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <button
                className="btn btn-primary btn-block btn-lg"
                disabled={!pinName.trim() || adding === 'pin'}
                onClick={addPin}
              >
                {adding === 'pin' ? 'Adding…' : 'Add to queue'}
              </button>
            </>
          )}

          {tab === 'nearby' && (
            <>
              {!anchor && (
                <div className="map-note map-note-warn">
                  Nearby needs a location. Allow location access, long-press the map to place
                  yourself, or use Search.
                </div>
              )}
              <div className="cat-grid">
                {categories.map((c) => (
                  <button
                    key={c.key}
                    className={`cat-btn ${category === c.key ? 'cat-btn-active' : ''}`}
                    disabled={!anchor || loading}
                    onClick={() => runNearby(c.key)}
                  >
                    <span>{c.icon}</span>
                    <span>{c.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {tab === 'search' && (
            <form onSubmit={runSearch} className="row">
              <input
                ref={searchRef}
                className="input grow"
                value={query}
                placeholder="In-N-Out, Meteor Crater, Sedona…"
                onChange={(e) => setQuery(e.target.value)}
              />
              {/* "Find", not "Search" — the tab above is already named Search and
                  two identically-named controls in one dialog is ambiguous. */}
              <button className="btn btn-primary" disabled={!query.trim() || loading}>
                Find
              </button>
            </form>
          )}

          {loading && (
            <div className="row muted">
              <span className="spinner" /> Searching…
            </div>
          )}
          {note && <div className="map-note map-note-warn">{note}</div>}
          {error && <div className="error-text">{error}</div>}

          {!!results.length && (
            <div className="results">
              {results.map((place) => {
                const away = anchor ? distanceM(anchor, place) : null;
                return (
                  <button
                    key={place.ref}
                    className="result"
                    disabled={adding === place.ref}
                    onClick={() => add(place)}
                  >
                    <span className="result-icon">{iconFor(place.category)}</span>
                    <span className="grow">
                      <span className="result-name truncate" style={{ display: 'block' }}>
                        {place.name}
                      </span>
                      <span className="result-sub">
                        {away != null && <>{formatDistance(away, imperial)} · </>}
                        {place.estCostCents === 0
                          ? 'Free'
                          : place.estCostCents != null
                            ? `${formatMoney(place.estCostCents)} est`
                            : '—'}
                        {place.visits > 0 && ` · stopped here ${place.visits}×`}
                        {place.crewRating != null && ` · ${place.crewRating.toFixed(1)}★ crew`}
                        {place.tags.cuisine && ` · ${place.tags.cuisine.split(';')[0]}`}
                      </span>
                    </span>
                    <span className="result-add">{adding === place.ref ? '…' : '+'}</span>
                  </button>
                );
              })}
            </div>
          )}

          {tab === 'nearby' && !results.length && !loading && !error && (
            <div className="faint" style={{ fontSize: 13 }}>
              Pick a category to see what’s within about 7 miles of{' '}
              {myPos ? 'you' : 'the trip start'}.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
