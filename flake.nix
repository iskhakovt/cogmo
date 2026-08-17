{
  description = "Cogmo development shell";

  # nixpkgs alone — the shell needs one package set and a couple of env vars,
  # which is less code inline than an extra input costs to fetch and pin.
  #
  # Pinned to a revision rather than a branch name: resolving `nixos-unstable`
  # costs a call to api.github.com on every fetch, and `flake.lock` pins the
  # revision regardless, so the branch buys nothing but a failure mode. Bump it
  # with `nix flake update`.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/b51242d7d43689db2f3be91bd05d5b24fbb469c4";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          # Playwright downloads a prebuilt `chrome-headless-shell` that expects
          # a conventional FHS layout, so on NixOS it starts and dies on the
          # first missing `.so`. These are the libraries it links, plus the ones
          # Chromium reaches for with `dlopen` at runtime and which therefore
          # never show up in `ldd` output. Supplying libraries keeps Playwright's
          # own browser download in play, so the revision it wants stays
          # decoupled from whichever `playwright-driver` nixpkgs happens to
          # carry — a mismatch there surfaces as "Executable doesn't exist".
          browserLibs = with pkgs; [
            alsa-lib
            at-spi2-atk
            at-spi2-core
            atk
            cairo
            cups
            dbus
            expat
            fontconfig
            freetype
            glib
            libdrm
            libGL
            libgbm
            libxkbcommon
            nspr
            nss
            pango
            systemd
            xorg.libX11
            xorg.libXcomposite
            xorg.libXdamage
            xorg.libXext
            xorg.libXfixes
            xorg.libXrandr
            xorg.libxcb
          ];

          libraryPath = pkgs.lib.makeLibraryPath browserLibs;
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              # Corepack activates the `packageManager` pin in package.json, so
              # the pnpm version comes from the repo, not from nixpkgs.
              corepack
              git
              docker-client
            ];

            # Two variables for two consumers: `LD_LIBRARY_PATH` covers anything
            # launched from this shell directly, while `NIX_LD_LIBRARY_PATH` is
            # what nix-ld hands to a binary that was never patchelf'd — the path
            # `chrome-headless-shell` actually takes.
            LD_LIBRARY_PATH = libraryPath;
            NIX_LD_LIBRARY_PATH = libraryPath;
            NIX_LD = pkgs.lib.fileContents "${pkgs.stdenv.cc}/nix-support/dynamic-linker";

            shellHook = ''
              echo "cogmo dev shell — node $(node --version)"
              echo "browser libs on NIX_LD_LIBRARY_PATH; 'pnpm --filter web test' can drive Chromium here."
            '';
          };
        }
      );
    };
}
