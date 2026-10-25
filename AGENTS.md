# AGENTS.md: OnChain Place → Solana refactor

Read this before touching the repo. It covers what the project is, why it's being rewritten, the target design, and the order of work.

## 0. Context

- **What:** r/place on a blockchain. A shared pixel canvas with the 16-color r/place 2017 palette. Anyone with a wallet pays to paint one pixel at a time.
- **Why:** this is a club "Dev Team" assignment. It's done in pairs (john-yang-11 + ethxyc), it's **due 2026-11-01**, and the best implementation wins.
- **Hard requirement:** the program is **Solana, written in Rust**, and is **deployed with a test wallet** (devnet). The first version in this repo was Ethereum (Solidity + Foundry + wagmi). That version is in git history at commit `2528f42` (tag it `eth-version` before deleting anything). It's useful as a feature reference, not as code to keep.
- **Repo:** https://github.com/john-yang-11/blockchainproj (public), branch `main`.
- **Reference implementation:** [cryptoloutre/solana-place](https://github.com/cryptoloutre/solana-place) (Anchor 0.25 + Next.js).
  - Borrow from it: the vault PDA, the per-player PDA, `emit!` events, and fees growing with repaints.
  - **Don't** copy its one-PDA-per-pixel storage. It works at 100×100, but at our size it means hundreds of thousands of accounts (rent alone is hundreds of SOL) and an unloadable canvas. See §2 for the chunked design.
  - Don't copy its hard-coded event start/end timestamps, or its `withdraw_vault`, which can drain the vault below the rent-exempt minimum.

### Ground rules (non-negotiable)

- **This is a smart contract project.** On Solana a smart contract is called a *program*. Ours is written in Rust with Anchor and deployed on-chain. All game rules run inside the program, not in the frontend or any server: pricing, cooldown, bounds and color checks, fee collection, and stats.
- **Every pixel is stored on-chain.** The canvas is the bytes in program-owned accounts (the `CanvasChunk` PDAs in §2). The chain is the only source of truth.
- No database, no backend, no off-chain indexer, no IPFS. The frontend is just a viewer: it reads the accounts straight from a Solana RPC and sends transactions to the program.

## 1. Feature parity checklist (must all exist in the Solana version)

Taken from the Ethereum version. Every item is a stretch goal we already claimed, so dropping any of them is a regression.

- [ ] Pay to place a pixel `(x, y, color)`, where color is a palette index 0–15
- [ ] **Price rises on overwrite:** `price = base_price + price_increment × tier(pixel)`
- [ ] **Per-wallet cooldown**, enforced on-chain using `Clock`
- [ ] **Pixel history + live activity feed:** an `emit!` event on every placement
- [ ] **Leaderboard:** each player's pixel count and lamports spent, stored on-chain
- [ ] **Efficient storage:** packed canvas, so the whole board loads in about one RPC call
- [ ] Authority can withdraw fees and transfer authority
- [ ] r/place-style UI: full-screen zoom/pan canvas, palette tray, reticle, info drawer (already built; keep it)

## 2. Program design (Anchor, Rust)

### Storage: chunked canvas, 1 byte per pixel

Each pixel is one `u8`:

```
bits 0-3 : color index (0-15)
bits 4-7 : overwrite tier (0-15, saturating). Price input.
```

- Pixel index is `i = y * width + x`.
- The canvas is split **linearly** into chunk PDAs of `CHUNK_SIZE = 10_000` bytes: `chunk = i / CHUNK_SIZE`, `offset = i % CHUNK_SIZE`.
  - 10,000 B stays under the 10,240-byte limit for accounts created by a program (CPI `init`). So each chunk is a normal `init` with **no realloc** and no client-side `createAccount` tricks.
  - Make the chunk accounts `#[account(zero_copy)]` and load them with `AccountLoader`, so the 10 KB array never touches the stack.
- Seeds: `[b"chunk", config.key().as_ref(), &chunk_index.to_le_bytes()]` with `chunk_index: u16`.
- The frontend reads every chunk with `getMultipleAccountsInfo`. It takes ≤100 accounts per call, so 25 chunks is one request.

**Default canvas: 500×500** (250,000 px → 25 chunks, about 250 KB, ≈1.75 SOL rent).
- 1000×1000 is supported by config, but it's 100 chunks and ≈7 SOL of rent. The devnet faucet hands out only a few SOL per day, so don't default to it.
- Width and height are set in `initialize` and stored in `Config`.

### Accounts

| Account | Seeds | Fields |
|---|---|---|
| `Config` | `[b"config"]` | `authority: Pubkey`, `width: u16`, `height: u16`, `base_price: u64`, `price_increment: u64`, `cooldown_secs: i64`, `total_placements: u64`, `bump: u8`. **Also acts as the fee vault** (it's program-owned, so lamports move by direct math). |
| `CanvasChunk` (zero_copy) | `[b"chunk", config, idx_le]` | `pixels: [u8; 10_000]` |
| `Player` | `[b"player", wallet]` | `wallet: Pubkey`, `last_placed: i64`, `pixels_placed: u64`, `lamports_spent: u64`, `bump: u8` |

### Instructions

| Ix | Who | Notes |
|---|---|---|
| `initialize(width, height, base_price, price_increment, cooldown_secs)` | deployer | Creates `Config`. Validates that `width*height > 0` and that both sides are ≤ 4096. |
| `init_chunk(index)` | authority | Creates one chunk PDA, zero-filled (all white, tier 0). The deploy script loops over every index. |
| `place_pixel(x, y, color)` | anyone | Checks bounds, `color < 16`, and the cooldown (`now >= last_placed + cooldown`). It derives the chunk from `(x, y)` and **verifies the passed chunk PDA index matches**. Then: compute the price, system-transfer the lamports `payer → config`, write the byte (new color, `tier = min(tier+1, 15)`), update the `Player` (`init_if_needed`), bump `total_placements`, and `emit!(PixelPlaced)`. |
| `withdraw(amount)` | authority | Never takes `config` below `Rent::minimum_balance(Config::LEN)`. |
| `set_authority(new)` | authority | |
| `seed_pixels(chunk_index, offset, data: Vec<u8>)` | authority, **only behind cargo feature `localnet`** | Bulk-writes demo art for local dev. It must not exist in the devnet build, because an admin overwrite in prod would look bad to judges. |

- Default prices: `base_price = 100_000` lamports (0.0001 SOL), `price_increment = 50_000`, `cooldown_secs = 30`.
- Event: `PixelPlaced { x: u16, y: u16, color: u8, tier_before: u8, painter: Pubkey, price: u64, slot: u64 }`.
- Use a custom `#[error_code]` enum with readable messages: `OutOfBounds`, `InvalidColor`, `CooldownActive`, `WrongChunk`, `InsufficientVault`, `Unauthorized`.

### Tests (`tests/`)

The TS tests should cover at least:
- the happy path
- cooldown rejection, plus success after waiting or a clock warp
- the price increasing over repeated overwrites and saturating at tier 15
- out-of-bounds and invalid color
- the wrong chunk account being rejected
- withdraw respecting rent
- non-authority withdraw being rejected
- `Player` stats adding up

## 3. Frontend changes (`web/`)

Keep the UI and swap the chain layer.

| File | Action |
|---|---|
| `PixelCanvas.tsx` | **Keep as-is.** It only takes a `colors` array plus `width`/`height`. |
| `App.tsx` | Keep the layout and UX. Replace wagmi hooks and ETH formatting with Solana equivalents (lamports → SOL). |
| `config.ts` | Keep `PALETTE`/`PALETTE_RGB`. Replace the wagmi config with cluster/RPC/program-id env vars (`VITE_CLUSTER`, `VITE_RPC_URL`, `VITE_PROGRAM_ID`). |
| `abi.ts` | Delete. Use the Anchor-generated IDL + TS types (copied by a script from `target/idl` and `target/types`). |
| `usePlace.ts` | Rewrite (details below). |
| `main.tsx` | Swap `WagmiProvider` for the Solana wallet-adapter providers (`ConnectionProvider`, `WalletProvider`, `WalletModalProvider`). |

How the new `usePlace.ts` works:
- **Snapshot:** `getMultipleAccountsInfo(allChunkPdas)`. Decode the bytes into `colors` (low nibble) and `tiers` (high nibble).
- **Live updates:** `connection.onAccountChange` per chunk, or a single `onLogs(programId)` that parses `PixelPlaced` events. On devnet, fall back to polling if the websocket drops.
- **Activity feed:** `getSignaturesForAddress(configPda, { limit: 200 })`, then parse events from the tx logs with Anchor's `EventParser`. Never backfill full history.
- **Pixel history (drawer):** best-effort. Use the chunk's recent signatures filtered by the event's `(x, y)`. It's fine to cap this.
- **Leaderboard:** `getProgramAccounts` filtered to `Player` accounts by discriminator, sorted client-side.
- **Sending:** build `place_pixel` with the Anchor client and simulate first, so program errors show as readable messages, not a generic wallet failure.

Supported wallets: Phantom, Solflare, Backpack, via wallet-standard auto-detect. Locally, the replacement for the old "Anvil test account" button is a **"Local burner wallet"** button. It's a keypair auto-airdropped on the local validator, and it only appears when `VITE_CLUSTER=localnet`.

> Library versions move fast. Before writing code, check the current Anchor docs for the right TS client package and the `ctx.bumps` / IDL API for whatever Anchor version `avm` installs. Don't code from memory of Anchor 0.25-era examples.

## 4. Repo layout (target)

```
Anchor.toml
Cargo.toml                 # workspace
programs/place/src/lib.rs  # the program (split into modules if it grows: state.rs, instructions/, errors.rs)
tests/place.ts             # anchor tests
scripts/
  deploy-devnet.sh         # build, deploy, initialize, init all chunks, write web/.env.local
  dev.sh                   # local validator + deploy + seed + vite
  seed.ts                  # demo art via seed_pixels (localnet feature only)
  copy-idl.mjs             # target/idl + target/types → web/src/idl/
web/                       # Vite + React frontend (see §3)
README.md                  # rewrite for Solana once the refactor lands
```

Delete `contracts/`, `.gitmodules`, `contracts/lib/forge-std`, `dev.bat`'s Foundry steps, and the old `scripts/*` once the Solana equivalents work. Tag `eth-version` first.

## 5. Toolchain + environment

- **Build in WSL (Ubuntu-24.04), not native Windows.** Anchor on Windows is painful.
- Install Rust, the Solana CLI, Anchor (via `avm`) and Node from the official Solana installation docs (https://solana.com/docs/intro/installation). Pin the versions you end up with in `Anchor.toml` (`[toolchain]`) and note them in the README.
- The repo lives at `C:\Users\anima\onchain-place` (`/mnt/c/Users/anima/onchain-place` in WSL). Cargo builds on `/mnt/c` are slow. If that hurts, keep `target/` on the Linux filesystem (`CARGO_TARGET_DIR=~/.cache/place-target`).
- Local chain: `anchor test` / `solana-test-validator` (or Surfpool if the installed Anchor version uses it by default).

## 6. Test wallet + devnet deploy

- Generate a **throwaway** deployer: `solana-keygen new -o ~/.config/solana/place-devnet.json`.
  - It lives **outside the repo** and is never committed. Add `*.json` keypair patterns and `.env*` to `.gitignore` before anything else.
- Fund it with `solana airdrop 2 --url devnet` (rate-limited) or https://faucet.solana.com (GitHub login gives more).
- **Budget about 5 SOL** for the 500×500 default:
  - program deploy rent ≈ 2–3 SOL (scales with `.so` size)
  - 25 chunks ≈ 1.75 SOL
  - fees ≈ small
- Keep the program **upgradeable** during development. Commit the program id (`declare_id!` + `Anchor.toml`), but **never** commit `target/deploy/*-keypair.json`.
- `scripts/deploy-devnet.sh` must be idempotent: skip chunks that already exist.
- Frontend hosting: build `web/` and deploy it static (Vercel), with `VITE_*` env vars pointing at devnet.

## 7. Work order

1. Tag `eth-version`. Scaffold the Anchor workspace. Get `anchor build` working in WSL.
2. Write the program + tests (§2). Get `anchor test` green.
3. Write the local scripts (`dev.sh`, `seed.ts`, `copy-idl.mjs`).
4. Port the frontend (§3) against localnet until the parity checklist (§1) passes by hand.
5. Create the devnet wallet, fund it, deploy, and init the chunks. Smoke-test with a real Phantom wallet on devnet.
6. Rewrite `README.md`: what it is, the design (§2, briefly), run locally, deploy, and the program id + live URL.
7. Clean out the Ethereum leftovers (§4).

## 8. Conventions

- Two people push to `main`. Use small commits and pull before pushing, with feature branches for anything big.
- Never force-push `main`.
- Run `anchor test` and `cd web && npm run build` before pushing.
- Don't commit secrets: no keypairs, no `.env.local`, no RPC API keys.
- When editing files with non-ASCII text on Windows, use an editor or tooling that preserves UTF-8 (Python one-liners have mangled text here before).
