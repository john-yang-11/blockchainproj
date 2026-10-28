// Tung Tung Tung Sahur: a wooden log with a face, stick limbs and a bat, plus his name underneath.
// Exports { width, height, pixels: [[dx, dy, color]] } for scripts/paint.mjs (colors are palette indices).

const WHITE = 0, GRAY = 2, BLACK = 3, RED = 5, ORANGE = 6, BROWN = 7

const grid = new Map()
const set = (x, y, c) => grid.set(`${x},${y}`, [x, y, c])
const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c) }
const line = (x0, y0, x1, y1, c) => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  for (let i = 0; i <= n; i++) set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c)
}

// Sprite is centered horizontally in a 56-wide block so the name fits underneath.
const X = 11

// Log body, rounded at the corners, with a highlight stripe and some grain.
rect(X + 9, 2, X + 22, 33, BLACK)
rect(X + 10, 3, X + 21, 32, BROWN)
for (const [x, y] of [[9, 2], [22, 2], [9, 33], [22, 33]]) grid.delete(`${X + x},${y}`)
rect(X + 11, 4, X + 11, 31, ORANGE)
for (let y = 20; y <= 31; y += 4) set(X + 19, y, ORANGE), set(X + 19, y + 1, ORANGE)
for (const [x, y] of [[14, 21], [15, 22], [17, 26], [18, 27], [13, 29]]) set(X + x, y, GRAY)

// Face: angry brows, big white eyes with pupils, nose, flat mouth.
line(X + 11, 6, X + 14, 7, BLACK); line(X + 11, 7, X + 14, 8, BLACK)
line(X + 17, 7, X + 20, 6, BLACK); line(X + 17, 8, X + 20, 7, BLACK)
for (const ex of [11, 17]) {
  rect(X + ex, 9, X + ex + 3, 12, WHITE)
  rect(X + ex + 1, 10, X + ex + 2, 11, BLACK)
}
rect(X + 15, 13, X + 16, 14, ORANGE)
set(X + 15, 15, BLACK); set(X + 16, 15, BLACK)
line(X + 13, 17, X + 18, 17, BLACK)
set(X + 13, 16, BLACK); set(X + 18, 16, BLACK)

// Left arm hanging down, right arm raising the bat.
line(X + 8, 19, X + 3, 26, BLACK)
rect(X + 2, 26, X + 3, 27, BROWN)
line(X + 23, 19, X + 27, 15, BLACK)

// Bat: handle in the right hand, barrel up top.
rect(X + 27, 0, X + 29, 10, ORANGE)
line(X + 26, 0, X + 26, 10, BLACK); line(X + 30, 0, X + 30, 10, BLACK)
line(X + 27, 0, X + 29, 0, BLACK)
rect(X + 28, 11, X + 28, 18, ORANGE)
set(X + 27, 11, BLACK); set(X + 29, 11, BLACK)
rect(X + 27, 14, X + 29, 15, BROWN)

// Stick legs and feet.
line(X + 13, 34, X + 13, 40, BLACK); line(X + 18, 34, X + 18, 40, BLACK)
line(X + 10, 41, X + 13, 41, BLACK); line(X + 18, 41, X + 21, 41, BLACK)

// Name in a 3x5 font, centered under the sprite.
const FONT = {
  T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'],
  N: ['110', '101', '101', '101', '101'],
  G: ['111', '100', '101', '101', '111'],
  S: ['111', '100', '111', '001', '111'],
  A: ['111', '101', '111', '101', '101'],
  H: ['101', '101', '111', '101', '101'],
  R: ['110', '101', '110', '101', '101'],
  ' ': ['000', '000', '000', '000', '000'],
}
const text = (str, y, c) => {
  const x0 = Math.round((56 - (str.length * 4 - 1)) / 2)
  ;[...str].forEach((ch, i) =>
    FONT[ch].forEach((row, dy) => [...row].forEach((b, dx) => b === '1' && set(x0 + i * 4 + dx, y + dy, c))))
}
text('TUNG TUNG TUNG', 45, BLACK)
text('SAHUR', 52, RED)

export const pixels = [...grid.values()]
export const width = 56
export const height = 57
