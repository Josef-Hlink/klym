# CLAUDE.md

Context for future Claude sessions working on klym.

## What klym is

A local-only, single-user web app that turns GPX files into
climbfinder.com-style colored-bar climb profile images. Users manually
select climbs with two markers on a synced map + elevation chart; no
automatic climb-detection algorithms.

Remote: `Josef-Hlink/klym` (private, MIT).

## Stack

- SvelteKit 2.57, Svelte 5.55, Vite 8, TypeScript 6
- Tailwind CSS v4 via `@tailwindcss/vite` (no config file; import in `src/app.css`)
- MapLibre GL 5 (OSM raster tiles, no token required)
- uPlot 1.6 (interactive elevation chart in the route viewer)
- `fast-xml-parser` (GPX parsing server-side)
- Node `fs/promises` for persistence — no database
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

- `/` — upload + route list (SSR on)
- `/routes/[id]` — route viewer: map + chart + marker UI + segments
  list (SSR **off** — MapLibre and uPlot both need the DOM)
- `/routes/[id]/segments/[segId]` — segment profile + export (SSR **off**
  for the same reason; rasterization also needs the DOM)

Server loads (`+page.server.ts`) still run server-side even with
`ssr = false`; only HTML rendering is skipped.

## Storage layout

```
data/<route-id>/
  route.gpx            # raw upload
  route.json           # { id, name, points, totalDistM, totalAscentM, bounds, createdAt }
  segments/<seg-id>.json   # { id, routeId, name, startDistM, endDistM, binSizeM, createdAt }
```

`data/` is gitignored and created lazily. Ids are slugified names,
unique per scope (routes globally, segments per route). Conflicts return
409 with an inline error.

## Key design decisions

- **Manual crop, not auto-detect.** The two-marker UX is the whole
  point; don't propose climb-detection algorithms.
- **Filesystem storage.** Keep it that way unless the user asks for
  auth / multi-user / cloud.
- **500m default bucket.** The CF bar resolution. Bin size is configurable
  per segment view but not per route.
- **50m elevation smoothing for cumulative ascent.** Raw GPS elevation
  summed naively over-reports by ~2×. We smooth, then sum positive
  deltas. Lives in `src/lib/elevation.ts::computeTotalAscent`.
- **Gradient color scale** (`gradeColor` in `elevation.ts`): slate for
  descent (< -1%), yellow → amber → orange → red → dark red for
  ascending grades. Shared across the hover tooltip, stat pills, and
  the CF image bars.

## Invariants

- `markerA` ≤ `markerB` always. Directional placement (click left of A
  sets A, click right of B sets B, clicks inside are ignored) and drag
  clamping (A can't cross B, B can't cross A) both enforce this.
- Crop min length 10m — shorter selections don't produce cropStats and
  the Selection panel stays hidden.

## Non-obvious technical notes

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

The chart's logo is **inlined as polygons** in `SegmentProfile.svelte`
(scaled-down copy of `static/logo.svg`) so it survives serialization
without a separate `<image href>` round-trip. CSS classes are not
preserved when an SVG is rendered from a data URL — only inline
attributes and direct presentation styles. Anything you want to be
visible in the export must be encoded that way.

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
helpers and all four topo modules (~120 tests).
