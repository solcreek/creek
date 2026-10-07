# The CI gate (.github/workflows/test.yml), runnable anywhere the flake is:
#
#   nix run .#verify                 # every step, in CI order
#   nix run .#verify -- test         # only the named steps (rerun what failed)
#
# Stops at the first failing step and names it on the last line of output, so an
# agent can read one line to know what broke and which step to rerun.
# Keep the steps in sync with .github/workflows/test.yml.

publishable=(
  --filter @solcreek/sdk
  --filter @solcreek/cli
  --filter @solcreek/runtime
  --filter create-creek-app
)

step_install() { pnpm install --frozen-lockfile; }
step_format() { pnpm format:check; }
step_build() { pnpm "${publishable[@]}" --filter @solcreek/build-container build; }
step_test() { pnpm test; }
step_typecheck() { pnpm "${publishable[@]}" typecheck; }

all_steps=(install format build test typecheck)

if [ "$#" -gt 0 ]; then
  steps=("$@")
else
  steps=("${all_steps[@]}")
fi

for s in "${steps[@]}"; do
  if ! declare -F "step_$s" >/dev/null; then
    echo "verify: unknown step \"$s\" (steps: ${all_steps[*]})" >&2
    exit 2
  fi
done

cd "$(git rev-parse --show-toplevel)"

i=0
for s in "${steps[@]}"; do
  i=$((i + 1))
  echo "==> verify [$i/${#steps[@]}] $s"
  start=$SECONDS
  set +e
  "step_$s"
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    echo "verify: FAILED step=$s exit=$code (rerun: nix run .#verify -- $s)" >&2
    exit "$code"
  fi
  echo "==> verify [$i/${#steps[@]}] $s ok ($((SECONDS - start))s)"
done

echo "verify: OK steps=${steps[*]}"
