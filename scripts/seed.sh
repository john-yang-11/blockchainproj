#!/usr/bin/env bash
# Paint demo art on a LOCAL anvil deployment (see scripts/seed.mjs).
#   ./scripts/seed.sh
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/seed.mjs
