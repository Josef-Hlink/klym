# klym

A small personal app that turns a GPX file into climbfinder.com-style
colored-bar climb profile images.

## What it does

1. Upload a GPX. Give it a name; klym slugifies that into a route id.
2. Browse the route on a map + elevation chart with a synced crosshair.
3. Place two markers (A, B) to crop a segment — click to set, drag to
   fine-tune. Placement is directional: clicks left of A set/replace A,
   clicks right of B set/replace B. A can't cross past B.
4. Save the crop under a name → segment JSON lands on disk.
5. Open the segment page to render the CF-style profile (500m-bucket
   bars colored by gradient, elevation polyline on top, start/end
   elevations labeled). Tune the bin size live, toggle grade labels,
   and export as PNG, copy to clipboard, or download the raw SVG.

## Stack

- SvelteKit 2 + Svelte 5 + TypeScript + Vite 8
- Tailwind CSS v4 (`@tailwindcss/vite`)
- MapLibre GL (OSM raster tiles) for the map
- uPlot for the interactive elevation chart
- `fast-xml-parser` for GPX parsing
- Node filesystem for storage (no database)

## Getting started

```sh
pnpm install
pnpm dev
```

Then open http://localhost:5173.

## Commands

| Command           | What it does                              |
| ----------------- | ----------------------------------------- |
| `pnpm dev`        | Dev server with HMR                       |
| `pnpm build`      | Production build                          |
| `pnpm preview`    | Preview the production build              |
| `pnpm check`      | `svelte-kit sync` + `svelte-check`        |

## Data storage

All user data lives under `./data/` (gitignored, created at runtime):

```
data/
  <route-id>/
    route.gpx               # raw upload
    route.json              # parsed points + metadata
    segments/
      <segment-id>.json     # each saved crop
```

Slugged ids are unique per scope: routes are unique per installation,
segments are unique per parent route.

## License

MIT. See [LICENSE](./LICENSE).
