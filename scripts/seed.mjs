// Paint demo art on a LOCAL anvil deployment, so the board doesn't start empty.
//   node scripts/seed.mjs            (reads the contract address from web/.env.local)
// Uses anvil's impersonation to paint from ~60 made-up wallets, fast-forwarding time past the
// cooldown between rounds, so the activity feed and leaderboard look like real play.
// Never point this at a real network — anvil_* methods only exist on a dev node.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const rpc = process.env.RPC_URL || 'http://127.0.0.1:8545'
const env = readFileSync(`${root}web/.env.local`, 'utf8')
const contract = env.match(/VITE_CONTRACT_ADDRESS=(0x[0-9a-fA-F]{40})/)?.[1]
if (!contract) throw new Error('No VITE_CONTRACT_ADDRESS in web/.env.local — run scripts/deploy.sh local first')

// Selectors (cast sig "...").
const SEL = { width: '0x9ededf77', height: '0x0ef26743', cooldown: '0x787a08a6', placePixel: '0x727bd8c7' }
const VALUE = '0x' + (10n ** 15n).toString(16) // 0.001 ETH; the contract refunds anything over the price

let rpcId = 0
async function call(batch) {
  const body = batch.map(([method, params]) => ({ jsonrpc: '2.0', id: ++rpcId, method, params }))
  const res = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  for (const r of res) if (r.error) throw new Error(`${r.error.message} ${JSON.stringify(r.error.data ?? '')}`)
  return res.sort((a, b) => a.id - b.id).map((r) => r.result)
}
const read = async (sel) => Number(BigInt((await call([['eth_call', [{ to: contract, data: sel }, 'latest']]]))[0]))

const W = await read(SEL.width)
const H = await read(SEL.height)
const COOLDOWN = await read(SEL.cooldown)

// ------------------------------------------------------------------ art
// Palette indices (r/place 2017): 0 white 1 lgray 2 gray 3 black 4 pink 5 red 6 orange 7 brown
// 8 yellow 9 lime 10 green 11 cyan 12 blue 13 indigo 14 magenta 15 purple
let rand = 1337
const rnd = () => ((rand = (rand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const k = W / 1000 // everything is laid out for 1000×1000 and scaled for other sizes
const cx = W / 2

/** A layer is one piece of art: a pixel map where later writes win, painted as a unit. */
const layers = []
function layer() {
  const m = new Map()
  layers.push(m)
  return {
    put(x, y, c) {
      x = Math.round(x * k)
      y = Math.round(y * k)
      if (x >= 0 && y >= 0 && x < W && y < H) m.set(y * W + x, c)
    },
    rect(x0, y0, w, h, c) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.put(x0 + x, y0 + y, c)
    },
    sprite(rows, x0, y0, colors, s = 1) {
      rows.forEach((row, y) =>
        [...row].forEach((ch, x) => {
          if (ch in colors) this.rect(x0 + x * s, y0 + y * s, s, s, colors[ch])
        }),
      )
    },
  }
}

const FONT = {
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
}
const textWidth = (str, s) => [...str].reduce((w, ch) => w + (ch === ' ' ? 4 : FONT[ch][0].length + 1) * s, -s)
function text(L, str, x0, y0, s, colorAt) {
  let x = x0
  for (const ch of str) {
    if (ch === ' ') { x += 4 * s; continue }
    const g = FONT[ch]
    g.forEach((row, gy) => [...row].forEach((on, gx) => on === '#' && L.rect(x + gx * s, y0 + gy * s, s, s, colorAt(x + gx * s))))
    x += (g[0].length + 1) * s
  }
}
const disc = (L, x0, y0, r, colorAt) => {
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++) {
      const d = Math.hypot(x, y)
      if (d <= r + 0.3) {
        const c = colorAt(x, y, d)
        if (c !== null) L.put(x0 + x, y0 + y, c)
      }
    }
}

// Scattered "random visitors" first, so later art sits on top of some of them.
{
  const L = layer()
  for (let i = 0; i < 2500; i++) L.put(rnd() * 1000, rnd() * 1000, Math.floor(rnd() * 16))
}

// Title, rainbow gradient with a drop shadow.
{
  const L = layer()
  const s = 6
  const str = 'ONCHAIN PLACE'
  const w = textWidth(str, s)
  const x0 = Math.round(cx / k - w / 2)
  const ramp = [5, 6, 8, 10, 11, 12, 13, 15]
  text(L, str, x0 + 3, 63, s, () => 3)
  text(L, str, x0, 60, s, (x) => ramp[Math.min(ramp.length - 1, Math.floor(((x - x0) / w) * ramp.length))])
}

// Ethereum diamond.
{
  const L = layer()
  const h = 120
  const top = 150
  for (let y = 0; y < h; y++) {
    const upper = y < h * 0.58
    const hw = Math.round(upper ? y * 0.48 : (h - y) * 0.48 * 1.38)
    for (let x = -hw; x <= hw; x++) L.put(500 + x, top + y, upper ? (x < 0 ? 2 : 3) : x < 0 ? 1 : 2)
  }
}

// Pride flag.
{
  const L = layer()
  ;[5, 6, 8, 10, 12, 15].forEach((c, i) => L.rect(90, 160 + i * 14, 170, 14, c))
  L.rect(90, 160, 170, 2, 3)
}

// Block M, maize and blue.
{
  const L = layer()
  L.rect(740, 155, 170, 110, 13)
  L.sprite(
    ['#####...#####', '######.######', '.###########.', '.###.###.###.', '.###..#..###.', '.###.....###.', '####.....####', '####.....####'],
    766, 170, { '#': 8 }, 9,
  )
}

// Row of hearts.
{
  const L = layer()
  const heart = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...']
  ;[5, 4, 6, 8, 10, 12, 15].forEach((c, i) => L.sprite(heart, 345 + i * 46, 300, { '#': c }, 4))
}

// Smiley.
{
  const L = layer()
  disc(L, 180, 450, 42, (x, y, d) => {
    if (d > 39) return 3
    if (Math.hypot(x + 15, y + 12) < 6 || Math.hypot(x - 15, y + 12) < 6) return 3
    if (y > 8 && Math.abs(d - 24) < 3) return 3
    return 8
  })
}

// "Battle zone": a square painted over three times, so its pixels show rising prices.
for (const c of [12, 5, 8]) {
  const L = layer()
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) if (c !== 5 || (x >> 2) % 2 === (y >> 2) % 2) L.put(470 + x, 400 + y, c)
}

// Creeper.
{
  const L = layer()
  L.sprite(['gGgggGgg', 'gGgGgggG', 'gBBggBBg', 'gBBggBBg', 'gggBBggg', 'ggBBBBgg', 'ggBBBBgG', 'gGBggBgg'], 760, 400, { g: 10, G: 9, B: 3 }, 12)
}

// GM.
{
  const L = layer()
  text(L, 'GM', 330, 560, 8, () => 7)
}

// Base logo: blue disc with the white notch.
{
  const L = layer()
  disc(L, 500, 640, 60, (x, y) => (x < 10 && Math.abs(y) < 7 ? 0 : 12))
}

// Space invader.
{
  const L = layer()
  L.sprite(
    ['..#.....#..', '...#...#...', '..#######..', '.##.###.##.', '###########', '#.#######.#', '#.#.....#.#', '...##.##...'],
    110, 640, { '#': 14 }, 7,
  )
}

// Mushroom.
{
  const L = layer()
  L.sprite(
    ['....RRRR....', '..RRWWRRRR..', '.RRWWWWRRRR.', '.RRRWWRRRWW.', 'RRRRRRRRWWWW', 'RWWRRRRRWWWR', 'WWWWRRRRRWWR', '..wwwwwwww..', '..wwBwwBww..', '..wwBwwBww..', '..wwwwwwww..', '...wwwwww...'],
    760, 600, { R: 5, W: 0, w: 1, B: 3 }, 8,
  )
}

// A tiny tricolor flag row along the bottom, like the flag strips on the real board.
{
  const L = layer()
  const flags = [[12, 0, 5], [10, 0, 5], [3, 5, 8], [5, 0, 5], [12, 8, 12], [10, 8, 12], [5, 8, 10], [0, 12, 5]]
  flags.forEach((f, i) => f.forEach((c, j) => L.rect(150 + i * 92, 820 + j * 18, 80, 18, c)))
}

// Shuffle within each layer so pixels arrive scattered, like real players.
const queue = []
for (const m of layers) {
  const L = [...m].map(([id, c]) => [id % W, Math.floor(id / W), c])
  for (let i = L.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[L[i], L[j]] = [L[j], L[i]]
  }
  queue.push(...L)
}

// ------------------------------------------------------------------ paint
const hex = (n, bytes = 32) => n.toString(16).padStart(bytes * 2, '0')
const painters = Array.from({ length: 60 }, () => '0x' + Array.from({ length: 40 }, () => Math.floor(rnd() * 16).toString(16)).join(''))
// Some painters are much more active than others, so the leaderboard has a spread.
const activity = painters.map((_, i) => Math.max(0.05, 1 - i / 45))

await call([
  ['anvil_autoImpersonateAccount', [true]],
  // One block per round instead of one per tx: much faster, and fewer blocks for the frontend to scan.
  ['evm_setAutomine', [false]],
  ...painters.map((p) => ['anvil_setBalance', [p, '0x' + (10n ** 20n).toString(16)]]),
])

const t0 = Date.now()
let done = 0
try {
  while (done < queue.length) {
    const round = []
    for (let i = 0; i < painters.length && done + round.length < queue.length; i++) {
      if (rnd() > activity[i]) continue
      const [x, y, c] = queue[done + round.length]
      const data = SEL.placePixel + hex(x) + hex(y) + hex(c)
      round.push(['eth_sendTransaction', [{ from: painters[i], to: contract, data, value: VALUE, gas: '0x40000' }]])
    }
    if (!round.length) continue
    // Fast-forward past everyone's cooldown, then mine the whole round in one block.
    await call([...round, ['evm_increaseTime', ['0x' + (COOLDOWN + 1).toString(16)]], ['evm_mine', []]])
    const before = done
    done += round.length
    if (Math.floor(done / 10000) > Math.floor(before / 10000)) console.log(`  ${done}/${queue.length} pixels…`)
  }
} finally {
  await call([['evm_setAutomine', [true]], ['anvil_autoImpersonateAccount', [false]]])
}
console.log(`Seeded ${queue.length} pixels from ${painters.length} wallets in ${((Date.now() - t0) / 1000).toFixed(1)}s.`)
