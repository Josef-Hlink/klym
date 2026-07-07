# Renderer preview harness

`preview.html` is a faithful JS/canvas port of the Monkey C rendering
pipeline (`RouteModel`, `Sections`, `Palette`, `Renderer`) that draws a grid
of 246×322 frames — route view and climb view at hand-picked rider
positions, light and dark — so renderer design can be iterated in a browser
(or screenshotted headlessly) without the simulator.

Open it over HTTP from this directory, e.g.

```sh
python3 -m http.server 8123
# → http://127.0.0.1:8123/preview.html
```

`payload.js` is a captured `/api/garmin/current` payload (TdF 2026 stage 19,
Gap → Alpe d'Huez, with real balanced-preset detections — 10 climbs, HC
finish). To swap routes, regenerate it as
`const PAYLOAD = <payload JSON>;`.

`locator-sim.cjs` is the same idea for `Locator.mc`: a line-faithful JS
port driven by synthetic noisy GPS rides over the payload track (the Alpe
d'Huez hairpins are the hard part), asserting the along-track output never
hops backwards. `node locator-sim.cjs` after any locator change.

**These are copies, not sources of truth.** The Monkey C under `../source/`
is the real implementation; when you change one side, port the change to
the other by hand. Garmin fonts are approximated, so text metrics are
close but not exact.
