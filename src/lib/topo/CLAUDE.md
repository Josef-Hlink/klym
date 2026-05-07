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
| `tiles.ts` | Slippy-tile coordinate math, `TILE_SOURCES`, `pickTileZoom`, `computePaddedTileBBox`, `tileFadeOpacity`, the DOM-touching `buildTileImage`. |
| `geometry.ts` | Per-frame SVG-ready builders: polylines, anchor lines, drape paths, block faces, hover highlight, tile transform. All take a `Projector`. |
| `viewport.ts` | Viewport pan/zoom math: `clampViewport`, `applyZoomAtCursor`, `isZoomedOrPanned`, `formatViewBox`. |

Each module has a co-located `*.test.ts`. Run them with `pnpm test`.

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
- **`buildTileImage` is the only DOM-touching function in here.** It
  needs `document` + `Image` + a 2D canvas. If you ever try to
  unit-test it, mock the DOM or — better — extract whatever logic
  you're testing into a pure helper instead.
