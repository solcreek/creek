#!/usr/bin/env bash
set -euo pipefail

# Creek www deploy script
#
# Usage: ./scripts/deploy.sh
#
# This script builds and deploys creek.dev THROUGH the Creek platform
# (dogfooding). creek.dev's apex is a CNAME to cname.bycreek.com (CF for
# SaaS), which routes via the dispatch-worker to the www project's
# tenant script. `creek deploy --yes` uploads the bundled OpenNextJS
# worker to that tenant script — so dogfooding is already partially
# real, even before adapter-creek is complete.
#
# IMPORTANT: Do NOT replace the final step with a direct `wrangler
# deploy`. The `creek-www` Worker (apps/www/wrangler.jsonc) exists but
# is NOT what creek.dev serves — it's only reachable via
# creek-www.kaik.workers.dev. Pushing there with wrangler leaves
# production untouched.
#
# TODO: When adapter-creek is complete, the OpenNextJS + symlink +
# middleware-manifest patches can go away:
#   1. Remove OpenNextJS dependency entirely
#   2. Remove middleware-manifest patch
#   3. Remove standalone symlink hack
#   4. The final step is already `creek deploy --yes` — keep it
#   5. Delete the legacy creek-www Worker and its wrangler.jsonc
#   6. Delete this script — `creek deploy` should be all that's needed

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONOREPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

cd "$APP_DIR"

echo "⬡ Creek www deploy"
echo "  app:      $APP_DIR"
echo "  monorepo: $MONOREPO_ROOT"
echo ""

# Step 1: Clean
echo "→ Cleaning previous build..."
rm -rf .next .open-next

# Step 2: Next.js build (standalone mode for OpenNextJS)
echo "→ Building Next.js (standalone)..."
NEXT_PRIVATE_STANDALONE=true \
NEXT_PRIVATE_OUTPUT_TRACE_ROOT="$MONOREPO_ROOT" \
  npx next build

# Step 3: Fix monorepo standalone path (symlink)
echo "→ Fixing monorepo standalone path..."
ln -sf apps/www/.next .next/standalone/.next

# Step 4: OpenNextJS build (skips next build via patched buildNextApp)
echo "→ Running OpenNextJS build..."
npx opennextjs-cloudflare build

# Step 5: Patch middleware-manifest (Next.js 16 dynamic require → inline JSON)
echo "→ Patching middleware-manifest..."
python3 -c "
with open('.open-next/server-functions/default/handler.mjs', 'r') as f:
    content = f.read()
import re
pattern = r'getMiddlewareManifest\(\)\s*\{[^}]*require\(this\.middlewareManifestPath\)[^}]*\}'
m = re.search(pattern, content)
if m:
    manifest = open('.open-next/server-functions/default/.next/server/middleware-manifest.json').read().strip()
    replacement = f'getMiddlewareManifest(){{return this.minimalMode?null:{manifest}}}'
    content = content.replace(m.group(), replacement)
    with open('.open-next/server-functions/default/handler.mjs', 'w') as f:
        f.write(content)
    print('  ✓ Patched: inline middleware-manifest')
else:
    print('  ⚠ Pattern not found (already patched or Next.js version changed)')
"

# Step 6: Deploy via Creek CLI (dogfooding)
# creek.dev routes via CF for SaaS → dispatch-worker → www tenant
# script. The creek CLI uploads the OpenNextJS bundle to that tenant
# script, which IS what serves creek.dev.
echo "→ Deploying via Creek..."
node "$MONOREPO_ROOT/packages/cli/dist/index.js" deploy --yes

echo ""
echo "⬡ Deploy complete. Verify: https://creek.dev"
