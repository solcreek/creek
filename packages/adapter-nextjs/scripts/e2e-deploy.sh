#!/usr/bin/env bash
# Next.js adapter test suite — deploy script
# Contract: builds and deploys the test app, prints URL to stdout.
# All diagnostic output goes to stderr.
set -euo pipefail

# The adapter is in ADAPTER_DIR, the test app is in the current directory.
ADAPTER_PATH="${ADAPTER_DIR}/dist/index.js"

# Install the adapter into the test app
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['@solcreek/adapter-nextjs'] = 'file:${ADAPTER_DIR}';
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
" >&2

# Install dependencies
npm install --no-audit --no-fund >&2 2>&1

# Set adapter path
export NEXT_ADAPTER_PATH="${ADAPTER_PATH}"

# Build with webpack (Turbopack doesn't support standalone which the adapter needs)
npx next build --webpack >&2 2>&1

# Deploy to Creek sandbox (no auth needed, 60 min TTL, auto-cleanup)
# Use --json for structured output, --yes to skip prompts
RESULT=$(npx creek deploy .creek/adapter-output --json --yes 2>/dev/null)

# Extract and save metadata for logs script
BUILD_ID=$(cat .next/BUILD_ID 2>/dev/null || echo "unknown")
DEPLOYMENT_ID=$(echo "$RESULT" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{try{console.log(JSON.parse(d).sandboxId||'unknown')}catch{console.log('unknown')}})")
URL=$(echo "$RESULT" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{try{console.log(JSON.parse(d).url||'')}catch{console.log('')}})")

{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${DEPLOYMENT_ID}"
  echo "IMMUTABLE_ASSET_TOKEN: undefined"
} > .adapter-build.log

# Print only the deployment URL to stdout (test harness reads this)
echo "${URL}"
