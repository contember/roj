#!/bin/bash
#
# Publish all public @roj-ai/* packages to npm. Run from CI after
# prepare-packages.mjs has rewritten versions and workspace:* refs.
#
# Requires NPM_TAG env (defaults to "latest"). Uses --provenance, so the
# workflow must have `id-token: write` and a configured npm trusted publisher.
#
set -euo pipefail

NPM_TAG="${NPM_TAG:-latest}"

for dir in packages/*; do
  [ -f "$dir/package.json" ] || continue
  if grep -q '"private": true' "$dir/package.json"; then
    continue
  fi
  pkg_name="$(node -p "require('./$dir/package.json').name")"
  echo ""
  echo "→ Publishing $pkg_name (tag: $NPM_TAG)"
  tarball="$(cd "$dir" && bun pm pack 2>&1 | grep -Eo '[^[:space:]]+\.tgz' | tail -n1)"
  if [ -z "$tarball" ]; then
    echo "Failed to pack $pkg_name" >&2
    exit 1
  fi
  (cd "$dir" && npm publish "$tarball" --tag "$NPM_TAG" --access public --provenance)
  rm -f "$dir/$tarball"
done
