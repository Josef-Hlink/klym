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

            nativeBuildInputs = [
              pkgs.nodejs_24
              pkgs.pnpm_10.configHook
            ];

            # Reproducible offline pnpm store. The hash pins the resolved
            # dependency tree; it MUST be refreshed whenever pnpm-lock.yaml
            # changes — set it to `pkgs.lib.fakeHash`, build, and paste back
            # the "got: sha256-…" value Nix prints.
            #
            # Deliberately the version-pinned pnpm_10 API + fetcherVersion 1.
            # The top-level fetchPnpmDeps/pnpmConfigHook + fetcherVersion 3 path
            # breaks on nixpkgs' default pnpm 11: the config hook can't find
            # .fetcher-version, falls back to v1, and pnpm 11 then can't read the
            # v1 store (ERR_PNPM_NO_OFFLINE_TARBALL). pnpm_10.configHook bundles
            # its own pnpm so fetch and install stay consistent. Revisit once
            # that path stabilises; the deprecation warnings are harmless until
            # the 26.11 release.
            pnpmDeps = pkgs.pnpm_10.fetchDeps {
              inherit (finalAttrs) pname version src;
              fetcherVersion = 1;
              hash = "sha256-ygnt9xDR18wes2f92XSG6B/9QQCZgdTTzemFE3U3qlE=";
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
                Hard memory ceiling (systemd MemoryMax). klym's in-memory store
                has no byte cap — the storage limits bound counts, not bytes, and
                a parsed 15 MB GPX is a chunk of memory per route — so a flood of
                large uploads could otherwise grow unbounded. At this ceiling the
                kernel OOM-kills klym and Restart=on-failure brings it back with a
                fresh (empty) store. Raise it if you raise the storage caps in
                src/lib/server/storage.ts; set "infinity" to disable.
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
              after = [ "network.target" ];

              environment = {
                HOST = cfg.host;
                PORT = toString cfg.port;
                ORIGIN = cfg.origin;
                # adapter-node defaults to 512K; klym accepts GPX up to 15 MB.
                BODY_SIZE_LIMIT = "16M";
                NODE_ENV = "production";
              };

              serviceConfig = {
                EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
                ExecStart = "${pkgs.nodejs_24}/bin/node ${cfg.package}/lib/klym/build/index.js";
                WorkingDirectory = "${cfg.package}/lib/klym";
                Restart = "on-failure";

                # Cap the cgroup so the in-memory store can't take the box down.
                # On hitting MemoryMax the kernel OOM-kills the service; OOMPolicy
                # kills the whole cgroup and Restart=on-failure brings it back
                # with an empty store (the store is ephemeral by design anyway).
                # If it OOMs repeatedly, systemd's default start-rate limit trips
                # and leaves it stopped — i.e. the system shuts it down for good
                # until you intervene, rather than thrashing.
                MemoryHigh = cfg.memoryHigh;
                MemoryMax = cfg.memoryMax;
                OOMPolicy = "kill";
                # CPU ceiling so a burst of GPX parses can't starve co-tenants.
                CPUQuota = cfg.cpuQuota;
                # Storage is in-memory, so the service is stateless and needs no
                # writable paths — run it locked down under a throwaway user.
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
