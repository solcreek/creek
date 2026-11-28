#!/usr/bin/env bash
# List the code ProductionServing.tla models that changed since the commit at
# which the model was last confirmed to describe it (SYNC_COMMIT below), in
# commits and in the working tree. Exit 0: nothing covered changed. Exit 1: the
# listed files changed; reread them against the model before trusting run.sh.
set -euo pipefail

# Move this forward only after confirming the model describes the code at the new commit.
SYNC_COMMIT="8d8adc8c707c3d05abdcb826fd3bab9a5fc08297"

# Every file an action or comment in ProductionServing.tla points to.
COVERED=(
  packages/dispatch-worker/src/index.ts                          # resolveRoute: production serves the pointer's immutable script
  packages/control-plane/src/modules/deployments/deploy.ts       # deployWithAssets: immutable, then production script
  packages/deploy-core/src/deploy.ts                             # deployScriptWithAssets: one script upload
  packages/control-plane/src/modules/deployments/deploy-job.ts   # runDeployJob: activate batch, manifest, failDeployment
  packages/control-plane/src/modules/deployments/instant-deploy.ts  # same edge-then-batch order
  packages/control-plane/src/modules/deployments/routes.ts       # create row, PUT /bundle claim, promote, rollback
  packages/control-plane/src/index.ts                            # sweepStaleDeployments (the reaper)
)

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
changed="$( { git diff --name-only "$SYNC_COMMIT" HEAD -- "${COVERED[@]}"; git diff --name-only HEAD -- "${COVERED[@]}"; } | sort -u)"
if [ -z "$changed" ]; then
  echo "in sync: no covered file changed since ${SYNC_COMMIT:0:12}"
  exit 0
fi
echo "covered files changed since ${SYNC_COMMIT:0:12}:"
echo "$changed" | sed 's/^/  /'
exit 1
