#!/usr/bin/env bash
# Local Solana chain for development (run inside WSL / Linux):
# builds the program with the demo-only `localnet` feature, starts a fresh solana-test-validator,
# deploys, initializes the canvas and seeds demo art. Leaves the validator running; Ctrl+C stops it.
set -euo pipefail
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/place-target}" NO_DNA=1
source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true

[ -f "$HOME/.config/solana/id.json" ] || solana-keygen new --no-bip39-passphrase --silent -o "$HOME/.config/solana/id.json"

echo "Building program (localnet features)..."
anchor build -- --features localnet
mkdir -p web/src/idl && cp "$CARGO_TARGET_DIR/idl/place.json" web/src/idl/place.json

solana-test-validator --reset --quiet --ledger "$HOME/.cache/place-ledger" &
validator=$!
trap 'kill $validator 2>/dev/null' EXIT
echo "Waiting for validator..."
until solana cluster-version -u localhost >/dev/null 2>&1; do sleep 0.5; done

solana program deploy -u localhost "$CARGO_TARGET_DIR/deploy/place.so" \
  --program-id "$CARGO_TARGET_DIR/deploy/place-keypair.json"
SEED_FLAG=--seed
[ "${SEED:-1}" = 0 ] && SEED_FLAG=
node scripts/init-canvas.mjs --url http://127.0.0.1:8899 $SEED_FLAG

echo
echo "Local chain ready at http://127.0.0.1:8899  (Ctrl+C to stop)"
wait $validator
