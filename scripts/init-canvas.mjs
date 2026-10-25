// Initializes a freshly deployed Place program: creates the Config account and every canvas chunk.
// On localnet it can also paint demo art and have a few dozen burner wallets place real pixels,
// so the activity feed and leaderboard aren't empty.
//
//   node scripts/init-canvas.mjs [--url http://127.0.0.1:8899] [--keypair ~/.config/solana/id.json]
//                                [--width 500] [--height 500] [--cooldown 30] [--seed]
//
// Idempotent: skips the config and any chunk that already exists.
// --seed needs a program built with `--features localnet` (it calls the localnet-only seed_pixels).
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildArt } from './art.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
// Reuse the frontend's install instead of a second node_modules.
const require = createRequire(`${root}web/package.json`)
const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js')

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const flag = (name) => args.includes(`--${name}`)

const url = opt('url', 'http://127.0.0.1:8899')
const keypairPath = opt('keypair', `${homedir()}/.config/solana/id.json`).replace(/^~/, homedir())
const WIDTH = Number(opt('width', 500))
const HEIGHT = Number(opt('height', 500))
const BASE_PRICE = BigInt(opt('base-price', 100_000)) // lamports (0.0001 SOL)
const PRICE_INCREMENT = BigInt(opt('price-increment', 50_000))
const COOLDOWN = BigInt(opt('cooldown', 30))
const CHUNK_SIZE = 10_000

const idl = JSON.parse(readFileSync(`${root}web/src/idl/place.json`, 'utf8'))
const programId = new PublicKey(opt('program-id', idl.address))
const connection = new Connection(url, 'confirmed')
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))))

// ------------------------------------------------------------------ encoding helpers
const ixDisc = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b }

const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0]
const chunkPda = (i) => PublicKey.findProgramAddressSync([Buffer.from('chunk'), u16(i)], programId)[0]
const playerPda = (w) => PublicKey.findProgramAddressSync([Buffer.from('player'), w.toBuffer()], programId)[0]

const ix = (name, keys, data = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId, keys, data: Buffer.concat([ixDisc(name), data]) })
const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true })
const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false })
const signer = (pubkey) => ({ pubkey, isSigner: true, isWritable: true })
const send = (instructions, signers) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...instructions), signers, { commitment: 'confirmed' })

/** Runs async jobs with bounded concurrency. */
async function pool(items, limit, fn) {
  let next = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  }))
}

// ------------------------------------------------------------------ config + chunks
console.log(`Program ${programId.toBase58()} on ${url}`)
console.log(`Authority ${authority.publicKey.toBase58()} (${(await connection.getBalance(authority.publicKey)) / LAMPORTS_PER_SOL} SOL)`)

let width = WIDTH
let height = HEIGHT
const existing = await connection.getAccountInfo(configPda)
if (existing) {
  width = existing.data.readUInt16LE(40)
  height = existing.data.readUInt16LE(42)
  console.log(`Config exists: ${width}x${height}`)
} else {
  await send(
    [ix('initialize', [w(configPda), signer(authority.publicKey), r(SystemProgram.programId)],
      Buffer.concat([u16(WIDTH), u16(HEIGHT), u64(BASE_PRICE), u64(PRICE_INCREMENT), i64(COOLDOWN)]))],
    [authority],
  )
  console.log(`Initialized ${WIDTH}x${HEIGHT}, ${Number(BASE_PRICE) / LAMPORTS_PER_SOL} SOL base, +${Number(PRICE_INCREMENT) / LAMPORTS_PER_SOL} SOL per overwrite, ${COOLDOWN}s cooldown`)
}

const chunks = Math.ceil((width * height) / CHUNK_SIZE)
const infos = []
for (let i = 0; i < chunks; i += 100)
  infos.push(...(await connection.getMultipleAccountsInfo(Array.from({ length: Math.min(100, chunks - i) }, (_, j) => chunkPda(i + j)))))
const missing = infos.map((info, i) => (info ? null : i)).filter((i) => i !== null)
await pool(missing, 8, (i) =>
  send([ix('init_chunk', [r(configPda), w(chunkPda(i)), signer(authority.publicKey), r(SystemProgram.programId)], u16(i))], [authority]),
)
console.log(`Chunks: ${chunks} total, ${missing.length} created`)

// ------------------------------------------------------------------ localnet demo data
if (flag('seed')) {
  const { layers, rnd } = buildArt(width, height)

  // Final image + how many layers touched each pixel (its overwrite tier, so "battle zones" cost more).
  const bytes = new Uint8Array(width * height)
  for (const m of layers)
    for (const [id, c] of m) bytes[id] = (Math.min(15, (bytes[id] >> 4) + 1) << 4) | c

  // seed_pixels writes raw bytes; ~850 per tx keeps it under the 1232-byte packet limit.
  const SLICE = 850
  const jobs = []
  for (let c = 0; c < chunks; c++) {
    const start = c * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, bytes.length)
    for (let off = start; off < end; off += SLICE) {
      const data = bytes.subarray(off, Math.min(off + SLICE, end))
      if (data.some((b) => b)) jobs.push([c, off - start, data])
    }
  }
  const t0 = Date.now()
  await pool(jobs, 16, ([c, off, data]) =>
    send(
      [ix('seed_pixels', [r(configPda), w(chunkPda(c)), { pubkey: authority.publicKey, isSigner: true, isWritable: false }],
        Buffer.concat([u16(c), u32(off), u32(data.length), Buffer.from(data)]))],
      [authority],
    ),
  )
  console.log(`Seeded art in ${jobs.length} txs (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

  // Real placements from burner wallets: these go through the actual game rules (price, cooldown,
  // stats, events), so the activity feed and leaderboard have data.
  const players = Array.from({ length: 30 }, () => Keypair.generate())
  await pool(players, 10, async (p) => {
    const sig = await connection.requestAirdrop(p.publicKey, LAMPORTS_PER_SOL)
    await connection.confirmTransaction(sig, 'confirmed')
  })
  const cooldownSecs = Number((await connection.getAccountInfo(configPda)).data.readBigInt64LE(60))
  // They repaint art pixels in the color those pixels already have, so the picture stays intact.
  const art = layers.slice(1).flatMap((m) => [...m.keys()])
  const ROUNDS = 2
  let placed = 0
  for (let round = 0; round < ROUNDS; round++) {
    // Some wallets are more active than others, so the leaderboard has a spread.
    const active = players.filter((_, i) => round === 0 || rnd() < Math.max(0.15, 1 - i / 25))
    const batch = active.map((p) => {
      const id = art[Math.floor(rnd() * art.length)]
      return [p, [id, bytes[id] & 0xf]]
    })
    await pool(batch, 10, ([p, [id, c]]) => {
      const x = id % width
      const y = Math.floor(id / width)
      const chunk = Math.floor(id / CHUNK_SIZE)
      return send(
        [ix('place_pixel', [w(configPda), w(chunkPda(chunk)), w(playerPda(p.publicKey)), signer(p.publicKey), r(SystemProgram.programId)],
          Buffer.concat([u16(chunk), u16(x), u16(y), Buffer.from([c])]))],
        [p],
      )
    })
    placed += batch.length
    console.log(`  round ${round + 1}/${ROUNDS}: ${placed} real placements from ${players.length} wallets`)
    if (round < ROUNDS - 1) await new Promise((res) => setTimeout(res, (cooldownSecs + 1) * 1000))
  }
}

// ------------------------------------------------------------------ frontend env
const cluster = /devnet/.test(url) ? 'devnet' : 'localnet'
const envPath = `${root}web/.env.local`
writeFileSync(
  envPath,
  [
    `VITE_CLUSTER=${cluster}`,
    `VITE_PROGRAM_ID=${programId.toBase58()}`,
    ...(cluster === 'localnet' ? [`VITE_RPC_URL=${url}`] : []),
    '',
  ].join('\n'),
)
console.log(`Wrote ${envPath}`)
process.exit(0) // web3.js keeps sockets open otherwise
