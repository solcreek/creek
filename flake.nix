{
  description = "creek monorepo: pinned dev toolchain and the CI verify gate";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          toolchain = import ./nix/toolchain.nix { inherit pkgs; };
        in
        {
          default = pkgs.mkShell {
            packages = toolchain.packages;
            env = toolchain.env;
          };
        }
      );

      packages = forAllSystems (
        pkgs:
        let
          toolchain = import ./nix/toolchain.nix { inherit pkgs; };
        in
        {
          verify = pkgs.writeShellApplication {
            name = "verify";
            runtimeInputs = toolchain.packages;
            runtimeEnv = toolchain.env;
            text = builtins.readFile ./nix/verify.sh;
          };
        }
      );

      apps = forAllSystems (pkgs: {
        verify = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.verify}/bin/verify";
          meta.description = "Run the CI gate: install, format, build, test, typecheck";
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
