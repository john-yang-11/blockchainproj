#!/usr/bin/env bash
# Deploy Place and point the frontend at it.
#   Local:   ./scripts/deploy.sh local          (needs `anvil` running)
#   Testnet: PRIVATE_KEY=0x... ./scripts/deploy.sh baseSepolia
# Optional env: WIDTH HEIGHT BASE_PRICE PRICE_INCREMENT COOLDOWN RPC_URL
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PATH:$HOME/.foundry/bin"

target="${1:-local}"
case "$target" in
  local)
    rpc="${RPC_URL:-http://127.0.0.1:8545}"
    # anvil's well-known account #0 — never use on a real network
    key="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
    chain=foundry ;;
  baseSepolia)
    rpc="${RPC_URL:-https://sepolia.base.org}"
    key="${PRIVATE_KEY:?set PRIVATE_KEY to a funded Base Sepolia key}"
    chain=baseSepolia ;;
  *) echo "usage: $0 [local|baseSepolia]"; exit 1 ;;
esac

out=$(cd contracts && forge script script/Deploy.s.sol --rpc-url "$rpc" --private-key "$key" --broadcast 2>&1) \
  || { echo "$out"; exit 1; }
addr=$(echo "$out" | grep -oE 'Place deployed at 0x[0-9a-fA-F]{40}' | awk '{print $4}')
chain_id=$(cast chain-id --rpc-url "$rpc")
block=$(node -e "const r=require('./contracts/broadcast/Deploy.s.sol/$chain_id/run-latest.json').receipts[0];console.log(parseInt(r.blockNumber))")

node scripts/export-abi.mjs
cat > web/.env.local <<ENV
VITE_CHAIN=$chain
VITE_CONTRACT_ADDRESS=$addr
VITE_DEPLOY_BLOCK=$block
VITE_RPC_URL=${RPC_URL:-}
ENV
echo "Deployed Place to $addr on $chain (block $block). web/.env.local updated."
