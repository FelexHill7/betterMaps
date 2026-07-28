import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { useStore } from '../store.ts';
import { boundsOf, distanceM, formatDistance, formatDuration, navigationUrl, type LatLng } from '../lib/geo.ts';
import { rankStops } from '../lib/sorting.ts';
import type { Member, Stop } from '../lib/types.ts';

const CATEGORY_ICON: Record<string, string> = {
  fast_food: '🍔', restaurant: '🍽️', cafe: '☕', fuel: '⛽', charging: '🔌',
  restroom: '🚻', rest_area: '🅿️', viewpoint: '🏞️', attraction: '🎡',
  park: '🌳', lodging: '🛏️', grocery: '🛒', other: '📍',
};
export const iconFor = (category: string) => CATEGORY_ICON[category] ?? CATEGORY_ICON.other;

function divIcon(html: string, size: number, className = ''): L.DivIcon {
  return L.divIcon({
    html,
    className: `bm-icon ${className}`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function stopIcon(stop: Stop, rank: number, isNext: boolean): L.DivIcon {
  const cls = `pin pin-${stop.status}${isNext ? ' pin-next' : ''}`;
  const badge = stop.status === 'queued' ? `<i class="pin-badge">${rank}</i>` : '';
  const size = isNext ? 36 : 30;
  return divIcon(
    `<div class="${cls}" style="position:relative"><span>${iconFor(stop.category)}</span>${badge}</div>`,
    size,
  );
}

const endpointIcon = (glyph: string) =>
  divIcon(`<div class="pin pin-endpoint"><span>${glyph}</span></div>`, 30);

const meIcon = (heading: number | null) =>
  divIcon(
    `<div class="me-marker">${
      heading == null ? '' : `<div class="me-arrow" style="transform:rotate(${heading}deg)"></div>`
    }<div class="me-dot"></div></div>`,
    24,
  );

const crewIcon = (member: Member) =>
  divIcon(
    `<div class="crew-marker" style="border-color:${member.color}">${member.emoji}</div>`,
    27,
  );

/** Imperatively fits bounds when asked, without fighting the user's panning. */
function MapController({
  fitKey,
  bounds,
  follow,
  me,
}: {
  fitKey: number;
  bounds: [[number, number], [number, number]] | null;
  follow: boolean;
  me: LatLng | null;
}) {
  const map = useMap();
  const lastFit = useRef(-1);

  useEffect(() => {
    if (fitKey === lastFit.current || !bounds) return;
    lastFit.current = fitKey;
    map.fitBounds(bounds, { padding: [55, 55], maxZoom: 15 });
  }, [fitKey, bounds, map]);

  useEffect(() => {
    if (!follow || !me) return;
    map.setView([me.lat, me.lng], Math.max(map.getZoom(), 14), { animate: true });
  }, [follow, me?.lat, me?.lng, map]);

  return null;
}

function LongPressHandler({ onLongPress }: { onLongPress: (at: LatLng) => void }) {
  const timer = useRef<number | null>(null);
  const origin = useRef<LatLng | null>(null);

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };

  useMapEvents({
    mousedown(e) {
      origin.current = { lat: e.latlng.lat, lng: e.latlng.lng };
      timer.current = window.setTimeout(() => {
        if (origin.current) onLongPress(origin.current);
        clear();
      }, 550);
    },
    mouseup: clear,
    dragstart: clear,
    mouseout: clear,
    // Leaflet fires contextmenu for a touch long-press too
    contextmenu(e) {
      clear();
      onLongPress({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

export interface MapCanvasProps {
  onPickPoint: (at: LatLng) => void;
  onOpenStop: (stop: Stop) => void;
}

export function MapCanvas({ onPickPoint, onOpenStop }: MapCanvasProps) {
  const { trip, stops, members, live, myPos, route, sortMode, imperial, typicalCents, user } =
    useStore();
  const patchStop = useStore((s) => s.patchStop);
  const setMyPos = useStore((s) => s.setMyPos);

  const [follow, setFollow] = useState(false);
  const [fitKey, setFitKey] = useState(1);

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

  const nextStopId = ranked.find((r) => r.stop.status === 'queued')?.stop.id ?? null;

  const bounds = useMemo(() => {
    const pts: LatLng[] = stops.map((s) => ({ lat: s.lat, lng: s.lng }));
    if (trip?.origin_lat != null && trip.origin_lng != null) {
      pts.push({ lat: trip.origin_lat, lng: trip.origin_lng });
    }
    if (trip?.dest_lat != null && trip.dest_lng != null) {
      pts.push({ lat: trip.dest_lat, lng: trip.dest_lng });
    }
    if (myPos) pts.push(myPos);
    return boundsOf(pts);
  }, [stops, trip?.origin_lat, trip?.origin_lng, trip?.dest_lat, trip?.dest_lng, myPos]);

  // Open on the whole trip once we have something to frame.
  const framed = useRef(false);
  useEffect(() => {
    if (!framed.current && bounds) {
      framed.current = true;
      setFitKey((k) => k + 1);
    }
  }, [bounds]);

  const center: [number, number] = myPos
    ? [myPos.lat, myPos.lng]
    : trip?.origin_lat != null && trip.origin_lng != null
      ? [trip.origin_lat, trip.origin_lng]
      : [39.5, -98.35];

  const crew = members.filter((m) => m.id !== user?.id && live[m.id]);

  return (
    <div className="map-wrap">
      <MapContainer
        center={center}
        zoom={myPos ? 13 : 4}
        zoomControl={false}
        attributionControl
        preferCanvas
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />

        <MapController fitKey={fitKey} bounds={bounds} follow={follow} me={myPos} />
        <LongPressHandler onLongPress={onPickPoint} />

        {route && (
          <>
            <Polyline
              positions={route.geometry}
              pathOptions={{ color: '#000', weight: 9, opacity: 0.35 }}
            />
            <Polyline
              positions={route.geometry}
              pathOptions={{ color: '#ff8a4c', weight: 4, opacity: 0.95 }}
            />
          </>
        )}

        {trip?.origin_lat != null && trip.origin_lng != null && (
          <Marker position={[trip.origin_lat, trip.origin_lng]} icon={endpointIcon('🚩')}>
            <Popup>
              <div className="popup-title">Start</div>
              <div className="muted">{trip.origin_name}</div>
            </Popup>
          </Marker>
        )}
        {trip?.dest_lat != null && trip.dest_lng != null && (
          <Marker position={[trip.dest_lat, trip.dest_lng]} icon={endpointIcon('🏁')}>
            <Popup>
              <div className="popup-title">Destination</div>
              <div className="muted">{trip.dest_name}</div>
            </Popup>
          </Marker>
        )}

        {ranked.map(({ stop, metrics }, i) => (
          <Marker
            key={stop.id}
            position={[stop.lat, stop.lng]}
            icon={stopIcon(stop, i + 1, stop.id === nextStopId)}
            zIndexOffset={stop.id === nextStopId ? 400 : 0}
          >
            <Popup>
              <div className="popup-title">
                {iconFor(stop.category)} {stop.name}
              </div>
              {stop.address && <div className="faint">{stop.address}</div>}
              <div className="muted" style={{ marginTop: 4 }}>
                {metrics.distanceM != null && <>{formatDistance(metrics.distanceM, imperial)} away</>}
                {metrics.detourM != null && <> · +{formatDistance(metrics.detourM, imperial)} detour</>}
              </div>
              <div className="popup-actions">
                <button className="btn" onClick={() => onOpenStop(stop)}>
                  Details
                </button>
                {stop.status === 'queued' && (
                  <button
                    className="btn btn-primary"
                    onClick={() => patchStop(stop.id, { status: 'arrived' })}
                  >
                    Check in
                  </button>
                )}
                <a
                  className="btn"
                  href={navigationUrl({ lat: stop.lat, lng: stop.lng })}
                  target="_blank"
                  rel="noreferrer"
                >
                  Navigate
                </a>
              </div>
            </Popup>
          </Marker>
        ))}

        {crew.map((m) => {
          const pos = live[m.id];
          return (
            <Marker key={m.id} position={[pos.lat, pos.lng]} icon={crewIcon(m)} zIndexOffset={300}>
              <Popup>
                <div className="popup-title">{m.name}</div>
                <div className="faint">
                  {m.role === 'driver' ? 'Driving' : 'Riding'} · seen{' '}
                  {formatDuration((Date.now() - pos.at) / 1000)} ago
                </div>
                {myPos && (
                  <div className="muted">
                    {formatDistance(distanceM(myPos, pos), imperial)} from you
                  </div>
                )}
              </Popup>
            </Marker>
          );
        })}

        {myPos && (
          <Marker
            position={[myPos.lat, myPos.lng]}
            icon={meIcon(myPos.heading)}
            zIndexOffset={500}
          />
        )}
      </MapContainer>

      <div className="map-overlay map-overlay-tl">
        {route && (
          <div className="route-summary">
            <div>
              <span>Route</span>
              <b>{formatDistance(route.distanceM, imperial)}</b>
            </div>
            <div>
              <span>Drive time</span>
              <b>{formatDuration(route.durationS)}</b>
            </div>
          </div>
        )}
        <MapNotices onSetPosition={() => setMyPos(null)} />
      </div>

      <div className="map-overlay map-overlay-tr">
        <button className="map-btn" title="Fit the whole trip" onClick={() => setFitKey((k) => k + 1)}>
          ⤢
        </button>
        <button
          className={`map-btn ${follow ? 'map-btn-on' : ''}`}
          title={follow ? 'Stop following me' : 'Follow my position'}
          onClick={() => setFollow((f) => !f)}
        >
          ◎
        </button>
      </div>
    </div>
  );
}

/** Location/route problems worth surfacing on the map itself. */
function MapNotices({ onSetPosition }: { onSetPosition: () => void }) {
  const locationError = useStore((s) => s.locationError);
  const routeError = useStore((s) => s.routeError);
  const routing = useStore((s) => s.routing);
  const myPos = useStore((s) => s.myPos);

  return (
    <>
      {!myPos && locationError && (
        <div className="map-note map-note-warn" onClick={onSetPosition}>
          {locationError}
        </div>
      )}
      {routing && (
        <div className="map-note row">
          <span className="spinner" /> Finding the best road route…
        </div>
      )}
      {routeError && <div className="map-note map-note-warn">Route unavailable — {routeError}</div>}
    </>
  );
}
