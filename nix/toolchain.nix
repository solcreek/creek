# The tools every creek environment needs: the host dev shell, `nix run .#verify`,
# and (later) the agent sandbox guest image all import this one list, so they
# cannot drift apart.
#
# npm dependencies are deliberately NOT managed by Nix — pnpm-lock.yaml already
# pins them. Nix pins only what the lockfile cannot: the runtimes and the system
# tools that native npm packages build against.
{ pkgs }:
{
  packages = with pkgs; [
    # Node 24 matches CI (.github/workflows/test.yml).
    nodejs_24
    # pnpm comes from corepack, which honours `packageManager` in package.json
    # (pnpm@10.6.5) exactly like CI's pnpm/action-setup does. nixpkgs' own
    # pnpm_10 is a different version and is marked insecure.
    corepack_24
    # packages/host-runtime and packages/creekd run on Bun.
    bun

    git
    # node-gyp toolchain for native deps that fall back to compiling
    # (better-sqlite3 is in pnpm-workspace.yaml's onlyBuiltDependencies).
    python3
    gnumake
    stdenv.cc
    pkg-config
  ];

  env = {
    # Never block a non-interactive shell (agents, CI) on corepack's
    # "download pnpm?" prompt.
    COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  };
}
