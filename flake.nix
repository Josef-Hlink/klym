{
  description = "klym — GPX climb-profile generator (SvelteKit, adapter-node)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      # The package/module only target deployment (linux); the devShell also
      # runs on the Mac where the Connect IQ toolchain (garmin/) lives.
      devSystems = systems ++ [ "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      forDevSystems = nixpkgs.lib.genAttrs devSystems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "klym";
            version = "0.0.1";
            src = ./.;

            # Build stamp for the footer — no .git in the sandbox, so hand the
            # rev + commit time (unix seconds) to vite via env. shortRev/
            # lastModified come from the flake input; a dirty tree falls back.
            KLYM_COMMIT = self.shortRev or self.dirtyShortRev or "dev";
            KLYM_COMMIT_TIME = builtins.toString (self.lastModified or 0);

            nativeBuildInputs = [
              pkgs.nodejs_24
              pkgs.pnpm
              pkgs.pnpmConfigHook
            ];

            # Reproducible offline pnpm store, fetched by fetchPnpmDeps as a
            # fetcherVersion 3 tarball and unpacked by pnpmConfigHook. Both use
            # nixpkgs' default `pkgs.pnpm` (11 at the current pin): the fetcher
            # takes it as its default `pnpm` argument, the hook finds it on PATH
            # via nativeBuildInputs. They must stay the same major, because the
            # store layout is pnpm-major-specific.
            #
            # The hash covers the lockfile, the pnpm major and the fetcher
            # format, so refresh it whenever pnpm-lock.yaml changes, a nixpkgs
            # bump moves the default pnpm major, or fetcherVersion changes: set
            # it to `pkgs.lib.fakeHash`, build, and paste back the
            # "got: sha256-…" value Nix prints. A stale hash doesn't fail the
            # fetch. Nix silently reuses the old output, and the mismatch only
            # shows up in pnpmConfigHook as ERR_PNPM_NO_OFFLINE_TARBALL.
            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              fetcherVersion = 3;
              # There is no darwin package output, so this builds on the remote
              # linux builder (ssh-ng://nixbuilder@esther) — `nix build
              # .#packages.x86_64-linux.default` from the laptop is enough.
              hash = "sha256-Y8J5Mkyla9nQz/zs4m35hMVlTIfAslaVyCANPhvH41k=";
            };

            buildPhase = ''
              runHook preBuild
              pnpm build
              runHook postBuild
            '';

            # adapter-node emits build/ (entry: build/index.js). It externalises
            # runtime deps, so node_modules ships alongside and Node resolves it
            # by walking up from build/index.js to lib/klym/node_modules.
            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/klym
              cp -r build node_modules package.json $out/lib/klym/
              runHook postInstall
            '';

            meta = {
              description = "GPX climb-profile generator";
              license = pkgs.lib.licenses.mit;
              mainProgram = "klym";
            };
          });
        }
      );

      nixosModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.klym;
        in
        {
          options.services.klym = {
            enable = lib.mkEnableOption "klym climb-profile web app";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
              defaultText = lib.literalExpression "klym.packages.\${system}.default";
              description = "The klym package to run.";
            };

            host = lib.mkOption {
              type = lib.types.str;
              default = "127.0.0.1";
              description = "Bind address. Keep on loopback; cloudflared reaches it locally.";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 1047;
              description = "Port the Node server listens on.";
            };

            origin = lib.mkOption {
              type = lib.types.str;
              example = "https://klym.example.com";
              description = ''
                Public origin. SvelteKit checks the Origin header on form POSTs;
                without this set to your real public URL, uploads/saves 403 behind
                the tunnel.
              '';
            };

            memoryHigh = lib.mkOption {
              type = lib.types.str;
              default = "384M";
              description = ''
                Soft memory limit (systemd MemoryHigh). Above this the kernel
                throttles the service and reclaims aggressively, smoothing
                transient spikes before the hard MemoryMax kill. Set to
                "infinity" to disable. Keep it below memoryMax.
              '';
            };

            memoryMax = lib.mkOption {
              type = lib.types.str;
              default = "512M";
              description = ''
                Hard memory ceiling (systemd MemoryMax). Routes live in postgres
                now, so this no longer bounds a growing store — it bounds the
                transient cost of the work itself: parsing a 15 MB GPX, and
                rehydrating a route's point array on read. At this ceiling the
                kernel OOM-kills klym and Restart=on-failure brings it back;
                stored data is unaffected. Set "infinity" to disable.
              '';
            };

            cpuQuota = lib.mkOption {
              type = lib.types.str;
              default = "200%";
              description = ''
                CPU ceiling (systemd CPUQuota), in units of one core: "100%" is
                one core, "200%" two, and so on. klym's server side is light — the
                only real spike is parsing a large GPX on upload — so this just
                keeps a flood of concurrent uploads from starving other services
                on a shared box. "200%" leaves the rest of the cores free; set
                "infinity" to disable.
              '';
            };

            databaseUrl = lib.mkOption {
              type = lib.types.str;
              default = "postgresql:///klym?host=/run/postgresql";
              description = ''
                Postgres connection string. The default connects over the unix
                socket as the transient DynamicUser named "klym", which peer
                authentication maps straight onto the "klym" role — so there is
                no password, no port and no secret file to manage. Keep the
                libpq `?host=/path` spelling: it is what psql and pg_dump take,
                and src/lib/server/db.ts translates it for the driver.

                The database and role are declared on the host (for esther, in
                dotfiles hosts/esther/postgres.nix); this module does not create
                them.
              '';
            };

            environmentFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              example = "/run/secrets/klym.env";
              description = ''
                systemd EnvironmentFile with secrets, kept out of the Nix
                store. Currently just KLYM_GARMIN_TOKEN=… — the shared secret
                for the Garmin Connect IQ integration (see garmin/ and
                HOSTING.md). Unset leaves the Garmin endpoints disabled.
              '';
            };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.klym = {
              description = "klym climb-profile web app";
              wantedBy = [ "multi-user.target" ];
              # postgresql.service matters: without it a reboot races klym
              # against the cluster, and repeated start failures burn systemd's
              # start-rate limit and leave the unit stopped for good.
              after = [
                "network.target"
                "postgresql.service"
              ];
              wants = [ "postgresql.service" ];

              environment = {
                HOST = cfg.host;
                PORT = toString cfg.port;
                ORIGIN = cfg.origin;
                DATABASE_URL = cfg.databaseUrl;
                # adapter-node defaults to 512K; klym accepts GPX up to 15 MB.
                BODY_SIZE_LIMIT = "16M";
                NODE_ENV = "production";
              };

              serviceConfig = {
                EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
                ExecStart = "${pkgs.nodejs_24}/bin/node ${cfg.package}/lib/klym/build/index.js";
                WorkingDirectory = "${cfg.package}/lib/klym";
                Restart = "on-failure";

                # Cap the cgroup so a burst of large GPX parses can't take the
                # box down. On hitting MemoryMax the kernel OOM-kills the service;
                # OOMPolicy kills the whole cgroup and Restart=on-failure brings
                # it back — data survives in postgres. If it OOMs repeatedly,
                # systemd's default start-rate limit trips and leaves it stopped
                # until you intervene, rather than thrashing.
                MemoryHigh = cfg.memoryHigh;
                MemoryMax = cfg.memoryMax;
                OOMPolicy = "kill";
                # CPU ceiling so a burst of GPX parses can't starve co-tenants.
                CPUQuota = cfg.cpuQuota;
                # DynamicUser is load-bearing, not just hardening: it creates a
                # transient system user literally named "klym", and peer auth over
                # the unix socket maps that name onto the "klym" postgres role.
                # That is the whole authentication story — don't swap it for a
                # static User= without also giving the role a password.
                # The process still writes nothing to disk, so it stays locked
                # down; anything that ever needs scratch space wants
                # StateDirectory, not an ad-hoc path.
                DynamicUser = true;
                ProtectSystem = "strict";
                ProtectHome = true;
                PrivateTmp = true;
                NoNewPrivileges = true;
              };
            };
          };
        };

      # For the Connect IQ toolchain in garmin/: monkeyc needs a JDK, and the
      # SDK itself is a manual SDK Manager install whose bin dir gets pulled
      # onto PATH from the manager's current-sdk.cfg pointer. gpsbabel covers
      # GPX→FIT conversion for simulator activity playback.
      devShells = forDevSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm
              pkgs.jdk21
              pkgs.gpsbabel
            ];
            shellHook = ''
              ciq_cfg="$HOME/Library/Application Support/Garmin/ConnectIQ/current-sdk.cfg"
              if [ -f "$ciq_cfg" ]; then
                export PATH="$(cat "$ciq_cfg")/bin:$PATH"
              fi
            '';
          };
        }
      );
    };
}
