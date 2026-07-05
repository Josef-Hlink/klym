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
                                              in-memory, per-visitor
```

`cloudflared` dials *out* to Cloudflare and holds the connection open, so the
box needs **zero open inbound ports**. klym itself only listens on loopback;
the tunnel is the only thing that can reach it.

**Data is ephemeral.** Storage is an in-memory map keyed by an anonymous
`klym_sid` session cookie (see `src/lib/server/storage.ts`). Each visitor gets
their own isolated routes/segments; everything is dropped when the session's
cookie expires, after ~6h idle, or whenever the service restarts (including
every redeploy). There is no database and nothing on disk to back up.

## Prerequisites

- A NixOS box with flakes enabled:
  ```nix
  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  ```
- A domain whose DNS is managed by Cloudflare (any plan, including free).
- `cloudflared` available — `nix-shell -p cloudflared` is enough for the
  one-time setup commands below.

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
first. Every restart wipes in-memory data — expected, by design.

## Tuning the in-memory limits

Defaults live at the top of `src/lib/server/storage.ts`:

| Constant                  | Default | Meaning                                   |
| ------------------------- | ------- | ----------------------------------------- |
| `SESSION_TTL_MS`          | 6h      | idle sessions are swept                   |
| `MAX_SESSIONS`            | 200     | concurrent visitors before oldest evicted |
| `MAX_ROUTES_PER_SESSION`  | 50      | routes per visitor                        |
| `MAX_SEGMENTS_PER_ROUTE`  | 100     | segments per route                        |

Raise them if your box has the RAM and you trust your audience; keep them low
if the link is public, since a parsed 15 MB GPX is a chunk of memory per route.

These caps bound *counts*, not *bytes* — they can't stop a flood of large
uploads from growing the heap. The systemd resource ceiling below is the
backstop for that.

## Capping memory at the systemd level

The store has no hard byte limit, so the module also caps the service cgroup.
On NixOS this is just systemd's `MemoryHigh`/`MemoryMax`:

| Option              | Default | Meaning                                            |
| ------------------- | ------- | -------------------------------------------------- |
| `services.klym.memoryHigh` | `384M`  | soft limit: throttle + reclaim above this   |
| `services.klym.memoryMax`  | `512M`  | hard limit: kernel OOM-kills klym at this   |
| `services.klym.cpuQuota`   | `200%`  | CPU ceiling, in cores (`100%` = one core)   |

When klym crosses `memoryMax` the kernel OOM-kills it; `OOMPolicy = "kill"`
takes down the whole cgroup and `Restart = on-failure` restarts it with a
fresh (empty) store — harmless, since storage is ephemeral. If it keeps
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

The route slot is in-memory like everything else: every deploy or restart
empties it, so re-send the route from the browser before riding. Anyone who
has the token can read/overwrite the single slot — it's a personal feature;
rotate the token in the env file if it ever leaks.

## Not in scope (yet)

- **Strava sign-in / route import** — the next milestone. OAuth needs exactly
  the stable HTTPS callback URL this setup gives you (`origin`). Note Strava
  caps new apps to a single athlete (you) until you pass their app review.
- **Persistence across restarts** — deliberately omitted; revisit if you ever
  want logged-in users to keep their work.
