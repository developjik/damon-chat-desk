#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
root="$(pwd)"
tools="${DOGFOOD_TOOLS:-$root/.dogfood-tools}"
mkdir -p "$tools"
checkout() {
  local repo="$1" rev="$2" dir="$tools/$1"
  if [ ! -d "$dir" ]; then git clone "https://github.com/developjik/$repo.git" "$dir"; fi
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then echo "Refusing dirty tool checkout: $dir" >&2; exit 1; fi
  git -C "$dir" checkout --detach "$rev"
  test "$(git -C "$dir" rev-parse HEAD)" = "$rev"
  (cd "$dir" && npm ci && npm run build)
}
checkout proofshot 1deedce053a36743d0c877943d38c499c8c62607
checkout agent-ui-guard c07bd3233e10f5d223ef8db29a3ccc265e559d3e
(cd "$tools/proofshot" && npx --no-install playwright install chromium)
(cd "$tools/agent-ui-guard" && npx --no-install playwright install chromium)
npm ci
VITE_BASE_PATH=/ npm run build
DOGFOOD_ROOT="$root" DOGFOOD_TOOLS="$tools" node examples/local-verification/run.mjs
