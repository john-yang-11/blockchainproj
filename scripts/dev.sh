#!/usr/bin/env bash
# One command for local dev: starts anvil, deploys, seeds, runs the frontend.
# Ctrl+C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PATH:$HOME/.foundry/bin"

anvil --silent &
anvil_pid=$!
trap 'kill $anvil_pid 2>/dev/null' EXIT

echo "Waiting for anvil..."
until cast block-number >/dev/null 2>&1; do sleep 0.5; done

./scripts/deploy.sh local
# Demo art takes about a minute to paint; SEED=0 skips it.
[ "${SEED:-1}" = 0 ] || ./scripts/seed.sh

cd web
[ -d node_modules ] || npm install
npm run dev -- --open
