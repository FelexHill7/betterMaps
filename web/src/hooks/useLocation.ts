import { useEffect, useRef } from 'react';
import { useStore } from '../store.ts';
import { bearingDeg, pointAlong } from '../lib/geo.ts';

/**
 * Feeds the store from the device GPS. Kept out of components because the watch
 * must survive tab switches and view changes — losing the driver's position
 * because a panel unmounted would be the worst possible bug here.
 */
export function useDeviceLocation(enabled: boolean): void {
  const setMyPos = useStore((s) => s.setMyPos);
  const setLocationError = useStore((s) => s.setLocationError);
  const simulating = useStore((s) => s.simulating);

  useEffect(() => {
    if (!enabled || simulating) return;

    if (!('geolocation' in navigator)) {
      setLocationError('This browser has no location support');
      return;
    }

    let cancelled = false;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (cancelled) return;
        setMyPos({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
          speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
          at: pos.timestamp,
        });
      },
      (err) => {
        if (cancelled) return;
        const message =
          err.code === err.PERMISSION_DENIED
            ? 'Location is blocked. Allow it, or long-press the map to drop your position.'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'No GPS fix yet — long-press the map to set your position manually.'
              : 'Location timed out. Long-press the map to set your position.';
        setLocationError(message);
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );

    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(watchId);
    };
  }, [enabled, simulating, setMyPos, setLocationError]);
}

const SIM_SECONDS_END_TO_END = 240;

/**
 * Drives a fake vehicle along the planned route. This exists so the trip can be
 * demoed and tested from a desk — everything downstream (sorting, ETAs, driver
 * mode, what the other phones see) reads the same store field as real GPS.
 */
export function useSimulatedDrive(): void {
  const simulating = useStore((s) => s.simulating);
  const route = useStore((s) => s.route);
  const setMyPos = useStore((s) => s.setMyPos);
  const progress = useRef(0);

  useEffect(() => {
    if (!simulating) return;
    const path = route?.geometry;
    if (!path || path.length < 2) return;

    progress.current = 0;
    let raf = 0;
    let last = performance.now();
    let lastBroadcast = 0;

    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      progress.current = Math.min(1, progress.current + dt / SIM_SECONDS_END_TO_END);

      const at = pointAlong(path, progress.current);
      if (at) {
        // throttle the network push; the local marker still moves every frame
        const broadcast = now - lastBroadcast > 3000;
        if (broadcast) lastBroadcast = now;
        setMyPos(
          {
            lat: at.point.lat,
            lng: at.point.lng,
            heading: at.heading,
            speed: 27,
            at: Date.now(),
          },
          { broadcast },
        );
      }
      if (progress.current < 1) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [simulating, route, setMyPos]);
}

/** Heading for the arrow marker: prefer GPS heading, else infer from movement. */
export function useHeading(): number | null {
  const myPos = useStore((s) => s.myPos);
  const previous = useRef<{ lat: number; lng: number } | null>(null);
  const inferred = useRef<number | null>(null);

  if (myPos) {
    if (myPos.heading != null) {
      inferred.current = myPos.heading;
    } else if (previous.current) {
      const moved =
        Math.abs(previous.current.lat - myPos.lat) + Math.abs(previous.current.lng - myPos.lng);
      if (moved > 1e-5) inferred.current = bearingDeg(previous.current, myPos);
    }
    previous.current = { lat: myPos.lat, lng: myPos.lng };
  }
  return inferred.current;
}
