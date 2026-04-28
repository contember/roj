#!/bin/bash
#
# One-time bootstrap: publish initial versions of all public @roj-ai/* packages
# from the local machine, then guide the user through configuring npm Trusted
# Publishers so subsequent releases run from CI on tag push (v*).
#
# Usage: scripts/npm-publish/init.sh <version>
#   e.g. scripts/npm-publish/init.sh 0.1.0
#
set -euo pipefail

VERSION_ARG="${1:-}"
if [ -z "$VERSION_ARG" ]; then
  echo "Usage: $0 <version>" >&2
  echo "Example: $0 0.1.0" >&2
  exit 1
fi

VERSION="${VERSION_ARG#v}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$ ]]; then
  echo "Invalid version: $VERSION_ARG" >&2
  echo "Expected semver, e.g. 0.1.0 or 0.1.0-alpha.1" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

if ! command -v npm > /dev/null; then
  echo "npm not found in PATH" >&2
  exit 1
fi
if ! command -v bun > /dev/null; then
  echo "bun not found in PATH" >&2
  exit 1
fi

if ! NPM_USER="$(npm whoami 2>/dev/null)"; then
  echo "Not logged in to npm. Run: npm login" >&2
  exit 1
fi
echo "→ Publishing as npm user: $NPM_USER"

echo "→ Snapshotting current packages/*/package.json…"
SNAPSHOT_DIR="$(mktemp -d)"
for f in packages/*/package.json; do
  rel="${f#packages/}"
  mkdir -p "$SNAPSHOT_DIR/$(dirname "$rel")"
  cp "$f" "$SNAPSHOT_DIR/$rel"
done

# Restore package.json files on exit so workspace:* stays workspace:* for local dev.
# Uses an in-memory snapshot — preserves uncommitted edits the user had before running.
restore() {
  echo "→ Restoring package.json files from snapshot…"
  for f in "$SNAPSHOT_DIR"/*/package.json; do
    rel="${f#$SNAPSHOT_DIR/}"
    cp "$f" "packages/$rel"
  done
  rm -rf "$SNAPSHOT_DIR"
}
trap restore EXIT

echo "→ Building TypeScript declarations…"
bun run ts:build

echo "→ Rewriting package manifests for $VERSION…"
node ./scripts/npm-publish/prepare-packages.mjs "$VERSION"

PUBLIC_PACKAGES=()
for dir in packages/*; do
  [ -f "$dir/package.json" ] || continue
  if grep -q '"private": true' "$dir/package.json"; then
    continue
  fi
  pkg_name="$(node -p "require('./$dir/package.json').name")"
  PUBLIC_PACKAGES+=("$pkg_name")

  echo ""
  echo "→ Publishing $pkg_name@$VERSION"
  tarball="$(cd "$dir" && bun pm pack 2>&1 | grep -Eo '[^[:space:]]+\.tgz' | tail -n1)"
  if [ -z "$tarball" ]; then
    echo "Failed to pack $pkg_name" >&2
    exit 1
  fi
  (cd "$dir" && npm publish "$tarball" --access public)
  rm -f "$dir/$tarball"
done

cat <<EOF

============================================================
✓ Initial publish complete — version $VERSION
============================================================

Next: configure GitHub Actions trusted publishers on npmjs.com
so CI can publish without an NPM_TOKEN.

For each package below, open the URL → "Trusted Publisher" →
add a new publisher with:
  Publisher:        GitHub Actions
  Organization:     contember
  Repository:       roj
  Workflow name:    publish.yml
  Environment:      (leave empty)

EOF

for pkg in "${PUBLIC_PACKAGES[@]}"; do
  encoded="${pkg//@/%40}"
  encoded="${encoded//\//%2F}"
  echo "  $pkg"
  echo "    https://www.npmjs.com/package/$encoded/access"
done

cat <<EOF

Once trust is configured, tag a release locally and push:

  git tag v$VERSION
  git push origin v$VERSION

The publish.yml workflow will pick up the tag and publish via OIDC.
EOF
