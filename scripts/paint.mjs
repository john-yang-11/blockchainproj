// Paints pixel art onto a live canvas through the normal place_pixel rules (price, cooldown, events).
// The funder pays for a set of throwaway painter wallets; each places one pixel per cooldown.
//
//   node scripts/paint.mjs --art scripts/art/tung-tung-sahur.mjs --x 222 --y 200   (.mjs or .json art)
//                          [--url https://api.devnet.solana.com] [--keypair ~/.config/solana/place-devnet.json]
//                          [--wallets 60] [--concurrency 2]
//   node scripts/paint.mjs --sweep        send what's left in the painter wallets back to the funder
//
// Idempotent: each round re-reads the canvas and only paints pixels that aren't the target color yet.
// Painter keys live in ~/.cache/place-painters.json (outside the repo) so a rerun reuses them.
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(`${root}web/package.json`)
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js')

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const flag = (name) => args.includes(`--${name}`)
const home = (p) => p.replace(/^~/, homedir())

const url = opt('url', 'https://api.devnet.solana.com')
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(home(opt('keypair', '~/.config/solana/place-devnet.json')), 'utf8'))))
const WALLETS = Number(opt('wallets', 60))
const CONCURRENCY = Number(opt('concurrency', 2))
const CHUNK_SIZE = 10_000
const walletsPath = `${homedir()}/.cache/place-painters.json`

const idl = JSON.parse(readFileSync(`${root}web/src/idl/place.json`, 'utf8'))
const programId = new PublicKey(opt('program-id', idl.address))
const connection = new Connection(url, 'confirmed')

const ixDisc = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0]
const chunkPda = (i) => PublicKey.findProgramAddressSync([Buffer.from('chunk'), u16(i)], programId)[0]
const playerPda = (w) => PublicKey.findProgramAddressSync([Buffer.from('player'), w.toBuffer()], programId)[0]
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true })
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false })
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
// The public devnet RPC answers bursts with 429s, so every call below backs off and retries.
// Sends without waiting for confirmation (confirming costs several RPC calls per tx, which is what
// trips the rate limit). Callers check the result by re-reading on-chain state instead.
async function fire(instructions, signers, blockhash) {
  const tx = new Transaction({ feePayer: signers[0].publicKey, recentBlockhash: blockhash }).add(...instructions)
  tx.sign(...signers)
  // Short backoff only: long waits would outlive the blockhash and the tx would be dropped anyway.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 })
    } catch (e) {
      if (!/429/.test(String(e?.message))) return null
      await sleep(1000 * 2 ** attempt)
    }
  }
  return null
}
const withRetry = async (fn) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (attempt >= 6) throw e
      await sleep(2000 * 2 ** attempt)
    }
  }
}
// web3.js sometimes rejects a polling promise nobody awaits; don't let a stray 429 kill the run.
process.on('unhandledRejection', (e) => console.error(`ignored: ${e?.message ?? e}`))
const sol = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4)

async function pool(items, limit, fn) {
  let next = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  }))
}

function loadWallets() {
  if (!existsSync(walletsPath)) return []
  return JSON.parse(readFileSync(walletsPath, 'utf8')).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)))
}

// ------------------------------------------------------------------ sweep
if (flag('sweep')) {
  const wallets = loadWallets()
  const before = await withRetry(() => connection.getBalance(funder.publicKey))
  for (let attempt = 0; attempt < 4; attempt++) {
    const infos = await withRetry(() => connection.getMultipleAccountsInfo(wallets.map((p) => p.publicKey)))
    const full = wallets.map((p, i) => [p, infos[i]?.lamports ?? 0]).filter(([, bal]) => bal > 5000)
    if (!full.length) break
    const { blockhash } = await withRetry(() => connection.getLatestBlockhash())
    await pool(full, CONCURRENCY, ([p, bal]) =>
      fire([SystemProgram.transfer({ fromPubkey: p.publicKey, toPubkey: funder.publicKey, lamports: bal - 5000 })], [p], blockhash))
    await sleep(15_000)
  }
  const after = await withRetry(() => connection.getBalance(funder.publicKey))
  console.log(`Swept ${sol(after - before)} SOL from ${wallets.length} wallets back to ${funder.publicKey.toBase58()} (now ${sol(after)} SOL)`)
  process.exit(0)
}

// ------------------------------------------------------------------ plan
// Art is either a .mjs module or a .json file, both shaped { width, height, pixels: [[dx, dy, color]] }.
const artPath = resolve(opt('art', `${root}scripts/art/tung-tung-sahur.mjs`))
const art = artPath.endsWith('.json') ? JSON.parse(readFileSync(artPath, 'utf8')) : await import(pathToFileURL(artPath).href)
const OX = Number(opt('x', 222))
const OY = Number(opt('y', 200))

const config = (await withRetry(() => connection.getAccountInfo(configPda))).data
const width = config.readUInt16LE(40)
const height = config.readUInt16LE(42)
const basePrice = config.readBigUInt64LE(44)
const priceIncrement = config.readBigUInt64LE(52)
const cooldownSecs = Number(config.readBigInt64LE(60))

const targets = art.pixels
  .map(([dx, dy, color]) => ({ x: OX + dx, y: OY + dy, color }))
  .filter(({ x, y }) => x < width && y < height)
  .map((p) => ({ ...p, id: p.y * width + p.x }))
  .sort((a, b) => a.id - b.id)
const chunkIds = [...new Set(targets.map((t) => Math.floor(t.id / CHUNK_SIZE)))]

async function pending() {
  const infos = await withRetry(() => connection.getMultipleAccountsInfo(chunkIds.map(chunkPda)))
  const data = new Map(chunkIds.map((c, i) => [c, infos[i].data]))
  return targets
    .map((t) => ({ ...t, byte: data.get(Math.floor(t.id / CHUNK_SIZE))[8 + (t.id % CHUNK_SIZE)] }))
    .filter((t) => (t.byte & 0xf) !== t.color)
}

let todo = await pending()
console.log(`${art.pixels.length} art pixels at (${OX}, ${OY}); ${todo.length} still to paint`)
if (!todo.length) process.exit(0)

// ------------------------------------------------------------------ painter wallets
const wallets = loadWallets()
while (wallets.length < WALLETS) wallets.push(Keypair.generate())
mkdirSync(`${homedir()}/.cache`, { recursive: true })
writeFileSync(walletsPath, JSON.stringify(wallets.map((k) => Array.from(k.secretKey))), { mode: 0o600 })
const painters = wallets.slice(0, WALLETS)

// Each painter needs its Player account's rent, its share of the pixel prices, and tx fees.
const rounds = Math.ceil(todo.length / painters.length)
const maxPrice = todo.reduce((m, t) => {
  const p = basePrice + priceIncrement * BigInt(t.byte >> 4)
  return p > m ? p : m
}, 0n)
const playerRent = await withRetry(() => connection.getMinimumBalanceForRentExemption(8 + 32 + 8 + 8 + 8 + 1))
const need = playerRent + rounds * (Number(maxPrice) + 5000) + 1_000_000
for (let attempt = 0; ; attempt++) {
  const balances = await withRetry(() => connection.getMultipleAccountsInfo(painters.map((p) => p.publicKey)))
  const topUps = painters
    .map((p, i) => [p, need - (balances[i]?.lamports ?? 0)])
    .filter(([, amount]) => amount > 0)
  if (!topUps.length) break
  if (attempt >= 5) throw new Error(`${topUps.length} painter wallets still unfunded`)
  const cost = topUps.reduce((s, [, a]) => s + a, 0)
  console.log(`${painters.length} painters, ~${rounds} rounds of ${cooldownSecs + 8}s; funding ${topUps.length} wallets with ${sol(cost)} SOL total`)
  const { blockhash } = await withRetry(() => connection.getLatestBlockhash())
  for (let i = 0; i < topUps.length; i += 15) {
    const batch = topUps.slice(i, i + 15)
    await fire(batch.map(([p, lamports]) => SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: p.publicKey, lamports })), [funder], blockhash)
  }
  await sleep(15_000)
}

// ------------------------------------------------------------------ paint
const placeIx = (painter, { x, y, id, color }) => {
  const chunk = Math.floor(id / CHUNK_SIZE)
  return new TransactionInstruction({
    programId,
    keys: [w(configPda), w(chunkPda(chunk)), w(playerPda(painter.publicKey)), { pubkey: painter.publicKey, isSigner: true, isWritable: true }, r(SystemProgram.programId)],
    data: Buffer.concat([ixDisc('place_pixel'), u16(chunk), u16(x), u16(y), Buffer.from([color])]),
  })
}

// A round spans one cooldown plus slack (devnet's on-chain clock lags wall time). Sends are spread
// evenly across it: bursts get 429'd, and the backoff then outlives the blockhash so txs get dropped.
const ROUND_MS = (cooldownSecs + 8) * 1000
const spacing = ROUND_MS / painters.length
for (let round = 1; todo.length; round++) {
  const started = Date.now()
  const batch = todo.slice(0, painters.length)
  let blockhash
  let sent = 0
  // Failed or dropped txs (e.g. a cooldown) just leave the pixel pending for the next round.
  for (let i = 0; i < batch.length; i++) {
    if (i % 25 === 0) ({ blockhash } = await withRetry(() => connection.getLatestBlockhash()))
    if (await fire([placeIx(painters[i], batch[i])], [painters[i]], blockhash)) sent++
    await sleep(Math.max(0, started + (i + 1) * spacing - Date.now()))
  }
  await sleep(Math.max(0, ROUND_MS - (Date.now() - started)))
  const before = todo.length
  todo = await pending()
  console.log(`round ${round}: sent ${sent}/${batch.length}, ${before - todo.length} landed, ${todo.length} left`)
}
console.log('Done. Run with --sweep to send leftover SOL back to the funder.')
process.exit(0)
