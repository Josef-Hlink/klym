# klym Connect IQ data field

"klym on the handlebars": an Edge 540 data field that fetches the route you
sent from the klym web UI (`Send to Garmin` on a route page) and draws the
whole-route klym profile — a silhouette of the adaptively simplified
elevation in klym's grade colors — with a you-are-here marker. Inside a
detected climb it switches to a ClimbPro-style view: a 2 km window sliding
with the rider at 20% (400 m behind, 1.6 km ahead), adaptive constant-grade
sections with % labels, remaining distance/gain (whole climb and current
section), current grade, and the whole climb as a slim 500 m colored-bar
strip that brackets the on-screen slice.

How it talks to klym: `GET <server>/api/garmin/current?token=…` through the
paired phone (Garmin Connect Mobile). The web side is in
`src/lib/garmin.ts` (payload), `src/lib/server/garmin.ts` (slot + token) and
`src/routes/api/garmin/current/+server.ts`.

**Distribution is via the Connect IQ store** (personal app, publicly listed
but useless without a token): store binaries are public, so nothing secret
is compiled in — the server URL and pairing token are **Connect IQ app
settings**, edited in the Garmin Connect phone app (device → Connect IQ
apps → klym → Settings). Until both are set the field shows "set token in
app settings". Settings changes push to the device live; the field retries
the fetch immediately.

> Sideloading (`make sideload`) exists but the Edge x40's MTP implementation
> flips to a read-only state that survives reboots on some units — all
> write ops refused / stalled from macOS and Linux alike. The store route
> avoids USB entirely.

## One-time setup

1. **SDK**: install Garmin's [SDK Manager](https://developer.garmin.com/connect-iq/sdk/),
   then use it to download the latest Connect IQ SDK **and the Edge 540
   device files** (Devices tab). The Makefile finds the SDK via
   `~/Library/Application Support/Garmin/ConnectIQ/current-sdk.cfg`.
   `monkeyc` needs a Java runtime (the repo devShell provides one).
2. **Developer key** (signs every build):

   ```sh
   mkdir -p ~/.config/garmin
   openssl genrsa -out /tmp/klym_ciq.pem 4096
   openssl pkcs8 -topk8 -inform PEM -outform DER -nocrypt \
     -in /tmp/klym_ciq.pem -out ~/.config/garmin/developer_key.der
   rm /tmp/klym_ciq.pem
   ```

## Workflow

- `make sim` — build against the local dev server (`http://127.0.0.1:1047`,
  token `devtoken`, matching the repo `.env` — baked in as compile-time
  overrides so the sim needs no settings) and launch the simulator.
  Send a route from the local web UI first, or you'll see "no route sent".
  - Simulate a ride: *Simulation → Activity Data…* and play back a GPX/FIT
    (stage 19, `src/lib/server/tdf-2026/stage-19.gpx`, ends up Alpe d'Huez;
    convert with `gpsbabel` if your SDK's playback only takes FIT).
  - Or skip playback entirely: `make sim-config DEMO=true build`, then push —
    with no GPS fix the field rides the loaded route by itself (30 m/s from
    just before the first climb). A real fix always takes over; device
    builds hardcode the flag off.
  - Watch memory: *File → View Memory* — the data field budget on the
    Edge 540 is ~124.7 KB. Every successful route load also prints
    `klym mem: used/total` to the monkeydo console.
  - Design without the simulator: `preview/` holds an HTML/canvas port of
    the renderer (see `preview/README.md`).
- `make package` — exported, release-mode `bin/klym.iq` for the store:
  upload at the [developer dashboard](https://apps.garmin.com/developer/dashboard)
  (needs a one-time Connect IQ developer signup on your Garmin account).
  After review, install on the Edge from the Connect IQ store via the
  phone, then set the token in the app's settings.
- `make config build` / `make sideload` — the legacy USB path: a `.prg`
  with empty overrides (settings still supply URL + token), copied to the
  Edge's `Garmin/Apps/` — if its MTP lets you.
- On the Edge: add a **1-field page** to your activity profile and pick
  *Connect IQ → klym* as its field. The field fetches at the start screen;
  after sending a new route from the browser, re-enter the activity.

`make build` alone reuses whatever `source/Config.mc` exists (defaults to
the simulator config) — use the explicit `config`/`sim-config` targets when
switching targets.

## Fetch-once, by design

The field fetches the route **once per activity** and then goes quiet —
no polling, no surprise route swaps mid-ride, no radio chatter. Sending a
new route from the browser does nothing to an already-open activity;
back out of the activity and re-enter it and the rebuilt field fetches
fresh. Rule of thumb: send the route you want, *then* open the activity.

## Store listing draft (for an eventual public release)

> klym draws the elevation profile of the route you're riding, colored by
> gradient — and inside a climb it zooms to a sliding window of the road
> ahead, ClimbPro-style, with constant-grade sections and % labels.
>
> Requires a klym server: send a route from the klym web app, then the
> field fetches it through your phone at the start of each activity.
> Configure the server URL and pairing token in the app settings (Garmin
> Connect → device → Connect IQ apps → klym).
>
> Notes:
> - The route is fetched once, when you open the activity. Sent a new
>   route? Back out of the activity and re-enter it.
> - The server keeps one route per token ("what am I riding right now"),
>   and it's cleared on server restarts — re-send before you ride.
> - No token configured = the field tells you on screen. A phone with
>   Garmin Connect must be paired and nearby for the fetch.
