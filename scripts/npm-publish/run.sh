#!/bin/bash
#
# Publish the exact public @roj-ai/* tarballs previously packed and validated by
# pack-and-validate.mjs. Run from CI after prepare-packages.mjs.
#
# Requires NPM_TAG env (defaults to "latest"). Uses --provenance, so the
# workflow must have `id-token: write` and a configured npm trusted publisher.
#
set -euo pipefail

: "${PACKAGE_TARBALL_MANIFEST:?pack-and-validate.mjs did not provide PACKAGE_TARBALL_MANIFEST}"
RELEASE_COMMIT="${ROJ_RELEASE_COMMIT:-${GITHUB_SHA:-HEAD}}"
RELEASE_REF="${ROJ_RELEASE_REF:-origin/main}"
node ./scripts/npm-publish/check-release-ancestry.mjs "$RELEASE_COMMIT" "$RELEASE_REF"
exec node ./scripts/npm-publish/publish-packed.mjs "$PACKAGE_TARBALL_MANIFEST"
