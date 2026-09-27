#!/usr/bin/env bash
#
# setup-github-pages-environment.sh — configure the GitHub Pages environment
# deployment policy so `v*` release tags can deploy.
#
# Background
# ----------
# `.github/workflows/deploy-pages.yml` triggers only on pushes of tags
# matching `v*`. The `deploy` job targets the `github-pages` environment,
# which has a custom deployment branch policy. If that policy allows only
# the `dev` branch (the default state of this repository), every release
# tag is rejected by environment protection *before any deploy step runs*.
# The resulting failed check run lands on the release-branch HEAD and blocks
# the automatic merge in the ship release flow.
#
# This script adds a `tag:v*` deployment policy alongside the existing
# `branch:dev` policy. It is idempotent: running it a second time makes no
# change and exits 0. It never deletes or rewrites existing policies.
#
# Requirements
# ------------
# - `gh` (GitHub CLI) on PATH.
# - An authenticated `gh` session whose token has repository admin rights,
#   because the environment deployment-policies API requires admin.
#
# Usage
# -----
#   scripts/setup-github-pages-environment.sh [--repo <owner/name>]
#
#   --repo <owner/name>   Repository to configure. Defaults to the repository
#                         of the current clone (via `gh repo view`).
#   -h, --help            Show this help and exit 0.
#
# Manual fallback (when `gh` lacks admin rights)
# ----------------------------------------------
# An operator with repository admin can apply the policy in the GitHub UI, or
# by running:
#
#   gh api --method POST \
#     -H "Accept: application/vnd.github+json" \
#     repos/<owner>/<name>/environments/github-pages/deployment-branch-policies \
#     -f name='v*' -f type='tag'
#
# Verify the result with:
#
#   gh api repos/<owner>/<name>/environments/github-pages/deployment-branch-policies \
#     --jq '.branch_policies[] | "\(.type):\(.name)"'
#
# It must print both `branch:dev` and `tag:v*`.
#
set -euo pipefail

readonly ENVIRONMENT="github-pages"
readonly TAG_POLICY_NAME="v*"
readonly TAG_POLICY_TYPE="tag"

REPO=""

usage() {
  cat <<'EOF'
Configure the GitHub Pages environment deployment policy for `v*` release tags.

Adds a `tag:v*` deployment policy to the `github-pages` environment, alongside
the existing `branch:dev` policy, so release tags are not rejected by
environment protection. The script is idempotent and never removes or rewrites
existing policies.

Usage:
  setup-github-pages-environment.sh [--repo <owner/name>]

Options:
  --repo <owner/name>   Repository to configure (default: the repository of the
                        current clone, resolved via `gh repo view`).
  -h, --help            Show this help and exit 0.

Requirements:
  gh (GitHub CLI) on PATH, authenticated with repository admin rights.

Manual fallback (no admin rights):
  gh api --method POST \
    -H "Accept: application/vnd.github+json" \
    repos/<owner>/<name>/environments/github-pages/deployment-branch-policies \
    -f name='v*' -f type='tag'
EOF
}

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

# Parse arguments -----------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$#" -ge 2 ] || fail "--repo requires an <owner/name> argument"
      REPO="$2"
      shift 2
      ;;
    --repo=*)
      REPO="${1#--repo=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1 (run with --help for usage)"
      ;;
  esac
done

# Preflight: gh present and authenticated -----------------------------------
if ! command -v gh >/dev/null 2>&1; then
  fail "'gh' (GitHub CLI) is not installed or not on PATH. Install it from https://cli.github.com/ and re-run."
fi

if ! gh auth status >/dev/null 2>&1; then
  fail "'gh' is not authenticated. Run 'gh auth login' with a token that has repository admin rights, then re-run."
fi

# Resolve the repository ----------------------------------------------------
if [ -z "$REPO" ]; then
  if ! REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)"; then
    fail "Could not determine the repository of the current clone. Re-run with --repo <owner/name>."
  fi
fi
[ -n "$REPO" ] || fail "Could not determine the repository. Re-run with --repo <owner/name>."

readonly POLICIES_ENDPOINT="repos/${REPO}/environments/${ENVIRONMENT}/deployment-branch-policies"

# Print the matching `type:name` for the tag policy, or nothing if absent.
find_tag_policy() {
  gh api \
    -H 'Accept: application/vnd.github+json' \
    "$POLICIES_ENDPOINT" \
    --jq ".branch_policies[] | select(.type == \"$TAG_POLICY_TYPE\" and .name == \"$TAG_POLICY_NAME\") | \"\\(.type):\\(.name)\""
}

# Read the current policies -------------------------------------------------
if ! existing="$(find_tag_policy)"; then
  fail "Failed to read the '${ENVIRONMENT}' deployment policies for '${REPO}'. Ensure the environment exists and your token has repository admin rights."
fi

if [ -n "$existing" ]; then
  log "✅ ${ENVIRONMENT} already allows ${TAG_POLICY_TYPE}:${TAG_POLICY_NAME} — no change made."
  exit 0
fi

# Add the tag policy --------------------------------------------------------
if ! gh api \
  --method POST \
  -H 'Accept: application/vnd.github+json' \
  "$POLICIES_ENDPOINT" \
  -f "name=${TAG_POLICY_NAME}" \
  -f "type=${TAG_POLICY_TYPE}" >/dev/null; then
  fail "Failed to add the ${TAG_POLICY_TYPE}:${TAG_POLICY_NAME} deployment policy to '${ENVIRONMENT}' for '${REPO}'. Ensure your token has repository admin rights (see the manual fallback in --help)."
fi

# Verify the policy is now present ------------------------------------------
if ! verified="$(find_tag_policy)"; then
  fail "Added ${TAG_POLICY_TYPE}:${TAG_POLICY_NAME} but the verification request failed. Inspect the environment policies for '${REPO}'."
fi

if [ -z "$verified" ]; then
  fail "Added ${TAG_POLICY_TYPE}:${TAG_POLICY_NAME} but it was not present on re-read. The '${ENVIRONMENT}' environment may reject wildcard tag policies; inspect the policies for '${REPO}'."
fi

log "✅ Added ${verified} deployment policy to ${ENVIRONMENT} for ${REPO} (kept existing ${ENVIRONMENT} policies)."
