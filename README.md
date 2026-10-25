# OnChain Place

r/place as a **Solana smart contract** (a Rust/Anchor program). There's one shared 500×500 canvas with the 16-color r/place 2017 palette. Anyone with a Solana wallet pays a little SOL to paint a pixel. **Every pixel is stored on-chain** in accounts the program owns. There's no database or backend; the website just reads the chain and sends transactions.

| Feature | How |
|---|---|
| Pay to place a pixel | `place_pixel(chunk, x, y, color)` moves the price in lamports from the painter into the program's vault (the `Config` PDA) |
| Price rises on overwrite | Each pixel stores an overwrite tier (0–15). `price = base_price + price_increment × tier` |
| Cooldown per wallet | `Player` PDA stores `last_placed`; enforced with the on-chain `Clock` |
| History + live feed | Every placement does `emit!(PixelPlaced { x, y, color, tier_before, painter, price, timestamp })`. The frontend subscribes to the program's logs |
| Leaderboard | One `Player` PDA per wallet (pixels placed, lamports spent), read with `getProgramAccounts` |
| Efficient storage | **1 byte per pixel** (low 4 bits color, high 4 bits tier), split across 25 zero-copy chunk accounts of 10,000 bytes. The whole board loads in one `getMultipleAccounts` call |
| Admin | `withdraw` (never below rent exemption) and `set_authority` |

## Layout

```
programs/place/src/lib.rs   the program (Anchor 1.1.2)
programs/place/tests/       Rust tests (LiteSVM): cargo test
scripts/init-canvas.mjs     initialize config + chunks (+ --seed demo art and live wallets on localnet)
scripts/local-chain.sh      build, start validator, deploy, init, seed (run in WSL/Linux)
web/                        Vite + React frontend (@solana/web3.js + wallet adapter)
dev.bat                     Windows: does all of the above and opens the site
```

## Setup

The toolchain runs in WSL (Ubuntu) on Windows, or natively on Linux/macOS. Install Rust, the Solana CLI, Anchor and Node with the official installer (https://solana.com/docs/intro/installation):

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
```

Tested with Rust 1.89 (pinned in `rust-toolchain.toml`), solana-cli 3.1.10, anchor-cli 1.1.2 and Node 24. Install the frontend dependencies with `cd web && npm install`.

## Run locally

**Windows:** double-click `dev.bat`. It opens a WSL window running the local chain (build, validator, deploy, demo art), waits for it, then starts the site.

**Manually:**

```bash
./scripts/local-chain.sh        # terminal 1 (WSL/Linux). Leaves solana-test-validator running
cd web && npm run dev           # terminal 2. Open the printed URL
```

Use the **"Local burner wallet"** button. It creates a throwaway key in the browser and airdrops it local SOL, so you don't need a wallet extension. Phantom, Solflare, Backpack, or MetaMask's Solana account work too if you point them at localhost.

Tests: `cargo test` (after `anchor build`). Builds put their output in `$CARGO_TARGET_DIR`; the scripts default it to `~/.cache/place-target`, because building on `/mnt/c` is slow.

## Deploy to devnet

1. Put a throwaway deployer key at `~/.config/solana/place-devnet.json`. Generate one with `solana-keygen new -o ...`, or import the Solana private key you saved in `.env`. Never commit it.
2. Fund it with devnet SOL from https://faucet.solana.com. You need about 5 SOL: about 1.5 for the program and about 1.75 for the 25 canvas chunks.
3. Build **without** the `localnet` feature, deploy and initialize:
   ```bash
   anchor build
   solana program deploy -u devnet -k ~/.config/solana/place-devnet.json \
     $CARGO_TARGET_DIR/deploy/place.so --program-id $CARGO_TARGET_DIR/deploy/place-keypair.json
   node scripts/init-canvas.mjs --url https://api.devnet.solana.com --keypair ~/.config/solana/place-devnet.json
   ```
4. `cd web && npm run build` and host `web/dist` on a static host (Vercel etc.) with `VITE_CLUSTER=devnet` and `VITE_PROGRAM_ID=<id>`.

Keep `$CARGO_TARGET_DIR/deploy/place-keypair.json` safe: it's the program's address, and you need it to upgrade the program.

## Program API

| Instruction | Who | Notes |
|---|---|---|
| `initialize(width, height, base_price, price_increment, cooldown_secs)` | deployer | creates `Config` (seed `"config"`) |
| `init_chunk(index)` | authority | creates chunk PDA `["chunk", index u16 LE]`, all white |
| `place_pixel(chunk_index, x, y, color)` | anyone | errors: `OutOfBounds`, `InvalidColor`, `CooldownActive`, `WrongChunk` |
| `withdraw(amount)` | authority | `InsufficientVault` if it would dip below rent exemption |
| `set_authority(new)` | authority | |
| `seed_pixels(chunk, offset, bytes)` | authority | **only compiled with `--features localnet`**, for demo art |

Pixel `i = y * width + x` lives in chunk `i / 10000`, at byte offset `8 + i % 10000` of that account.
