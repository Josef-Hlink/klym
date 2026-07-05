# CLAUDE.md

Context for future Claude sessions working on klym.

## What klym is

A local-only, single-user web app that turns GPX files into
climbfinder.com-style colored-bar climb profile images. Users select
climbs with two markers on a synced map + elevation chart; an
autodetector (`src/lib/climbs.ts`) suggests candidate climbs and
descents which the user can preview on hover, open directly (ephemeral
explore view — no saving), or load into the markers to adjust.

Remote: `Josef-Hlink/klym` (private, MIT).

## Stack

- SvelteKit 2.57, Svelte 5.55, Vite 8, TypeScript 6
- Tailwind CSS v4 via `@tailwindcss/vite` (no config file; import in `src/app.css`)
- MapLibre GL 5 (OSM raster tiles, no token required)
- uPlot 1.6 (interactive elevation chart in the route viewer)
- `fast-xml-parser` (GPX parsing server-side)
- In-memory per-session store — no database, no disk (see Storage below)
- `@sveltejs/adapter-node` — emits `build/` (`node build/index.js`) for
  self-hosting; deployed via a Nix flake + NixOS module (see `HOSTING.md`)
- Vitest 4 for the pure-helper tests under `src/lib/`

Package manager is **pnpm**. Use `pnpm <script>`, not `pnpm exec <tool>`.

## Commands

- `pnpm dev` — dev server (user keeps one running in a separate tmux
  window during sessions; don't start another). Pinned to **port 1047**
  with `strictPort` (1047m = Strava-verified Alpe d'Huez elevation gain).
- `pnpm check` — `svelte-kit sync && svelte-check`. Run this after every
  change; user has allowlisted it.
- `pnpm test` / `pnpm test:watch` — vitest. Run after changes to anything
  under `src/lib/` (helpers + topo modules); the suite is fast (< 1s).
- `pnpm build` / `pnpm preview`

## Routes

- `/` — upload + "Your routes" list + collapsible "Tour 🇫🇷 stages"
  list of the builtin TdF routes (SSR on)
- `/routes/[id]` — route viewer: map + chart + marker UI + segments
  list (SSR **off** — MapLibre and uPlot both need the DOM)
- `/routes/[id]/segments/[segId]` — segment profile + export (SSR **off**
  for the same reason; rasterization also needs the DOM)
- `/routes/[id]/explore?from=&to=&name=` — the same profile view fed by
  query-param bounds instead of a saved segment (SSR off). Detected
  climbs/descents open here on click. Both pages are thin wrappers
  around `SegmentView.svelte`, which owns stats, section controls, the
  CF chart, the 3D topo map and the export menu.
- `/api/garmin/current?token=` + `/garmin/setup?token=` — the Garmin
  device feed and its one-time browser pairing page (see the Garmin
  integration note below). Both 401/404 unless `KLYM_GARMIN_TOKEN` is set.

Server loads (`+page.server.ts`) still run server-side even with
`ssr = false`; only HTML rendering is skipped.

## Storage (in-memory, per-visitor)

`src/lib/server/storage.ts` holds everything in a process-lifetime
`Map`, scoped by `owner` (the anonymous `klym_sid` session id assigned
in `src/hooks.server.ts` → `locals.owner`). Shape:

```
sessions: owner -> {
  lastSeen,
  routes: routeId -> { route: RouteData, segments: segId -> SegmentData }
}
```

Nothing touches disk. Each visitor is isolated; data is dropped when the
session cookie expires, after ~6h idle (the sweep), or on any restart —
the intended behaviour for the hosted, login-less app. Every storage
function takes `owner` as its first arg and is still `async` (call sites
just `await` as before). Caps at the top of the file
(`MAX_SESSIONS`/`MAX_ROUTES_PER_SESSION`/etc.) bound memory; overflow
evicts the oldest. Ids are slugified names, unique per scope (routes per
session, segments per route); conflicts return 409 inline.

> Was filesystem-backed (`data/<route-id>/…`) through M9. The old `data/`
> dir is now orphaned (still gitignored). See `HOSTING.md`.

### Builtin example routes (`src/lib/server/builtin.ts`)

The 21 Tour de France 2026 stages, bundled as GPX under
`src/lib/server/tdf-2026/` (committed; whitespace/trailing-zero slimmed;
source `cdn.cyclingstage.com/images/tour-de-france/2026/stage-{n}-route.gpx`
— re-download to refresh, their stage-6 trace is currently ~57 km short of
the official route). Loaded via `import.meta.glob(..., '?raw')`, parsed
once per process on first access, shared **read-only by reference** across
all sessions — zero per-visitor memory. Stage names/dates live in the
`STAGES` table; ids are `tdf-2026-stage-{n}`; `builtin.test.ts` guards the
table and that every bundled file parses.

Storage integration: `readRoute`/`routeExists` fall back to the registry
(session first, so nothing shadows a user's own data), which makes the
viewer, explore and segment pages work unchanged. Rename/delete miss it
and 404. Saving a segment on a stage materializes a *hidden* per-session
`RouteRecord` (`builtin: true`, route shared by reference, skipped by
`listRoutes`) so segments stay per-visitor without the stage appearing
under "Your routes". The homepage marks today's stage (`todayStageId()`,
Europe/Paris) with a yellow badge.

## Key design decisions

- **Manual crop first; autodetect assists.** The two-marker UX stays
  primary. `src/lib/climbs.ts` detects candidate climbs and descents;
  the route viewer lists them with hover preview, whole-card click to
  the explore view, and a pencil "Adjust" that loads the bounds into
  the markers — it never places markers or saves segments on its own.
  Detections are never saved: exploring is ephemeral by design
  (sessions are short-lived anyway); only manual crops become segments.
- **In-memory, per-session, ephemeral storage.** Keep it that way unless
  the user asks for persistence. Hosted multi-user without login: each
  visitor gets an isolated sandbox via the `klym_sid` cookie and loses it
  when they leave. See `HOSTING.md` and the Storage section above.
- **500m default bucket.** The CF bar resolution. Bin size is configurable
  per segment view but not per route.
- **50m elevation smoothing for cumulative ascent.** Raw GPS elevation
  summed naively over-reports by ~2×. We smooth, then sum positive
  deltas. Lives in `src/lib/elevation.ts::computeTotalAscent`.
- **Gradient color scale** (`gradeColor(grade, theme)` in `elevation.ts`):
  any downhill (grade < 0%) is always slate gray; the climbing range is a
  per-theme list of `{ below, color }` bands (first band whose `below`
  exceeds the grade wins). `COLOR_THEMES` lists the presets: `klym` (seven
  warm stops at half-integer cutoffs, yellow → dark red), `giro` (seven
  maglia-rosa pinks on the same cutoffs), and `tdf` — the official ASO
  Tour scheme, a coarse four-band road line **green < 3% ≤ blue < 6% ≤
  red < 9% ≤ black** at integer cutoffs (the yellow in ASO profiles is
  just the silhouette fill, not a band). Themes may differ in band count
  and cutoffs. The theme is a `SegmentView`-level control (Colors),
  threaded into `SegmentProfile`, `SegmentMap`, and the topo `geometry.ts`
  builders; the route viewer and its chart stay on the `klym` default.
  Shared across the hover tooltip, stat pills, and the CF image bars.

## Invariants

- `markerA` ≤ `markerB` always. Directional placement (click left of A
  sets A, click right of B sets B, clicks inside are ignored) and drag
  clamping (A can't cross B, B can't cross A) both enforce this.
- Crop min length 10m — shorter selections don't produce cropStats and
  the Selection panel stays hidden.

## Non-obvious technical notes

### Climb autodetection (`src/lib/climbs.ts`)

Pure module, vitest-covered. Pipeline: resample at 25m → moving-average
smooth → collect runs of steps whose grade clears `climbGrade` →
**tier-1 bridge** short, near-lossless breathers (`maxGapM`/
`maxGapLossM`, merged stretch must still average `minAvgGrade`) —
seamless, never yields parts → drop candidates under the length / gain
/ grade / score floors → **tier-2 join** adjacent *qualified* climbs
across a real interruption (flat shelf or descent): gap ≤
`joinGapFrac` × combined children length, capped at `maxJoinGapM`, loss
≤ `joinLossFrac` × combined gain, and the merged span must itself clear
the floors. Joined parents keep the children as `climb.parts` (leaves
only, one level; parts tile the parent) so the UI offers A, B, *and*
A+B; rows with parts get a "N parts" expander and part saves are
suffixed ("Climb 5a"). The two tiers carve gaps into three regimes:
breather → one seamless climb; real interruption → one climb with
parts; bigger → separate climbs. Gap budgets are relative on purpose —
a flat 15 m loss cap can never join two real climbs over a real
descent, and per-gap absolute budgets let chains of tiny runs bridge
unlimited mush while one honest shelf splits (the pre-redesign bugs).
Three presets (`DETECTION_PRESETS`):
strict / balanced / sensitive — strict tier-1-bridges *bigger* gaps
(long alpine climbs survive their false flats in one piece), sensitive
uses small gaps so neighboring kickers stay separate. Scoring is
Strava-style (`lengthM × avgGrade%`, cat 4 at 8 000 up to HC at 80 000,
categories require ≥ 3% avg) plus a FIETS index; sanity-checked against
the old `data/` GPX files (Alpe d'Huez comes out 13.9 km @ 8.0%, HC,
FIETS 9.7, one piece, no parts).

Descents: `detectDescents` mirrors the elevation (negate), runs the
same pipeline, and flips the stats back — `gainM`/`avgGrade`/`maxGrade`
come out negative (gainM is the net drop), `startEleM` is the high
start and `topEleM` lands on the *bottom* of the descent. Category
still grades severity on the same score scale but descent badges and
bands render uniformly gray in the UI for now.

In the route viewer, detection runs client-side in `$derived`s. The
"Detected climbs" panel and the collapsed-by-default "Detected
descents" panel share the segment-row hover-preview plumbing (all feed
one `previewRange`) and one row snippet (`detectionRow`); row keys are
namespaced (`c3`, `c3:1`, `d0`). Both shade bands on the elevation
chart via the chart's `regions` prop, with separate eye toggles
(climb bands default on and category-tinted, descent bands default
off and gray). The whole row is a stretched link (absolute-inset span
inside the anchor; buttons float above with `relative z-10`) to the
explore view — detections are never saved.

### uPlot cursor/value offsets

`u.valToPos(val, 'x')` returns CSS pixels **relative to the plotting
area** (inside the axes), not the outer `.u-wrap`. My overlays in
`ElevationChart.svelte` sit in a `position: relative` wrapper that
starts at the uPlot root, so I add `u.bbox.left / uPlot.pxRatio` to
every valToPos call used for marker / tooltip positioning. Same for
`u.cursor.left` — it's plot-area-relative too.

`uPlot.pxRatio` is a **static** class property, not an instance one.
Typing it as `u.pxRatio` will fail svelte-check.

### Chart click handling

uPlot absorbs `click` on `.u-over` in some circumstances. The route-
viewer chart uses `onpointerdown` on the wrapper instead, which fires
reliably. Chip drag uses `setPointerCapture` so drags stay smooth even
when the cursor leaves the chip's bounding box.

### Map ↔ chart hover and map pin drops

`hoverDistM` is one shared two-way binding: `ElevationChart` writes it
from uPlot's cursor, `RouteMap` writes it from a plain map `mousemove`.
The map side snaps: nearest track point by cos(lat)-scaled degree
distance, accepted only if it projects within `SNAP_PX` (30) screen
pixels of the pointer — deliberately not a track-layer event, so users
don't have to hit the 7px line pixel-perfectly. Map clicks place
markers through the same `snapToTrack`. On the chart side, when
`hoverDistM` is set but uPlot's cursor is idle (`cursorLeft == null`,
i.e. the hover came from the map), the chart draws its own indicator
line and reuses the regular tooltip at `valToPos` of that distance.

### Marker chips (A/B)

Pill-shaped buttons below the x-axis. The vertical line into each chip
overlaps the chip's top half (chip is `z-20`, line `pointer-events-none`
with no z), so the line visually "pins" into the chip head.

Click (no drag) = delete. Drag (> 4px movement) = move. Threshold lives
in `DRAG_THRESHOLD_PX` in `ElevationChart.svelte`.

### Segment-row hover preview

On `/routes/[id]`, hovering a row in the segments list previews its A/B
markers on the map + chart via derived `displayMarkerA` / `displayMarkerB`.
While previewing, interaction callbacks (place/remove/move) are passed
as `undefined` so the user's own markers stay put.

### PNG export

`svgToPngBlob` in the segment page serializes the SVG to a base64 data
URL, loads it into an `<img>`, draws to a 2× canvas with a white
background, then `canvas.toBlob`. Copy-to-clipboard uses the same blob
via `navigator.clipboard.write([new ClipboardItem(...)])`. SVG download
is just `Blob([xml])` with `image/svg+xml`.

The chart's branding block is **inlined as polygons/paths** in
`SegmentProfile.svelte` (the mark from `static/logo.svg`, the wordmark
glyphs via `KlymWordmarkGlyphs.svelte`) so it survives serialization
without a separate `<image href>` round-trip. CSS classes are not
preserved when an SVG is rendered from a data URL — only inline
attributes and direct presentation styles. Anything you want to be
visible in the export must be encoded that way.

### Branding

Brand assets live in `branding/` (mark variants + the "klym." wordmark,
one Archivo-Black glyph per logo colour; gradient wordmark kept as an
alternate). `/branding` is a throwaway unlinked gallery page. In-app:
`KlymWordmark.svelte` (homepage header), `KlymBrand.svelte` (mark +
"klym" link, top-right of route/segment pages), and
`KlymWordmarkGlyphs.svelte` (bare `<path>`s, `namespace="svg"`, shared
by the wordmark component and the profile export; optional `fill` prop
renders all glyphs monochrome). The profile's branding block keeps the
mark as the only coloured element: mark above black wordmark at equal
width, big black section name beside the mark (matching its height),
small gray route name beside the wordmark (`routeName`/`sectionName`
props).

### SegmentMap (3D segment view)

Lives at the bottom of the segment page. Pure SVG, no MapLibre — every
pixel is hand-computed. The component owns reactive state (camera,
viewport, hover, tile fetch) and the SVG template; all the math lives
under `src/lib/topo/` (projection, tiles, geometry, viewport — each
with co-located tests). **See `src/lib/topo/CLAUDE.md` for the module
map and in-dir conventions.**

The non-obvious bits worth knowing at the app level:

- **Projection is orthographic** and `depth` (rotated z) drives
  painter's-algorithm ordering for polyline runs and earth-block faces.
- **OSM ground via an affine transform.** Orthographic projection
  preserves parallelism, so the planar tile-image rectangle stays a
  parallelogram under any rotation — one affine matrix places it,
  rather than per-pixel resampling.
- **Two anchor passes.** A thin uniform-density layer steps every 250m
  for visual depth cues independent of GPX point density. A thicker
  coloured layer fires at every bin boundary, which is also what pins
  the segment end (the thin pass stops on overshoot, so its last
  anchor isn't always at `endDistM`).
- **Slice clamping.** `slicedPoints` interpolates exact start/end
  points via `findPointAtDistance` so the route polyline ends in the
  same spot as distance-driven features (anchor lines, hover);
  otherwise the two visibly diverge.

### SegmentMap controls and 2D/3D toggle

- **Bottom-left**: Map toggle (OSM tile + earth block).
- **Bottom-right**: Anchor-lines toggle, Vertical exaggeration popover
  (Windows-volume-control style — square button shows current `n×`,
  hover opens a vertical slider via `writing-mode: vertical-lr;
  direction: rtl;`), 2D/3D toggle pinned rightmost. The middle two
  hide in 2D mode.
- **2D/3D pose memory**: `is3D` is `pitch > 0.01`. An effect mirrors
  live `(pitch, yaw)` into `(savedPitch, savedYaw)` while in 3D, so
  flatten-and-restore works even for poses reached via drag rather
  than the toggle. Default 3D preset is `Math.PI / 4` if there's no
  saved pose yet.
- **Resize handle**: bottom-right corner, document-level pointer
  listeners (not `setPointerCapture`, which would steal events from
  uPlot or the SVG hit-testing). When the user has resized,
  `dimensions.canvasAspect` is recomputed from `wrapperWidth /
  userHeight` so the projection refits without letterboxing.
- **Reset view** appears top-right when zoom/pan/rotation differ from
  defaults. Doesn't touch `zExaggeration` or saved 3D pose.

### Cross-component hover

`SegmentProfile` and `SegmentMap` each expose a `hoverDistM`
`$bindable` (live distance under cursor) and accept an
`externalHoverDistM` prop (peer's hover, drives a halo highlight on
the corresponding bar/polyline section). Parent wires them through
**two separate state vars** (`mapHoverDistM`, `chartHoverDistM`) — do
NOT bind both ends to the same variable, that would loop.

### Garmin integration (`garmin/` + `/api/garmin`)

A Connect IQ **data field** for the Edge 540 ("klym on the handlebars"):
whole-route colored-bar profile with a you-are-here marker, auto-zoom
into the current detected climb. Personal/sideloaded, Monkey C, built
with a Makefile in `garmin/` (SDK is a manual SDK Manager install; the
devShell supplies the JDK — see `garmin/README.md`).

Web side: `buildGarminPayload` (`src/lib/garmin.ts`, pure + tested)
resamples a route onto one fixed step (≤ ~1200 samples) and emits
compact integer arrays — elevation in **decimeters**, lat/lon ×1e5,
climbs as `[startM, endM, cat, avgGrade10, gainM, maxGrade10]` tuples
(cat: 0 uncat, 1='4'…5='HC') — because the Edge 540 gives a data field
only ~125 KB and Monkey C dictionaries have brutal per-key overhead.
The device computes bar grades from the elevation array itself.

Flow: "Send to Garmin" (route viewer header, form action
`sendToGarmin`) pushes the payload into a single in-memory slot
(`src/lib/server/garmin.ts`, outside session storage — the device has
no cookie); the field fetches `GET /api/garmin/current?token=…` via the
paired phone. Everything is gated on the `KLYM_GARMIN_TOKEN` env var
(`$env/dynamic/private`; `.env` has `devtoken` for dev): unset = feature
off; the send button only renders when the browser holds the pairing
cookie from `/garmin/setup?token=…`. The client's *current* detections
travel in a hidden `climbs` form field (WYSIWYG with the preset picker)
through `sanitizeGarminClimbs`. Slot empties on every restart/deploy —
re-send before riding. `garmin/source/Palette.mc` mirrors the klym
THEME_BANDS + categoryColor values; keep them in sync by hand.

## UI conventions

- Tailwind only, no component library.
- Icons are inline SVG (Lucide paths), 3.5×3.5 sizing in stat labels.
- Gradient pills use white text on the colored background — yellow end
  of the scale is saturated (`#eab308`, not pale amber) so the text
  stays legible.
- Buttons: primary = `bg-neutral-900 text-white`, secondary = ghost text.

## User preferences (see also `~/.claude/projects/.../memory/`)

- Editor is Neovim, not VSCode. Don't commit `.vscode/`.
- `git` without `-C`; cwd is always the repo root.
- Prefer `pnpm <script>` over `pnpm exec <tool>`.
- UI/UX polish goes after functional correctness — the user will say
  when to polish.
- Don't force-push or amend published commits unless explicitly asked.

## Milestones shipped

M1 scaffold · M2 GPX upload + parse · M3 route viewer · M4 two-marker
crop · M5 save / list / delete segments · M6 CF-style image + export ·
M7 route/segment management (rename + delete + adjust) · M8 SegmentMap
3D topo view (OSM ground, anchor lines, 2D/3D toggle, resizable) ·
M9 topo split into testable modules under `src/lib/topo/` (projection,
tiles, geometry, viewport) + vitest suite covering elevation/geo/slug
helpers and all four topo modules (~120 tests) · M10 self-host:
adapter-node, anonymous per-visitor sessions (`hooks.server.ts`),
in-memory owner-scoped storage, Nix flake + NixOS module + hosting guide
(`HOSTING.md`); deployed live behind a Cloudflare Tunnel · M11 climb
autodetection in the route viewer (`src/lib/climbs.ts`): two-tier gap
bridging, expandable parts, hover preview + quick-save, three sensitivity
presets (see the autodetection note above) · M12 Garmin Connect IQ
integration (`garmin/` + the send/fetch endpoints; see the Garmin note
above) — web side live-verified, device field written but pending the
one-time SDK install for simulator/on-bike verification.

## Next milestone (planned)

M13 Strava sign-in + route/activity import (OAuth2). Routes via
`/routes/{id}/export_gpx` reuse `parseGpx` as-is; activities via
`/activities/{id}/streams` map to `RoutePoint[]` and carry HR/power/
cadence natively. The HTTPS callback URL it needs is already live:
`https://klym.hlink.dev`.
Caveat: Strava caps new apps to 1 athlete (you) until app review
(~7–10 business days); ephemeral storage already satisfies their
no-long-term-retention terms.
