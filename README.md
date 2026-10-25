# OnChain Place

r/place on an Ethereum L2 (Base Sepolia). Pay to paint a pixel on a shared 1000×1000 canvas, the same size and 16-color palette as the original r/place (2017).

**Spec:** pay to place a pixel, with a live canvas frontend.
**Stretch goals, all done:**

| Goal | How |
|---|---|
| Price rises on overwrite | `price = basePrice + priceIncrement × timesPainted`, tracked per pixel on-chain |
| Cooldown per wallet | `cooldown` seconds between placements, enforced in the contract |
| Pixel history + leaderboard | `PixelPlaced` events (indexed by pixel and painter) give per-pixel history and an activity feed; the on-chain `players` mapping plus `getPlayers()` gives the leaderboard (pixels placed, ETH spent) |
| Efficient canvas storage | Colors packed **4 bits/pixel** (64 pixels per storage slot, so the 1M-pixel canvas is 15,625 slots, read in 8 parallel ranged `eth_call`s); overwrite counts packed 16 bits/pixel; cooldown, placed count, and spent share **one slot** per player |

`placePixel` costs ~140–170k gas (most of it is first-time zero→nonzero slot writes).

## Layout

```
contracts/   Foundry: src/Place.sol, test/Place.t.sol, script/Deploy.s.sol
web/         Vite + React + wagmi/viem frontend
scripts/     deploy.sh, seed.sh, export-abi.mjs
```

## Setup

Requires Node 20+ and [Foundry](https://getfoundry.sh) (`curl -L https://foundry.paradigm.xyz | bash && foundryup`; on Windows, run that in Git Bash).

```bash
git clone --recursive <repo>   # or: git submodule update --init
cd web && npm install && cd ..
```

## Run locally

**Shortcut:** double-click `dev.bat` (Windows) or run `./scripts/dev.sh`. That does everything below in one go. Ctrl+C stops it.

Or step by step:

```bash
anvil                                   # terminal 1: local chain
./scripts/deploy.sh local               # terminal 2: deploys and writes web/.env.local
./scripts/seed.sh                       # optional: paints ~130k pixels of demo art (about a minute)
cd web && npm run dev                   # open the printed URL
```

Locally there's an **"Anvil test account"** button, so you can paint without MetaMask (it uses anvil's unlocked dev accounts). You can also point MetaMask at `http://127.0.0.1:8545`, chain id 31337.

Tests: `cd contracts && forge test` (add `--gas-report` for gas numbers).

## Deploy to Base Sepolia

1. Get Base Sepolia ETH from a faucet (e.g. the Coinbase/Alchemy Base Sepolia faucets) for a **throwaway** deployer key.
2. `PRIVATE_KEY=0x... ./scripts/deploy.sh baseSepolia`
3. `cd web && npm run build` and host `web/dist` anywhere static (Vercel, Netlify, GitHub Pages), with the same `VITE_*` env vars set.

Tune the game with env vars at deploy time: `WIDTH HEIGHT BASE_PRICE PRICE_INCREMENT COOLDOWN` (wei / seconds). Defaults: 1000×1000 (max 4096 per side), 0.00001 ETH base, +0.000005 ETH per overwrite, 30s cooldown.

If the public RPC rate-limits history loading, set `VITE_RPC_URL` (Alchemy, QuickNode, etc.) and/or lower `VITE_LOG_CHUNK`.

## Contract API

| Function | Notes |
|---|---|
| `placePixel(x, y, color) payable` | color is a palette index from 0 to 15. Overpayment is refunded. Reverts `CooldownActive`, `InsufficientPayment`, `OutOfBounds`, `InvalidColor` |
| `getCanvas(from, count) → uint256[]` | packed colors, words `[from, from+count)` (clamped); pixel `i = y*width + x` is at bits `(i%64)*4` of word `i/64` |
| `getOverwrites(from, count) → uint256[]` | packed 16-bit paint counts, same ranging |
| `priceOf(x,y)`, `colorOf(x,y)`, `overwritesOf(x,y)`, `cooldownRemaining(addr)` | single-pixel / player reads |
| `getPlayers(offset, limit)`, `playerCount()`, `players(addr)` | leaderboard data |
| `withdraw(to)`, `transferOwnership(newOwner)` | owner only |

Event: `PixelPlaced(uint256 indexed pixelId, address indexed painter, uint8 color, uint16 overwrites, uint256 price)`. Here `overwrites` is the count *before* this placement.

## Frontend notes

- Loads a canvas snapshot at a fixed block, then polls `eth_getLogs` from that block forward, so live updates never miss or double-apply a pixel.
- It never downloads the full event history, which gets huge on a 1M-pixel board. The pixel count comes from `totalPlacements`, the activity feed backfills only the latest ~200 events (shrinking the block range if the RPC rejects it), and a pixel's history is fetched on demand by its indexed `pixelId` topic.
- Laid out like r/place: full-screen canvas, "Place a pixel" button, palette tray with cancel/confirm, corner-bracket reticle. Scroll or pinch to zoom, drag to pan, click a pixel to zoom in on it, arrow keys nudge the selection, Esc cancels.
- Before sending, it re-reads `priceOf` and simulates the tx, so contract errors show up as readable messages instead of a generic wallet failure.
