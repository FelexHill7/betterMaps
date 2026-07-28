# betterMaps

A shared stop queue for road trips. Everyone in the car adds places they want to
hit — burger joints, overlooks, cheap gas — and the driver's phone re-sorts that
one list by whatever matters at that moment: what's **nearest**, what costs the
**least detour**, what the car actually **voted** for, what's **cheapest**.

The problem it solves is the argument at 60mph about where to stop. One queue,
everyone can see it, everyone can add to it, and the driver gets a glanceable
view with big buttons and a hand-off to real turn-by-turn navigation.

<!-- Screenshots of the running app live in the docs of whatever you deploy to;
     the app itself is the fastest way to see it — see Quick start below. -->

## Quick start

```bash
npm install
npm run dev
```

- App: <http://localhost:5177>
- API: <http://localhost:5178>

Vite also binds the LAN address it prints, so you can open the same URL on a
real phone on the same Wi-Fi and use actual GPS. No API keys are needed
anywhere — see [Data sources](#data-sources).

```bash
npm test         # 60 API assertions + 47 sorting/geo assertions
npm run typecheck
npm run build && npm start   # build the SPA, serve everything from :5178
```

## How it works

Create a trip, get a six-character code (`WJ52EU`), and read it out to the car.
Anyone who enters it joins — no accounts, no email, no app store. The code
alphabet omits `0/O/1/I` so it survives being shouted over road noise.

### The sorts

This is the core of the app. Every sort shows a badge on each row explaining
*why* it's in that position, so the list always justifies its own order.

| Sort | Orders by | Badge shows |
|---|---|---|
| **Nearest** | straight-line distance from your live position | `7.1 mi` |
| **Detour** | extra driving to visit it *versus going straight on* | `+2.4 mi` / `on the way` |
| **Votes** | net thumbs up/down from the car | `+3` |
| **Rated** | crew star ratings, then how well-known the place is | `4.5★ crew` |
| **Cheapest** | estimated spend per person | `$12 est` |
| **Planned** | the order you arranged, reorderable | drive time |

**Detour is the one that matters most and the one other apps get wrong.**
Nearest will happily send you to a taco place two miles *behind* you. Detour
computes `distance(me→stop) + distance(stop→destination) − distance(me→destination)`,
so a place slightly farther away but directly on your route beats a closer one
that costs you a U-turn. Sorts that need data you don't have (a position, a
destination) are disabled with the reason shown rather than silently producing a
meaningless order.

Stops you've already visited or skipped always sink below live ones — the
driver's list should only ever open on things still ahead.

### Driver mode

Full-screen, high-contrast, sized to be read at a glance: the next stop, real
road distance / drive time / arrival clock, and three big targets — **Navigate**,
**Arrived**, **Skip**. Below that, the next few alternatives in the current sort;
tapping one promotes it to next. Navigation hands off to the phone's real maps
app rather than reinventing turn-by-turn.

The list badges use a cheap straight-line estimate, but the stop you're actually
driving to gets one real routing call for an honest ETA.

### Everything else

- **Live positions** — each phone streams its location over the socket; you see
  everyone as coloured markers, and how far they are from you.
- **Chat** — plus every queue change logged into the same timeline, so nobody
  has to ask what changed.
- **Money** — log what people paid, see the even split and who owes whom, track
  it against a trip budget, and see what the rest of the queue will likely cost.
- **Roles** — claiming the wheel demotes whoever had it; only one driver at a time.
- **Adding stops** — search by name, browse a category near you (gas, food,
  restrooms, viewpoints…), or long-press the map to drop a pin, which is
  reverse-geocoded to a sensible default name.
- **Demo drive** — animates your position along the route so you can watch the
  sorting, ETAs and driver mode work without leaving the driveway.

## Data sources

Everything is free and keyless, proxied through the server so it can send a
proper `User-Agent`, cache aggressively, and rate-limit from one place:

| Need | Service | Notes |
|---|---|---|
| Geocoding / search | Nominatim | serialised to ≥1.1s apart per their usage policy |
| Nearby POIs | Overpass | three mirrors tried in order, 7s timeout each |
| Driving routes | OSRM demo server | waypoints capped, polylines decoded server-side |

**These are volunteer-run and genuinely flaky.** During development the main
Overpass endpoint returned 504s and mirrors hung for over 90 seconds. So
category search falls back to a bounded Nominatim search and flags the response
as `degraded`, which the UI surfaces as "Detailed POI search is busy — showing
named places only." For production traffic you'd swap in a paid provider or
self-host; the fallback chain is deliberate, not incidental.

### On ratings

OpenStreetMap has no review data, so there is nothing honest to import for
"highest rated". Rather than invent a number, the app builds it from real usage:

- **Crew rating** — stars your group gives a place after checking in.
- **Visit count** — how many times this install has actually stopped somewhere,
  surfaced in search results as "stopped here 3×".
- **Prominence** — Nominatim's `importance` score, labelled as notability rather
  than dressed up as a review score.

Cost estimates work the same way: a per-category starting figure that is clearly
marked `est` until someone edits it.

## Architecture

```
server/          Node 24 + Express + ws, TypeScript run natively (no build step)
  src/db.ts        node:sqlite schema and queries
  src/places.ts    Nominatim / Overpass / OSRM with caching + fallbacks
  src/api.ts       REST surface
  src/realtime.ts  WebSocket fan-out
  test/            60 end-to-end API assertions

web/             React + Vite + Leaflet
  src/lib/geo.ts       haversine, detour, polyline interpolation, formatting
  src/lib/sorting.ts   the ranking engine
  src/lib/socket.ts    reconnecting trip socket
  src/store.ts         zustand store + socket event handling
  src/lib/sorting.test.ts  47 assertions on the sorting and geo math
```

**Mutations go over REST; the socket is fan-out only.** Writes are easy to
retry, easy to `curl`, and easy to debug; the socket exists to tell everyone
else what changed, and to carry high-frequency vehicle positions that have no
business being HTTP requests.

Both storage and TypeScript execution use built-in Node features — `node:sqlite`
and native type stripping — so there is no native module to compile and no
build step on the server. Requires Node ≥ 22.6.

### Notes on things that look odd but aren't

- **The socket heartbeats itself.** A phone that drives into a dead zone never
  gets a close frame; the connection just goes quiet. Without a client-side
  probe the UI keeps claiming "live" until TCP eventually gives up. On a road
  trip a stale "live" badge is worse than no badge.
- **Chat appends are idempotent on both paths.** The server broadcasts every
  message to the whole trip, and that echo routinely beats the POST response
  back to the sender.
- **`ascNullsLast` / `descNullsLast` are two functions, not one with a flag.**
  Swapping arguments to reverse the order would also reverse the null handling,
  which put unrated stops *first* under "best rated" until a test caught it.

## Known limitations

- The public OSM services will rate-limit under real load; see
  [Data sources](#data-sources).
- Trip membership is by code alone — anyone with the code can edit the queue.
  That is the right trade-off for a car full of friends and the wrong one for
  anything public.
- Detour uses straight-line distance, not road distance. It is the right
  *ranking* signal and costs no API calls; the stop you actually drive to gets a
  real routed ETA in driver mode.
- Expense splitting is an even split. It does not handle per-item shares.
- Offline is degraded, not supported: the last trip snapshot stays in memory but
  new searches and routing need a connection.
