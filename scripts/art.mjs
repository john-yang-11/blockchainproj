// Demo art for a fresh local canvas. Returns the layers (pixel id -> color maps) in paint order.
// Everything is laid out for 1000x1000 and scaled to the real canvas size.
// Palette indices (r/place 2017): 0 white 1 lgray 2 gray 3 black 4 pink 5 red 6 orange 7 brown
// 8 yellow 9 lime 10 green 11 cyan 12 blue 13 indigo 14 magenta 15 purple

export function buildArt(W, H) {
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
  const disk = (L, x0, y0, r, colorAt) => {
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

  // Solana logo: three slanted bars, teal to purple.
  {
    const L = layer()
    ;[[11, 0], [12, 1], [15, 2]].forEach(([c, i]) => {
      const y0 = 160 + i * 36
      for (let y = 0; y < 24; y++)
        for (let x = 0; x < 150; x++) {
          // top and bottom bars lean right, the middle one leans left
          const shift = i === 1 ? -(24 - y) : -y
          L.put(425 + x + shift + 12, y0 + y, c)
        }
    })
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
    disk(L, 180, 450, 42, (x, y, d) => {
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

  // Big "SOL" in Solana green.
  {
    const L = layer()
    const FONT_S = ['.####', '#....', '#....', '.###.', '....#', '....#', '####.']
    FONT.S = FONT_S
    text(L, 'SOL', 430, 610, 8, () => 10)
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
  return { layers, rnd }
}
