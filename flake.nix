{
  description = "Pinned ChatGPT Markdown collector and chatgpt-exporter";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forSystem = system:
        let pkgs = import nixpkgs { inherit system; };
        node = pkgs.nodejs_22;
        upstream = pkgs.buildNpmPackage {
          pname = "chatgpt-exporter";
          version = "1.1.0";
          nodejs = node;
          src = pkgs.fetchFromGitHub {
            owner = "FdezRomero";
            repo = "chatgpt-exporter";
            rev = "c0185e8937b7e3d19a5f1f34aab5d49fa8d1aa7e";
            hash = "sha256-BxoW37993RR82QytbppRMtqwQoGh4TG0IP9tCMAPmE4=";
          };
          npmDepsHash = "sha256-HwulGbVyavEmITcZl4FMChMmJSzRuny306q311XSoBU=";
          npmBuildScript = "build";
          nativeBuildInputs = [ node pkgs.makeWrapper ];
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/chatgpt-exporter $out/bin
            cp -r dist package.json node_modules $out/lib/chatgpt-exporter/
            makeWrapper ${node}/bin/node $out/bin/chatgpt-exporter \
              --add-flags "$out/lib/chatgpt-exporter/dist/index.js"
            runHook postInstall
          '';
        };
        collector = pkgs.buildNpmPackage {
          pname = "chatgpt-markdown-collector";
          version = "0.1.0";
          nodejs = node;
          src = ./.;
          npmDepsHash = "sha256-ZBZ7jrXV48WGzJJ6allQXBjjhwEjVAl2cKsSPMPuOdg=";
          nativeBuildInputs = [ node pkgs.makeWrapper ];
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/chatgpt-markdown-collector $out/bin
            cp -r src package.json node_modules $out/lib/chatgpt-markdown-collector/
            makeWrapper ${node}/bin/node $out/bin/chatgpt-markdown-collector \
              --prefix PATH : ${upstream}/bin \
              --add-flags "$out/lib/chatgpt-markdown-collector/src/cli.js"
            runHook postInstall
          '';
        };
         runtime = pkgs.symlinkJoin {
           name = "chatgpt-markdown-collector-runtime";
           paths = [ collector upstream ];
           meta.mainProgram = "chatgpt-markdown-collector";
         };
      in {
        packages = {
          default = runtime;
          collector = collector;
          upstream = upstream;
          oci = pkgs.dockerTools.buildLayeredImage {
            name = "chatgpt-markdown-collector";
            tag = "latest";
            contents = [ runtime pkgs.cacert ];
            config = {
              Entrypoint = [ "${runtime}/bin/chatgpt-markdown-collector" ];
              WorkingDir = "/data";
              Env = [ "PATH=${runtime}/bin" "NODE_PATH=${runtime}/lib/node_modules" ];
              Volumes = { "/data" = {}; "/state" = {}; };
            };
          };
        };
        devShells.default = pkgs.mkShell { packages = [ node pkgs.nixfmt ]; };
        checks = {
          syntax = pkgs.runCommand "collector-syntax" { nativeBuildInputs = [ node ]; } ''
            node --check ${./src/collector.js}
            node --check ${./src/cli.js}
            touch $out
          '';
          tests = pkgs.runCommand "collector-tests" { nativeBuildInputs = [ node ]; } ''
             export HOME=$TMPDIR/home; mkdir -p "$HOME"
             work=$(mktemp -d); cp -r ${./.} "$work/source"; chmod -R u+w "$work/source"; cd "$work/source"
             cp -r ${collector}/lib/chatgpt-markdown-collector/node_modules "$work/source/node_modules"
             ${node}/bin/node --test
            touch $out
          '';
        };
      };
    in {
      packages = nixpkgs.lib.genAttrs systems (system: (forSystem system).packages);
      devShells = nixpkgs.lib.genAttrs systems (system: (forSystem system).devShells);
      checks = nixpkgs.lib.genAttrs systems (system: (forSystem system).checks);
    };
}
