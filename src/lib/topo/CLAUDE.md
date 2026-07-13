# src/lib/topo/

Pure modules backing `SegmentMap.svelte` (3D segment topo view). The
component owns reactive state and the SVG template; everything here is
plain functions you can unit-test without a DOM.

See the **SegmentMap (3D segment view)** and **`src/lib/topo/` modules**
sections in the root `CLAUDE.md` for the architectural overview and
per-feature design rationale. This file is for the conventions you need
when working *inside* this directory.

## Module map

| File | What's in it |
| --- | --- |
| `projection.ts` | World → canvas math (`rotate3d`, `computeRefFrame`, `computeDimensions`, `projectLLE`, `makeProjector`) + canvas constants. |
| `tiles.ts` | Slippy-tile coordinate math, `TILE_SOURCES`, `pickTileZoom`, `computePaddedTileBBox`, `tileFadeOpacity`, `snapshotDims`/`snapshotCamera` (vector-ground exact-fit math), the DOM-touching `buildTileImage`. |
| `vectorTile.ts` | DOM-touching `buildVectorTileImage`: off-screen MapLibre snapshot of the Protomaps basemap, shaped as a `TileImage`. |
| `dem.ts` | Terrarium DEM grid: `decodeTerrarium`, `demGridDims`, `gridFromPixels`, `demEleAt` (triangulated — matches the rendered mesh), `computeShade` (lambert), the DOM-touching `buildDemGrid`. |
| `terrain.ts` | Heightfield mesh math (pure): `affineFromTriangle`, `buildClipTriangles`, `buildTerrainMesh`, `terrainDrawOrder`, `buildTerrainBlockFaces`. |
| `visibility.ts` | Route occlusion as a geometric mask (pure): `computeVisibility` (view-ray march over the DEM: clearance margin, pitch-scaled near skip, island smoothing), `smoothVisibility`, `visibleAtDist`. |
| `hillshade.ts` | DOM-touching `bakeHillshade`: multiplies `computeShade` over the ground texture once per texture/grid pair. |
| `geometry.ts` | Per-frame SVG-ready builders: polylines, anchor lines, drape paths, block faces, hover highlight, tile transform. All take a `Projector`; ground-touching builders take an optional `groundEleAt` sampler (default: flat `refFrame.minEle`). |
| `viewport.ts` | Viewport pan/zoom math: `clampViewport`, `applyZoomAtCursor`, `isZoomedOrPanned`, `formatViewBox`. |

Each pure module has a co-located `*.test.ts`. Run them with `pnpm test`.
DOM-touching functions (`buildTileImage`, `buildVectorTileImage`,
`buildDemGrid`, `bakeHillshade`) are one per module and untested by policy.

## The Projector pattern

`Projector = (lat, lon, ele) => [svgX, svgY, depth]`. Everything in
`geometry.ts` takes one as a parameter rather than reading reactive
camera state directly — that's what keeps these functions pure.

The component constructs the projector once per camera change:

```ts
const project = $derived.by(() =>
  refFrame ? makeProjector({ refFrame, dimensions, yaw, pitch, zExaggeration }) : fallback
);
```

…then passes `project` into every `build*` call. **Don't import
`projectLLE` directly into geometry helpers** — that would force them to
take a `ProjectCtx` and re-pack the args at every call site. Take a
`Projector` instead.

## Adding a new topo feature

1. Write the math as a pure function in the right module (or a new one
   if it's a new concern). Take whatever inputs you need — a
   `Projector`, the route, the bins, etc. — and return SVG-ready
   primitives (point strings, line records, path data).
2. Add a `*.test.ts` next to it. Use the **identity-style projector**
   trick from the existing tests (`(lat, lon, ele) => [lon, -lat, ele]`)
   so you can assert on shape/ordering without standing up the full
   orthographic stack. Use it for:
   - bounds/null cases (returns `[]` / empty string when refFrame is
     null, points list is too short, range is degenerate)
   - count/grouping invariants (e.g. one quad per segment, one anchor
     per bin boundary, runs sorted back-to-front by depth)
   - cursor-anchor / world-pinned invariants for interactive math
3. In `SegmentMap.svelte`, wire it as a one-liner `$derived` against the
   reactive inputs — the component should never re-implement the math
   inline.

## Gotchas

- **Thin anchor lines don't always pin the segment end.**
  `buildAnchorLines` steps by `ANCHOR_STEP_M` (250m) and stops when `d`
  overshoots `endDistM`. So a 1025m segment gets thin anchors at 0,
  250, 500, 750, 1000 — nothing at 1025. The colored
  `buildBoundaryAnchors` pass is what pins the segment end (and every
  bin boundary). Don't "fix" the thin pass to include `endDistM`; the
  two passes serve different purposes (uniform-density background vs.
  per-bin coloured anchors).
- **The tile bbox padding has two regimes.** `computePaddedTileBBox`
  uses the larger of the base 10% pad and the canvas-aspect extension
  (so a square route in a wide canvas gets enough lon-side padding to
  fill the canvas). Don't simplify to one pad value — you'll get bare
  grey margins.
- **One DOM-touching function per module** (`buildTileImage`,
  `buildVectorTileImage`, `buildDemGrid`, `bakeHillshade`) — they need
  `document` + `Image` + canvas (+ WebGL for the vector snapshot). If
  you ever try to unit-test one, mock the DOM or — better — extract
  whatever logic you're testing into a pure helper instead.
- **`buildDemGrid` prefills its canvas with terrarium-encoded 0 m
  (`rgb(128,0,0)`), not a UI grey.** A grey fill would decode failed
  tiles to a ≈ +30 km elevation spike. Zero tiles loaded → `null` →
  the component falls back to the flat ground.
- **DEM grid rows are Mercator-uniform, not latitude-uniform.** That
  makes vertex `(r, c)` sit at exactly UV `(c/(w−1), r/(h−1))` in the
  Mercator-cropped ground texture — the whole reason the terrain mesh's
  texture mapping is a trivial linear correspondence. `demEleAt` maps
  latitude through `latToTileY` accordingly; don't "simplify" it to
  linear-in-lat.
- **Terrain texture mapping uses triangles, not quads.** Heightfield
  cells are non-planar; two affines per cell agree exactly along shared
  edges (linearity), so geometry can't crack. The static UV clip paths
  are dilated ×1.03 about their centroids to close anti-aliasing seams;
  the mesh gets ONE group-level opacity (per-triangle opacity would
  double-darken the overlaps into visible grid lines).
- **`demEleAt` interpolates over the TRIANGULATED cell surface** (the
  same NE–SW split the mesh draws), not bilinear — the visibility test
  must see exactly the surface that's rendered. Don't "simplify" it.
- **Route occlusion is `visibility.ts`'s geometric mask — never move it
  into the painter.** The route draws on top of the mesh; hidden
  stretches drop from the solid runs and reappear as a low-opacity
  ghost drawn above the block walls (wall-covered stretches join the
  ghost via `pointInPolygon` against the faces' `verts`). Two
  paint-level attempts (ray-dashed polylines, painter-interleaved
  per-cell route runs) live on the `occlusion-dead-end` branch as the
  record of why not.
