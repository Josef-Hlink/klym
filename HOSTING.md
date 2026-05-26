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

## Step 3 — Add klym to your system flake

In your machine's `/etc/nixos/flake.nix` (or wherever your config lives):

```nix
{
  inputs.klym.url = "github:Josef-Hlink/klym";   # or path:/srv/klym while iterating

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

## Not in scope (yet)

- **Strava sign-in / route import** — the next milestone. OAuth needs exactly
  the stable HTTPS callback URL this setup gives you (`origin`). Note Strava
  caps new apps to a single athlete (you) until you pass their app review.
- **Persistence across restarts** — deliberately omitted; revisit if you ever
  want logged-in users to keep their work.
