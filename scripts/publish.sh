#!/usr/bin/env bash
set -euo pipefail

# Publish creek packages to npm with synchronized versions.
# Usage: ./scripts/publish.sh <version> <otp>
# Example: ./scripts/publish.sh 0.3.3 123456

VERSION="${1:?Usage: publish.sh <version> <otp>}"
OTP="${2:?Usage: publish.sh <version> <otp>}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Setting version $VERSION across facade + CLI..."
cd "$ROOT"
pnpm --filter creek exec npm version "$VERSION" --no-git-tag-version
pnpm --filter @solcreek/cli exec npm version "$VERSION" --no-git-tag-version

echo "==> Building..."
pnpm turbo build --filter=@solcreek/runtime --filter=@solcreek/cli --filter=@solcreek/sdk

echo "==> Publishing @solcreek/runtime..."
pnpm --filter @solcreek/runtime publish --access public --no-git-checks --otp "$OTP"

echo "==> Publishing @solcreek/sdk..."
pnpm --filter @solcreek/sdk publish --access public --no-git-checks --otp "$OTP"

echo "==> Publishing @solcreek/cli..."
pnpm --filter @solcreek/cli publish --access public --no-git-checks --otp "$OTP"

echo "==> Publishing creek (facade)..."
pnpm --filter creek publish --access public --no-git-checks --otp "$OTP"

echo "==> Done! Published creek@$VERSION"
echo "    Test: npx creek@$VERSION --help"
