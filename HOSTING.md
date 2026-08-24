# Self-hosting klym on NixOS behind a Cloudflare Tunnel

This is the deployment guide for running klym on your own NixOS box, exposed
to the internet through a Cloudflare Tunnel — no open inbound ports, no
router port-forwarding.

## How the pieces fit

```
browser ──https──▶ Cloudflare edge ──tunnel──▶ cloudflared (on your box)
                                                    │ http://127.0.0.1:1047
                                                    ▼
                                              klym (Node, systemd)
                                                    │ unix socket
                                                    ▼
                                              postgres (klym db)
```

`cloudflared` dials *out* to Cloudflare and holds the connection open, so the
box needs **zero open inbound ports**. klym itself only listens on loopback;
the tunnel is the only thing that can reach it.

**Data is durable, and per-visitor.** Routes and segments live in postgres,
scoped by an anonymous `klym_sid` cookie (see `src/lib/server/storage.ts`).
Each visitor gets their own isolated sandbox and gets it back on a return
visit; a redeploy or restart no longer wipes anything. Owners idle for 90 days
are swept. There is a database to back up now — see Step 0.

**No password anywhere in this setup.** klym runs as a systemd `DynamicUser`,
which creates a transient system user named `klym`; postgres peer auth over
the unix socket maps that name onto the `klym` role. That's the entire
credential story, and it's why `DynamicUser = true` is load-bearing rather
than just hardening.

## Prerequisites

- A PostgreSQL instance on the same box, with a `klym` role and a `klym`
  database it owns, reachable on a unix socket. See Step 0.
- A NixOS box with flakes enabled:
  ```nix
  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  ```
- A domain whose DNS is managed by Cloudflare (any plan, including free).
- `cloudflared` available — `nix-shell -p cloudflared` is enough for the
  one-time setup commands below.

## Step 0 — The database

klym needs a `klym` role and a `klym` database it owns. Declare them rather
than reaching for `createdb`, so the next person reading the config sees them:

```nix
services.postgresql = {
  enable = true;
  ensureDatabases = [ "klym" ];
  ensureUsers = [ { name = "klym"; ensureDBOwnership = true; } ];
};
```

No password and no `pg_hba` change: the default `local` peer rule already
matches the transient `klym` user the service runs as.

Two things `ensureUsers` will *not* do for you:

- **Admin access.** `ensureUsers` has no notion of grants, so your own login
  role can connect to the database but can't read its tables. Fix once, after
  the database exists: `sudo -u postgres psql -c 'GRANT klym TO youruser;'`
- **Backups.** Nothing here sets them up. A nightly `pg_dumpall` is the
  minimum now that a redeploy no longer being destructive is the whole point.

Verify the app's own connection path — a sandboxed `DynamicUser` reaching a
socket under `ProtectSystem = strict` is the one part worth proving:

```sh
sudo systemd-run --pty --collect \
  -p DynamicUser=yes -p User=klym \
  -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
  /run/current-system/sw/bin/psql -h /run/postgresql -d klym \
  -Atc 'select current_user, current_database()'
```

Expect `klym|klym`.

`services.klym.databaseUrl` defaults to
`postgresql:///klym?host=/run/postgresql` and only needs setting if your
socket lives elsewhere. Keep the libpq `?host=` spelling — `psql` and
`pg_dump` take the same string, and `src/lib/server/db.ts` translates it for
the driver, which doesn't understand that form natively.

Schema is applied by the app itself: migrations are bundled into the build and
run once per process on first use, tracked in a `_migrations` table. There is
no manual migrate step at deploy.

## Step 1 — Create the Cloudflare Tunnel

Run these once (on the box, or anywhere — you'll move the credentials file to
the box afterwards). Replace `klym.example.com` with your hostname.

```sh
cloudflared tunnel login              # opens a URL; authorize your zone
cloudflared tunnel create klym        # prints a TUNNEL_ID, writes ~/.cloudflared/<TUNNEL_ID>.json
cloudflared tunnel route dns klym klym.example.com   # creates the CNAME for you
```

You now have two things you need:
- the **TUNNEL_ID** (a UUID), and
- the **credentials JSON** at `~/.cloudflared/<TUNNEL_ID>.json`.

Copy the JSON somewhere the box's `cloudflared` service can read it, e.g.
`/etc/cloudflared/klym.json` (root-owned is fine; the service runs as root or
the `cloudflared` user depending on your config). For anything more than a toy
setup, prefer a secrets manager (sops-nix / agenix) over a plaintext path.

> **Already running a tunnel on this box?** Don't create a second one — reuse
> it. Add an `ingress` rule for klym's hostname to the existing tunnel and
> point a CNAME at it with `cloudflared tunnel route dns <TUNNEL_ID> <host>`.
> One tunnel can serve many hostnames.

## Step 2 — Pin the dependency hash (one time)

The flake builds klym reproducibly, which means it needs the hash of the
resolved pnpm dependency tree. It ships as `lib.fakeHash`, so the first build
deliberately fails and tells you the real value:

```sh
# in a checkout of this repo
nix build .#default
# error: hash mismatch … got: sha256-AbCd…
```

Paste that `got:` value into `flake.nix` (`pnpmDeps.hash`), then `nix build`
again to confirm it succeeds. **Commit the hash.** Redo this only when
`pnpm-lock.yaml` changes.

> **Don't "fix" the pnpm deprecation warnings.** The flake pins
> `pnpm_10.configHook` + `fetcherVersion = 1` on purpose. Migrating to the
> top-level `fetchPnpmDeps` / `fetcherVersion = 3` breaks on nixpkgs whose
> default `pnpm` is v11: the config hook can't find `.fetcher-version`, falls
> back to v1, and pnpm 11 then can't read the v1 store
> (`ERR_PNPM_NO_OFFLINE_TARBALL`). The pinned hook bundles its own pnpm, so
> fetch and install stay consistent. See the comment in `flake.nix`; revisit
> once that path stabilises (the warnings are harmless until the 26.11 release).

## Step 3 — Add klym to your system flake

In your machine's `/etc/nixos/flake.nix` (or wherever your config lives):

```nix
{
  # Public repo: "github:OWNER/klym". If the repo is PRIVATE, use git+ssh —
  # the github: fetcher uses the anon GitHub API, which 404s on private repos.
  inputs.klym.url = "git+ssh://git@github.com/OWNER/klym?ref=BRANCH";

  outputs = { self, nixpkgs, klym, ... }: {
    nixosConfigurations.YOUR_HOST = nixpkgs.lib.nixosSystem {
      modules = [
        klym.nixosModules.default
        ./configuration.nix
      ];
    };
  };
}
```

> **Private input + `sudo nixos-rebuild`:** the rebuild fetches flake inputs
> as **root**, which has no GitHub SSH key, so a git+ssh input fails with
> `Permission denied (publickey)`. Fix it by locking as *your* user first:
> run `nix flake lock` (no sudo) so the input is fetched with your key and
> pinned into the shared `/nix/store`, commit the updated `flake.lock`, then
> rebuild — the root build reuses the locked store path and never fetches.

Then, in `configuration.nix`:

```nix
{
  services.klym = {
    enable = true;
    origin = "https://klym.example.com";   # REQUIRED — see note below
    # port = 1047;                          # default; only change if it clashes
  };

  services.cloudflared = {
    enable = true;
    tunnels."TUNNEL_ID" = {
      credentialsFile = "/etc/cloudflared/klym.json";
      default = "http_status:404";
      ingress."klym.example.com" = "http://127.0.0.1:1047";
    };
  };
}
```

> **Why `origin` is required:** SvelteKit checks the `Origin` header on every
> form POST (uploading a GPX, saving a segment). Behind the tunnel the request
> arrives at `127.0.0.1`, so without telling the server its real public URL,
> those POSTs are rejected as cross-site (403). The module wires `origin` into
> the `ORIGIN` env var that adapter-node reads. It also sets
> `BODY_SIZE_LIMIT=16M` so the 15 MB GPX cap actually works (adapter-node
> otherwise defaults to 512K and large uploads 413).

## Step 4 — Deploy

```sh
sudo nixos-rebuild switch --flake /etc/nixos#YOUR_HOST
```

Check both services came up:

```sh
systemctl status klym
systemctl status cloudflared
journalctl -u klym -f      # follow logs
```

Then open `https://klym.example.com`. Upload a GPX, crop a climb, export the
image. Open the site in a private window — you should see an empty route list,
confirming per-visitor isolation.

## Updating

Bump the input and rebuild:

```sh
nix flake update klym --flake /etc/nixos
sudo nixos-rebuild switch --flake /etc/nixos#YOUR_HOST
```

If `pnpm-lock.yaml` changed in the new revision, refresh the hash (Step 2)
first. Restarts preserve data; any new migrations apply themselves on the
first request after the restart.

## Tuning the storage limits

These are abuse bounds, not memory bounds — the data is on disk now. Defaults:

| Constant                 | Where                       | Default | Meaning                        |
| ------------------------ | --------------------------- | ------- | ------------------------------ |
| `MAX_ROUTES_PER_OWNER`   | `src/lib/server/storage.ts` | 50      | routes per visitor             |
| `MAX_SEGMENTS_PER_ROUTE` | `src/lib/server/storage.ts` | 100     | segments per route             |
| `OWNER_TTL_MS`           | `src/lib/server/db.ts`      | 90 days | idle owners swept, cascading   |

Overflow evicts that owner's oldest entry. Raise them if you trust your
audience; keep them low if the link is public, since a 15 MB GPX is a real
chunk of disk per route.

The sweep is orphan collection: a visitor idle that long has almost certainly
lost the cookie pointing at their rows. Lower it if you want the box tidier,
raise it if losing a returning visitor's routes would annoy you.

## Capping memory at the systemd level

Parsing a 15 MB GPX and rehydrating a route's point array are both transient
memory spikes, so the module caps the service cgroup. On NixOS this is just
systemd's `MemoryHigh`/`MemoryMax`:

| Option              | Default | Meaning                                            |
| ------------------- | ------- | -------------------------------------------------- |
| `services.klym.memoryHigh` | `384M`  | soft limit: throttle + reclaim above this   |
| `services.klym.memoryMax`  | `512M`  | hard limit: kernel OOM-kills klym at this   |
| `services.klym.cpuQuota`   | `200%`  | CPU ceiling, in cores (`100%` = one core)   |

When klym crosses `memoryMax` the kernel OOM-kills it; `OOMPolicy = "kill"`
takes down the whole cgroup and `Restart = on-failure` restarts it — stored
data is in postgres and unaffected. If it keeps
OOMing, systemd's default start-rate limit trips and **leaves it stopped**, so
a runaway can't thrash the box; you'd `systemctl reset-failed klym` to revive
it. `cpuQuota` is the matching backstop for a shared box: klym's server side
is light (the only spike is parsing a large GPX on upload), so `200%` caps a
burst of concurrent uploads at two cores and leaves the rest for your other
services. Tune the ceilings to your box and your storage caps:

```nix
services.klym = {
  enable = true;
  origin = "https://klym.example.com";
  memoryMax = "768M";   # raise if you raised MAX_SESSIONS / MAX_ROUTES_PER_SESSION
  cpuQuota = "100%";    # tighten to one core if other services are CPU-hungry
};
```

Set any of them to `"infinity"` to disable that limit.

## Garmin integration (optional)

The Connect IQ data field in `garmin/` fetches "the current route" from
`GET /api/garmin/current?token=…`. The whole feature is gated on one shared
secret: set `KLYM_GARMIN_TOKEN` in an environment file outside the Nix store
and point the module at it — with it unset, the endpoints don't exist
(401/404 everywhere).

```sh
# on the host, once:
install -m 600 /dev/null /etc/klym.env
echo "KLYM_GARMIN_TOKEN=$(openssl rand -hex 24)" > /etc/klym.env
```

```nix
services.klym = {
  enable = true;
  origin = "https://klym.example.com";
  environmentFile = "/etc/klym.env";
};
```

Then, once per browser, visit
`https://klym.example.com/garmin/setup?token=<the token>` — that sets a
year-long cookie which makes the **Send to Garmin** button appear on route
pages. The device build bakes the same token in via `garmin/secrets.token`
(see `garmin/README.md`).

The route slot stays in-memory even though routes themselves no longer are —
it's a single global slot outside session storage, since the device has no
cookie. Every deploy or restart empties it, so re-send the route from the
browser before riding. Anyone who
has the token can read/overwrite the single slot — it's a personal feature;
rotate the token in the env file if it ever leaks.

## Not in scope (yet)

- **Strava sign-in / route import** — the next milestone. OAuth needs exactly
  the stable HTTPS callback URL this setup gives you (`origin`). Note Strava
  caps new apps to a single athlete (you) until you pass their app review.
- **Persistence across restarts** — deliberately omitted; revisit if you ever
  want logged-in users to keep their work.
