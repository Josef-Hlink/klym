# klym Connect IQ data field

"klym on the handlebars": an Edge 540 data field that fetches the route you
sent from the klym web UI (`Send to Garmin` on a route page) and draws the
klym colored-bar profile with a you-are-here marker. Inside a detected climb
it zooms to that climb: category badge, remaining distance/gain, current and
remaining average grade. Personal, sideloaded — not on the Connect IQ store.

How it talks to klym: `GET $BASE_URL/api/garmin/current?token=…` through the
paired phone (Garmin Connect Mobile). The web side is in
`src/lib/garmin.ts` (payload), `src/lib/server/garmin.ts` (slot + token) and
`src/routes/api/garmin/current/+server.ts`.

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

3. **Token** (device builds only): put the production `KLYM_GARMIN_TOKEN`
   value in `garmin/secrets.token` (gitignored).

## Workflow

- `make sim` — build against the local dev server (`http://127.0.0.1:1047`,
  token `devtoken`, matching the repo `.env`) and launch the simulator.
  Send a route from the local web UI first, or you'll see "no route sent".
  - Simulate a ride: *Simulation → Activity Data…* and play back a GPX/FIT
    (stage 19, `src/lib/server/tdf-2026/stage-19.gpx`, ends up Alpe d'Huez;
    convert with `gpsbabel` if your SDK's playback only takes FIT).
  - Watch memory: *File → View Memory* — the data field budget on the
    Edge 540 is ~124.7 KB.
- `make config build` — device build against `https://klym.hlink.dev` with
  `secrets.token`.
- `make sideload` — device build + copy `bin/klym.prg` to the Edge's
  `Garmin/Apps/` over USB. If `/Volumes/GARMIN` doesn't appear the Edge is
  in MTP mode — copy with OpenMTP, or switch the Edge to mass storage.
- On the Edge: add a **1-field page** to your activity profile and pick
  *Connect IQ → klym* as its field. The field fetches at the start screen;
  after sending a new route from the browser, re-enter the activity.

`make build` alone reuses whatever `source/Config.mc` exists (defaults to
the simulator config) — use the explicit `config`/`sim-config` targets when
switching targets.
