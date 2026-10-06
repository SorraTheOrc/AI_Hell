#!/usr/bin/env bash
#
# Deterministic WAV build pipeline (AH-0MUTYV8FU007X7JD).
#
# Thin wrapper around `scripts/build-audio.mjs` so the pipeline can be
# invoked as the documented `scripts/build-audio.sh`. All arguments are
# forwarded (see `--help`). The wrapper resolves the script directory so
# it works from any working directory.
#
#   scripts/build-audio.sh            # render if ToneForge is available, else verify
#   scripts/build-audio.sh --render   # force render
#   scripts/build-audio.sh --verify   # verify committed assets only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/build-audio.mjs" "$@"
