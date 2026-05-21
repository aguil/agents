#!/usr/bin/env bash
# Create a GitHub Release for an existing annotated tag (idempotent).
# Invoked from .github/workflows/release.yml after npm publish.
#
# Required env:
#   GITHUB_REPOSITORY  owner/repo
#   GH_TOKEN or GITHUB_TOKEN
# Optional:
#   TAG_NAME           defaults to GITHUB_REF_NAME

set -euo pipefail

TAG_NAME="${TAG_NAME:-${GITHUB_REF_NAME:-}}"
if [[ -z "${TAG_NAME}" ]]; then
  echo "TAG_NAME or GITHUB_REF_NAME is required" >&2
  exit 2
fi

if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
  echo "GITHUB_REPOSITORY is required" >&2
  exit 2
fi

if [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GH_TOKEN or GITHUB_TOKEN is required" >&2
  exit 2
fi

export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN}}"

if gh release view "${TAG_NAME}" --repo "${GITHUB_REPOSITORY}" >/dev/null 2>&1; then
  echo "GitHub Release ${TAG_NAME} already exists; skipping."
  exit 0
fi

VERSION="${TAG_NAME#v}"
COMMIT="$(git rev-parse "${TAG_NAME}^{commit}")"
NOTES_FILE="$(mktemp)"
trap 'rm -f "${NOTES_FILE}"' EXIT

git for-each-ref "refs/tags/${TAG_NAME}" --format='%(subject)%n%n%(body)' >"${NOTES_FILE}"

PREV="$(git describe --tags --abbrev=0 "${TAG_NAME}^" 2>/dev/null || true)"
if [[ -n "${PREV}" ]]; then
  {
    printf '\n\n---\n\n'
    gh api "repos/${GITHUB_REPOSITORY}/releases/generate-notes" \
      -f tag_name="${TAG_NAME}" \
      -f target_commitish="${COMMIT}" \
      -f previous_tag_name="${PREV}" \
      --jq '.body'
  } >>"${NOTES_FILE}" || true
fi

gh release create "${TAG_NAME}" \
  --repo "${GITHUB_REPOSITORY}" \
  --verify-tag \
  --title "@aguil/agents ${VERSION}" \
  --notes-file "${NOTES_FILE}"

echo "Created GitHub Release ${TAG_NAME}"
