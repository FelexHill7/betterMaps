import { useState } from 'react';
import { useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import type { PlaceResult } from '../lib/types.ts';

export function Welcome() {
  const user = useStore((s) => s.user);
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="brand">
          <span>🛣️</span>
          <div>
            betterMaps
            <small>One queue of stops your whole car can see and re-sort.</small>
          </div>
        </div>
        {user ? <TripChooser /> : <NameGate />}
      </div>
    </div>
  );
}

function NameGate() {
  const signUp = useStore((s) => s.signUp);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await signUp(name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start');
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <div className="panel-title">What should the car call you?</div>
      <div className="field">
        <input
          className="input"
          value={name}
          placeholder="Alex"
          autoFocus
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {error && <div className="error-text">{error}</div>}
      <button className="btn btn-primary btn-lg btn-block" disabled={!name.trim() || busy}>
        {busy ? 'Starting…' : 'Continue'}
      </button>
      <div className="faint" style={{ fontSize: 12 }}>
        No password, no email. This device stays signed in.
      </div>
    </form>
  );
}

function TripChooser() {
  const { user, trips } = useStore();
  const openTrip = useStore((s) => s.openTrip);
  const joinTrip = useStore((s) => s.joinTrip);
  const signOut = useStore((s) => s.signOut);

  const [mode, setMode] = useState<'menu' | 'create'>('menu');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim().length < 4) return;
    setBusy(true);
    setError(null);
    try {
      await joinTrip(code.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join');
      setBusy(false);
    }
  };

  if (mode === 'create') return <CreateTrip onCancel={() => setMode('menu')} />;

  return (
    <>
      {!!trips.length && (
        <div className="panel">
          <div className="panel-title">Your trips</div>
          <div className="trip-list">
            {trips.map((t) => (
              <button key={t.id} className="trip-item" onClick={() => openTrip(t.id)}>
                <span style={{ fontSize: 20 }}>🚗</span>
                <span className="grow">
                  <b className="truncate" style={{ display: 'block' }}>{t.name}</b>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {t.stop_count ?? 0} stop{t.stop_count === 1 ? '' : 's'} queued
                    {t.dest_name ? ` · to ${t.dest_name}` : ''}
                  </span>
                </span>
                <span className="code-pill">{t.code}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <button className="btn btn-primary btn-lg btn-block" onClick={() => setMode('create')}>
          Plan a new trip
        </button>
        <div className="divider">or join one</div>
        <form onSubmit={join} style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          <input
            className="input code-input"
            value={code}
            placeholder="ABC123"
            maxLength={6}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-block" disabled={code.trim().length < 4 || busy}>
            {busy ? 'Joining…' : 'Join with code'}
          </button>
        </form>
      </div>

      <div className="row faint" style={{ fontSize: 12, justifyContent: 'center' }}>
        Signed in as {user?.emoji} {user?.name}
        <button className="btn btn-ghost" style={{ padding: '4px 9px', fontSize: 12 }} onClick={signOut}>
          Switch
        </button>
      </div>
    </>
  );
}

function CreateTrip({ onCancel }: { onCancel: () => void }) {
  const createTrip = useStore((s) => s.createTrip);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [originQ, setOriginQ] = useState('');
  const [destQ, setDestQ] = useState('');
  const [origin, setOrigin] = useState<PlaceResult | null>(null);
  const [dest, setDest] = useState<PlaceResult | null>(null);
  const [picking, setPicking] = useState<'origin' | 'dest' | null>(null);
  const [options, setOptions] = useState<PlaceResult[]>([]);

  async function lookup(which: 'origin' | 'dest') {
    const q = which === 'origin' ? originQ : destQ;
    if (!q.trim()) return;
    setPicking(which);
    setOptions([]);
    setError(null);
    try {
      const { results } = await api.search(q.trim());
      setOptions(results.slice(0, 6));
      if (!results.length) setError(`Nothing found for “${q.trim()}”.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    }
  }

  function choose(place: PlaceResult) {
    if (picking === 'origin') {
      setOrigin(place);
      setOriginQ(place.name);
    } else {
      setDest(place);
      setDestQ(place.name);
    }
    setPicking(null);
    setOptions([]);
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createTrip({
        name: name.trim(),
        origin: origin ? { name: origin.name, lat: origin.lat, lng: origin.lng } : null,
        dest: dest ? { name: dest.name, lat: dest.lat, lng: dest.lng } : null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the trip');
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <div className="panel-title">New trip</div>

      <div className="field">
        <label htmlFor="trip-name">Trip name</label>
        <input
          id="trip-name"
          className="input"
          value={name}
          placeholder="Phoenix → Grand Canyon"
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="trip-origin">Starting from (optional)</label>
        <div className="row">
          <input
            id="trip-origin"
            className="input grow"
            value={originQ}
            placeholder="Phoenix, AZ"
            onChange={(e) => {
              setOriginQ(e.target.value);
              setOrigin(null);
            }}
          />
          <button type="button" className="btn" onClick={() => lookup('origin')}>
            Find
          </button>
        </div>
      </div>

      <div className="field">
        <label htmlFor="trip-dest">Ending at (optional)</label>
        <div className="row">
          <input
            id="trip-dest"
            className="input grow"
            value={destQ}
            placeholder="Grand Canyon Village"
            onChange={(e) => {
              setDestQ(e.target.value);
              setDest(null);
            }}
          />
          <button type="button" className="btn" onClick={() => lookup('dest')}>
            Find
          </button>
        </div>
        <div className="faint" style={{ fontSize: 12 }}>
          Setting both unlocks route drawing and “least detour” sorting.
        </div>
      </div>

      {!!options.length && (
        <div className="results">
          {options.map((p) => (
            <button type="button" key={p.ref} className="result" onClick={() => choose(p)}>
              <span className="grow">
                <span className="result-name">{p.name}</span>
                <span className="result-sub truncate" style={{ display: 'block' }}>
                  {p.address}
                </span>
              </span>
              <span className="result-add">+</span>
            </button>
          ))}
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      <div className="row">
        <button type="button" className="btn btn-ghost grow" onClick={onCancel}>
          Back
        </button>
        <button className="btn btn-primary grow" disabled={!name.trim() || busy}>
          {busy ? 'Creating…' : 'Create trip'}
        </button>
      </div>
    </form>
  );
}
