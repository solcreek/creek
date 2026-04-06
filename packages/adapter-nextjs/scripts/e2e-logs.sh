#!/usr/bin/env bash
# Next.js adapter test suite — logs script
# Contract: prints BUILD_ID, DEPLOYMENT_ID, IMMUTABLE_ASSET_TOKEN lines.
set -euo pipefail

if [ -f ".adapter-build.log" ]; then
  cat ".adapter-build.log"
fi
