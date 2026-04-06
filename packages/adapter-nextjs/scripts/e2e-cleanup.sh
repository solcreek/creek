#!/usr/bin/env bash
# Next.js adapter test suite — cleanup script
# Contract: tears down the deployment after tests complete.
# Creek sandbox deploys auto-expire after 60 min, so cleanup is optional.
set -euo pipefail

# Read deployment ID from build log
if [ -f ".adapter-build.log" ]; then
  DEPLOYMENT_ID=$(grep "^DEPLOYMENT_ID:" .adapter-build.log | cut -d' ' -f2)
  if [ -n "${DEPLOYMENT_ID}" ] && [ "${DEPLOYMENT_ID}" != "unknown" ]; then
    # Attempt to delete sandbox (best effort)
    curl -s -X DELETE "https://sandbox-api.creek.dev/api/sandbox/${DEPLOYMENT_ID}" > /dev/null 2>&1 || true
  fi
fi

echo "Cleanup complete"
