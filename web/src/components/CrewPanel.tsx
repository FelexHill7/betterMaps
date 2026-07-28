import { useState } from 'react';
import { useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import { distanceM, formatClock, formatDistance } from '../lib/geo.ts';
import type { PlaceResult } from '../lib/types.ts';

export function CrewPanel() {
  const { trip, members, online, user, live, myPos, imperial, simulating, route } = useStore();
  const claimRole = useStore((s) => s.claimRole);
  const updateTrip = useStore((s) => s.updateTrip);
  const setSimulating = useStore((s) => s.setSimulating);
  const toggleUnits = useStore((s) => s.toggleUnits);
  const leaveTrip = useStore((s) => s.leaveTrip);
  const notify = useStore((s) => s.notify);

  const [destQuery, setDestQuery] = useState('');
  const [destResults, setDestResults] = useState<PlaceResult[]>([]);
  const [searchingDest, setSearchingDest] = useState(false);
  const [budget, setBudget] = useState(
    trip?.budget_cents ? (trip.budget_cents / 100).toFixed(0) : '',
  );

  if (!trip) return null;
  const myRole = members.find((m) => m.id === user?.id)?.role ?? 'passenger';

  async function findDest(e: React.FormEvent) {
    e.preventDefault();
    if (!destQuery.trim()) return;
    setSearchingDest(true);
    try {
      const { results } = await api.search(destQuery.trim(), myPos ?? undefined);
      setDestResults(results.slice(0, 6));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Search failed', 'error');
    } finally {
      setSearchingDest(false);
    }
  }

  async function pickDest(place: PlaceResult) {
    await updateTrip({ dest: { name: place.name, lat: place.lat, lng: place.lng } });
    setDestResults([]);
    setDestQuery('');
    notify(`Destination set to ${place.name}`);
  }

  async function saveBudget() {
    const cents = Math.round(Number(budget) * 100);
    await updateTrip({ budgetCents: Number.isFinite(cents) && cents > 0 ? cents : 0 });
    notify('Budget updated');
  }

  const shareInvite = async () => {
    const text = `Join my road trip on betterMaps — code ${trip.code}`;
    try {
      if (navigator.share) await navigator.share({ title: trip.name, text });
      else {
        await navigator.clipboard.writeText(text);
        notify('Invite copied to clipboard');
      }
    } catch {
      // user dismissed the share sheet — nothing to report
    }
  };

  return (
    <div className="list-section">
      <div>
        <div className="section-label">Invite</div>
        <div className="row" style={{ marginTop: 7 }}>
          <span className="code-pill" style={{ fontSize: 18, padding: '6px 12px' }}>
            {trip.code}
          </span>
          <button className="btn btn-ghost" onClick={shareInvite}>
            Share code
          </button>
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          Anyone with this code can add stops and chat. No accounts, no app store.
        </div>
      </div>

      <div>
        <div className="section-label">In the car ({members.length})</div>
        {members.map((m) => {
          const isOnline = online.includes(m.id);
          const pos = live[m.id];
          const away = pos && myPos && m.id !== user?.id ? distanceM(myPos, pos) : null;
          return (
            <div key={m.id} className="crew-row">
              <div
                className={`avatar ${isOnline ? 'avatar-online' : ''}`}
                style={{ borderColor: m.color }}
              >
                {m.emoji}
              </div>
              <div className="grow">
                <div className="row" style={{ gap: 6 }}>
                  <b style={{ fontWeight: 600 }}>{m.name}</b>
                  {m.id === user?.id && <span className="faint" style={{ fontSize: 12 }}>you</span>}
                  <span className={`role-tag ${m.role === 'driver' ? 'role-tag-driver' : ''}`}>
                    {m.role}
                  </span>
                </div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {isOnline ? 'online' : pos ? `last seen ${formatClock(pos.at)}` : 'offline'}
                  {away != null && ` · ${formatDistance(away, imperial)} from you`}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <div className="section-label">My seat</div>
        <div className="row" style={{ marginTop: 7, flexWrap: 'wrap', gap: 7 }}>
          <button
            className={`btn ${myRole === 'driver' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => claimRole('driver')}
          >
            🚗 I'm driving
          </button>
          <button
            className={`btn ${myRole !== 'driver' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => claimRole('passenger')}
          >
            🧍 Passenger
          </button>
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          Claiming the wheel hands driver mode to this phone and takes it from whoever had it.
        </div>
      </div>

      <div>
        <div className="section-label">Destination</div>
        <div className="muted" style={{ fontSize: 13, margin: '6px 0' }}>
          {trip.dest_name ?? 'Not set — “least detour” sorting needs one.'}
        </div>
        <form className="row" onSubmit={findDest}>
          <input
            className="input grow"
            value={destQuery}
            placeholder="Where are you ending up?"
            onChange={(e) => setDestQuery(e.target.value)}
          />
          <button className="btn" disabled={!destQuery.trim() || searchingDest}>
            {searchingDest ? '…' : 'Find'}
          </button>
        </form>
        {!!destResults.length && (
          <div className="results" style={{ marginTop: 7 }}>
            {destResults.map((p) => (
              <button key={p.ref} className="result" onClick={() => pickDest(p)}>
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
      </div>

      <div>
        <div className="section-label">Trip budget</div>
        <div className="row" style={{ marginTop: 7 }}>
          <input
            className="input grow"
            type="number"
            min="0"
            step="10"
            value={budget}
            placeholder="Total for the trip, e.g. 400"
            onChange={(e) => setBudget(e.target.value)}
          />
          <button className="btn" onClick={saveBudget}>
            Save
          </button>
        </div>
      </div>

      <div>
        <div className="section-label">Settings</div>
        <div className="row" style={{ marginTop: 7, flexWrap: 'wrap', gap: 7 }}>
          <button className="btn btn-ghost" onClick={toggleUnits}>
            {imperial ? 'Miles' : 'Kilometres'}
          </button>
          <button
            className={`btn ${simulating ? 'btn-primary' : 'btn-ghost'}`}
            disabled={!route}
            title={route ? 'Animate along the planned route' : 'Needs a route first'}
            onClick={() => setSimulating(!simulating)}
          >
            {simulating ? '⏸ Stop demo drive' : '▶ Demo drive'}
          </button>
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          Demo drive moves your position along the route so you can see the sorting, ETAs and driver
          mode work without leaving the driveway.
        </div>
      </div>

      <div>
        <button
          className="btn btn-ghost btn-danger btn-block"
          onClick={() => {
            if (confirm(`Leave “${trip.name}”? You can rejoin with code ${trip.code}.`)) {
              void leaveTrip();
            }
          }}
        >
          Leave this trip
        </button>
      </div>
    </div>
  );
}
