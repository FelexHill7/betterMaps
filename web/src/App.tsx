import { useEffect, useState } from 'react';
import { useStore } from './store.ts';
import { useDeviceLocation, useSimulatedDrive } from './hooks/useLocation.ts';
import { Welcome } from './views/Welcome.tsx';
import { MapCanvas } from './components/MapCanvas.tsx';
import { SortBar } from './components/SortBar.tsx';
import { QueueList } from './components/QueueList.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { CrewPanel } from './components/CrewPanel.tsx';
import { MoneyPanel } from './components/MoneyPanel.tsx';
import { AddStopSheet } from './components/AddStopSheet.tsx';
import { StopDetail } from './components/StopDetail.tsx';
import { DriverMode } from './components/DriverMode.tsx';
import type { LatLng } from './lib/geo.ts';
import type { Stop } from './lib/types.ts';

type Tab = 'queue' | 'chat' | 'crew' | 'money';
type SheetSize = 'collapsed' | 'default' | 'expanded';

export default function App() {
  const { user, trip, booting, loadingTrip, connection, toast, unreadChat, driverMode, stops } =
    useStore();
  const boot = useStore((s) => s.boot);
  const closeTrip = useStore((s) => s.closeTrip);
  const setDriverMode = useStore((s) => s.setDriverMode);
  const dismissToast = useStore((s) => s.dismissToast);

  const [tab, setTab] = useState<Tab>('queue');
  const [sheet, setSheet] = useState<SheetSize>('default');
  const [addOpen, setAddOpen] = useState(false);
  const [pinPoint, setPinPoint] = useState<LatLng | null>(null);
  const [detail, setDetail] = useState<Stop | null>(null);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Location tracking only matters once we're inside a trip.
  useDeviceLocation(!!trip);
  useSimulatedDrive();

  // Keep the open detail sheet in sync with live edits from other phones.
  useEffect(() => {
    if (!detail) return;
    const fresh = stops.find((s) => s.id === detail.id);
    if (!fresh) setDetail(null);
    else if (fresh !== detail) setDetail(fresh);
  }, [stops, detail]);

  if (booting) {
    return (
      <div className="welcome">
        <span className="spinner" />
      </div>
    );
  }

  if (!user || !trip) return <Welcome />;

  if (driverMode) return <DriverMode onExit={() => setDriverMode(false)} />;

  const openPin = (at: LatLng) => {
    setPinPoint(at);
    setAddOpen(true);
  };

  const sheetClass =
    sheet === 'collapsed' ? 'sheet-collapsed' : sheet === 'expanded' ? 'sheet-expanded' : '';

  return (
    <div className="app">
      <div className="topbar">
        <button className="btn btn-icon btn-ghost" title="All trips" onClick={closeTrip}>
          ‹
        </button>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="topbar-title truncate">{trip.name}</div>
          <div className="topbar-sub">
            <span className="code-pill">{trip.code}</span>
            <span className={`conn conn-${connection}`}>
              <i />
              {connection === 'live' ? 'live' : connection}
            </span>
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setDriverMode(true)}>
          🚗 Drive
        </button>
      </div>

      <div className="app-main">
        {loadingTrip ? (
          <div className="map-wrap" style={{ display: 'grid', placeItems: 'center' }}>
            <span className="spinner" />
          </div>
        ) : (
          <MapCanvas onPickPoint={openPin} onOpenStop={setDetail} />
        )}
      </div>

      <button
        className={`fab ${sheet === 'collapsed' ? 'fab-collapsed' : sheet === 'expanded' ? 'fab-expanded' : ''}`}
        onClick={() => {
          setPinPoint(null);
          setAddOpen(true);
        }}
      >
        <span style={{ fontSize: 17 }}>＋</span> Add stop
      </button>

      <div className={`sheet ${sheetClass}`}>
        <div
          className="sheet-grip"
          onClick={() =>
            setSheet((s) => (s === 'collapsed' ? 'default' : s === 'default' ? 'expanded' : 'collapsed'))
          }
          title="Resize"
        >
          <i />
        </div>

        <div className="tabs">
          {(
            [
              ['queue', 'Queue'],
              ['chat', 'Chat'],
              ['crew', 'Crew'],
              ['money', 'Money'],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              className={`tab ${tab === key ? 'tab-active' : ''}`}
              onClick={() => {
                setTab(key);
                if (sheet === 'collapsed') setSheet('default');
              }}
            >
              {label}
              {key === 'chat' && unreadChat > 0 && <span className="tab-badge">{unreadChat}</span>}
            </button>
          ))}
        </div>

        <div className="sheet-body">
          {tab === 'queue' && (
            <>
              <SortBar />
              <QueueList
                onOpenStop={setDetail}
                onAddStop={() => {
                  setPinPoint(null);
                  setAddOpen(true);
                }}
              />
            </>
          )}
          {tab === 'chat' && <ChatPanel />}
          {tab === 'crew' && <CrewPanel />}
          {tab === 'money' && <MoneyPanel />}
        </div>
      </div>

      {addOpen && (
        <AddStopSheet
          seedPoint={pinPoint}
          onClose={() => {
            setAddOpen(false);
            setPinPoint(null);
          }}
        />
      )}
      {detail && <StopDetail stop={detail} onClose={() => setDetail(null)} />}

      {toast && (
        <div
          className={`toast ${toast.tone === 'error' ? 'toast-error' : ''}`}
          onClick={dismissToast}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
