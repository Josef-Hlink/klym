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
      forAllSystems = nixpkgs.lib.genAttrs systems;
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
              hash = "sha256-tJtw38IvhwoEUWBTVPbQIs0VGdG7sihjYhU9Oa4jyl0=";
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
                ExecStart = "${pkgs.nodejs_24}/bin/node ${cfg.package}/lib/klym/build/index.js";
                WorkingDirectory = "${cfg.package}/lib/klym";
                Restart = "on-failure";
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
    };
}
