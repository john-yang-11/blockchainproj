import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { PALETTE, PALETTE_RGB } from './config'

export type Pt = { x: number; y: number }

/** Imperative controls for the HUD buttons outside the canvas. */
export type CanvasHandle = {
  zoomBy: (factor: number) => void
  fit: () => void
  /** Pan and zoom so pixel `p` sits in the middle of the screen. */
  focus: (p: Pt) => void
  /** The pixel currently under the middle of the screen. */
  centerPixel: () => Pt | null
}

type Props = {
  ref?: Ref<CanvasHandle>
  colors: Uint8Array
  width: number
  height: number
  version: number
  selected: Pt | null
  previewColor: number | null
  onSelect: (p: Pt) => void
  onHover: (p: Pt | null) => void
  onScale: (scale: number) => void
}

type View = { scale: number; ox: number; oy: number }
type Motion =
  | { kind: 'tween'; from: View; to: View; t0: number; dur: number }
  | { kind: 'zoom'; target: number; cx: number; cy: number }
  | { kind: 'fling'; vx: number; vy: number }
type Flash = { x: number; y: number; t0: number; color: number }
type Sample = { x: number; y: number; t: number }

const MAX_SCALE = 64
/** Zoom level a click jumps to when you pick a pixel while zoomed out (r/place does the same). */
const FOCUS_SCALE = 20
/** How long the ripple around a freshly painted pixel lasts. */
const FLASH_MS = 1100

// Palette as little-endian RGBA words, so the bitmap fill writes one Uint32 per pixel.
const PALETTE_U32 = PALETTE_RGB.map(([r, g, b]) => (255 << 24) | (b << 16) | (g << 8) | r)
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/**
 * The board. Everything that moves (view, reticle, ripples) lives in refs and is drawn from one
 * requestAnimationFrame loop that only runs while something is animating, so React never
 * re-renders per frame.
 */
export function PixelCanvas({ ref, colors, width, height, version, selected, previewColor, onSelect, onHover, onScale }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bitmap = useRef<HTMLCanvasElement | null>(null)
  const prevColors = useRef<Uint8Array | null>(null)
  const dims = useRef({ width, height })
  const size = useRef({ w: 0, h: 0 })
  const view = useRef<View | null>(null)
  const motion = useRef<Motion | null>(null)
  const hover = useRef<Pt | null>(null)
  const flashes = useRef<Flash[]>([])
  const reticle = useRef({ x: 0, y: 0, alpha: 0, pop: 0 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ moved: boolean; startX: number; startY: number; pinchDist?: number; samples: Sample[] } | null>(null)
  const raf = useRef(0)
  const lastT = useRef(0)
  const reported = useRef(0)
  const live = useRef({ selected, previewColor, onSelect, onHover, onScale })
  live.current = { selected, previewColor, onSelect, onHover, onScale }
  dims.current = { width, height }
  const [ready, setReady] = useState(false)

  // ---------- view math (reads refs only, so stale closures are harmless)

  const fitScale = () => {
    const { w, h } = size.current
    const s = Math.min(w / dims.current.width, h / dims.current.height) * 0.86
    // Whole-number zoom keeps pixels evenly sized, but only round once that doesn't waste much screen.
    return s >= 3 ? Math.floor(s) : s
  }
  const minScale = () => Math.min(1, fitScale() * 0.5)
  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(minScale(), s))

  // Keep the middle of the screen over the board so it can never be flung out of sight.
  const clamp = (v: View): View => {
    const { w, h } = size.current
    const scale = clampScale(v.scale)
    return {
      scale,
      ox: Math.min(w / 2, Math.max(w / 2 - dims.current.width * scale, v.ox)),
      oy: Math.min(h / 2, Math.max(h / 2 - dims.current.height * scale, v.oy)),
    }
  }

  const fitView = (): View => {
    const scale = fitScale()
    const { w, h } = size.current
    return { scale, ox: (w - dims.current.width * scale) / 2, oy: (h - dims.current.height * scale) / 2 }
  }

  const focusView = (p: Pt, scale: number): View => ({
    scale,
    ox: size.current.w / 2 - (p.x + 0.5) * scale,
    oy: size.current.h / 2 - (p.y + 0.5) * scale,
  })

  const requestDraw = () => {
    if (!raf.current) raf.current = requestAnimationFrame(frame)
  }

  const tweenTo = (to: View, dur = 520) => {
    const from = view.current
    if (!from || reducedMotion()) {
      view.current = clamp(to)
      motion.current = null
    } else motion.current = { kind: 'tween', from, to: clamp(to), t0: performance.now(), dur }
    requestDraw()
  }

  const zoomTo = (target: number, cx: number, cy: number) => {
    motion.current = { kind: 'zoom', target: clampScale(target), cx, cy }
    requestDraw()
  }

  // ---------- animation loop

  function frame(now: number) {
    raf.current = 0
    const dt = lastT.current ? Math.min(64, now - lastT.current) : 16
    lastT.current = now
    let busy = stepMotion(now, dt)
    busy = stepReticle(dt) || busy
    busy = draw(now) || busy
    if (busy) requestDraw()
    else lastT.current = 0
  }

  function stepMotion(now: number, dt: number): boolean {
    const m = motion.current
    const v = view.current
    if (!m || !v) return false
    const { w, h } = size.current
    if (m.kind === 'tween') {
      const t = Math.max(0, Math.min(1, (now - m.t0) / m.dur))
      const e = 1 - Math.pow(1 - t, 4)
      const { from, to } = m
      // Zoom logarithmically and move the board point at screen center, so it feels even.
      const scale = from.scale * Math.pow(to.scale / from.scale, e)
      const fx = (w / 2 - from.ox) / from.scale
      const fy = (h / 2 - from.oy) / from.scale
      const tx = (w / 2 - to.ox) / to.scale
      const ty = (h / 2 - to.oy) / to.scale
      const px = fx + (tx - fx) * e
      const py = fy + (ty - fy) * e
      view.current = { scale, ox: w / 2 - px * scale, oy: h / 2 - py * scale }
      if (t >= 1) motion.current = null
    } else if (m.kind === 'zoom') {
      // Ease the scale toward the wheel's target, keeping the point under the cursor fixed.
      const ratio = m.target / v.scale
      const done = Math.abs(Math.log(ratio)) < 0.002
      const scale = done ? m.target : v.scale * Math.pow(ratio, 1 - Math.exp(-dt / 70))
      const k = scale / v.scale
      view.current = clamp({ scale, ox: m.cx - (m.cx - v.ox) * k, oy: m.cy - (m.cy - v.oy) * k })
      if (done) motion.current = null
    } else {
      // Momentum after a drag, with iOS-like friction. Stops on the edges.
      const want = { scale: v.scale, ox: v.ox + m.vx * dt, oy: v.oy + m.vy * dt }
      const got = clamp(want)
      if (got.ox !== want.ox) m.vx = 0
      if (got.oy !== want.oy) m.vy = 0
      const decay = Math.exp(-dt / 325)
      m.vx *= decay
      m.vy *= decay
      view.current = got
      if (Math.hypot(m.vx, m.vy) < 0.015) motion.current = null
    }
    return motion.current !== null
  }

  function stepReticle(dt: number): boolean {
    const r = reticle.current
    const sel = live.current.selected
    if (sel) {
      if (r.alpha === 0) {
        r.x = sel.x
        r.y = sel.y
        r.pop = reducedMotion() ? 0 : 1
      } else {
        const a = 1 - Math.exp(-dt / 45)
        r.x += (sel.x - r.x) * a
        r.y += (sel.y - r.y) * a
        if (Math.abs(sel.x - r.x) < 0.01 && Math.abs(sel.y - r.y) < 0.01) {
          r.x = sel.x
          r.y = sel.y
        }
      }
      r.alpha = Math.min(1, r.alpha + dt / 120)
    } else r.alpha = Math.max(0, r.alpha - dt / 160)
    r.pop = Math.max(0, r.pop - dt / 320)
    const moving = !!sel && (r.x !== sel.x || r.y !== sel.y)
    return moving || r.pop > 0 || (r.alpha > 0 && r.alpha < 1)
  }

  function draw(now: number): boolean {
    const cv = canvasRef.current
    const bmp = bitmap.current
    const v = view.current
    if (!cv || !bmp || !v) return false
    const { w, h } = size.current
    const { width, height } = dims.current
    const ctx = cv.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const { scale: s, ox, oy } = v

    // Board, lifted off the background with a soft two-layer shadow.
    ctx.save()
    ctx.fillStyle = '#fff'
    ctx.shadowColor = 'rgba(10,12,20,0.10)'
    ctx.shadowBlur = 6
    ctx.shadowOffsetY = 1
    ctx.fillRect(ox, oy, width * s, height * s)
    ctx.shadowColor = 'rgba(10,12,20,0.18)'
    ctx.shadowBlur = 48
    ctx.shadowOffsetY = 18
    ctx.fillRect(ox, oy, width * s, height * s)
    ctx.restore()
    // Zoomed out, average pixels instead of dropping them so the overview doesn't shimmer.
    ctx.imageSmoothingEnabled = s < 1
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, ox, oy, width * s, height * s)
    ctx.imageSmoothingEnabled = false

    // Grid fades in as you zoom, drawn only across the visible part of the board.
    const gridAlpha = Math.min(1, Math.max(0, (s - 9) / 18)) * 0.1
    if (gridAlpha > 0.004) {
      const x0 = Math.max(0, Math.floor(-ox / s))
      const x1 = Math.min(width, Math.ceil((w - ox) / s))
      const y0 = Math.max(0, Math.floor(-oy / s))
      const y1 = Math.min(height, Math.ceil((h - oy) / s))
      ctx.strokeStyle = `rgba(0,0,0,${gridAlpha})`
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = x0; x <= x1; x++) {
        const px = Math.round(ox + x * s) + 0.5
        ctx.moveTo(px, oy + y0 * s)
        ctx.lineTo(px, oy + y1 * s)
      }
      for (let y = y0; y <= y1; y++) {
        const py = Math.round(oy + y * s) + 0.5
        ctx.moveTo(ox + x0 * s, py)
        ctx.lineTo(ox + x1 * s, py)
      }
      ctx.stroke()
    }

    const sel = live.current.selected
    const hv = hover.current
    if (hv && s >= 4 && (!sel || hv.x !== sel.x || hv.y !== sel.y)) {
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(ox + hv.x * s) + 0.5, Math.round(oy + hv.y * s) + 0.5, Math.round(s) - 1, Math.round(s) - 1)
    }

    const preview = live.current.previewColor
    if (sel && preview !== null) {
      ctx.fillStyle = PALETTE[preview]
      ctx.fillRect(ox + sel.x * s, oy + sel.y * s, s, s)
    }

    // Ripples where other people (or you) just painted.
    flashes.current = flashes.current.filter((f) => now - f.t0 < FLASH_MS)
    for (const f of flashes.current) {
      const p = Math.max(0, (now - f.t0) / FLASH_MS)
      const e = 1 - Math.pow(1 - p, 3)
      const cx = ox + (f.x + 0.5) * s
      const cy = oy + (f.y + 0.5) * s
      if (cx < -60 || cy < -60 || cx > w + 60 || cy > h + 60) continue
      const r = Math.max(s * 0.7, 3) + e * Math.max(16, s * 1.4)
      ctx.globalAlpha = (1 - p) * 0.9
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.lineWidth = 4
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.stroke()
      ctx.lineWidth = 2
      ctx.strokeStyle = f.color < 3 ? '#111318' : PALETTE[f.color]
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    const r = reticle.current
    if (r.alpha > 0) {
      const pop = r.pop * r.pop
      drawReticle(ctx, ox + (r.x + 0.5) * s, oy + (r.y + 0.5) * s, s, r.alpha, 1 + pop * 0.9)
    }

    // The dotted stage moves with the board, so panning feels physical.
    const wrap = wrapRef.current
    if (wrap) wrap.style.backgroundPosition = `${ox}px ${oy}px`

    if (Math.abs(Math.log(s / (reported.current || 1))) > 0.005) {
      reported.current = s
      live.current.onScale(s)
    }
    return flashes.current.length > 0
  }

  // ---------- setup

  const tryInit = () => {
    if (view.current || !size.current.w || !bitmap.current) return
    const fit = fitView()
    if (reducedMotion()) view.current = fit
    else {
      const s0 = fit.scale * 0.7
      const { w, h } = size.current
      view.current = { scale: s0, ox: (w - dims.current.width * s0) / 2, oy: (h - dims.current.height * s0) / 2 + 30 }
      motion.current = { kind: 'tween', from: view.current, to: fit, t0: performance.now() + 120, dur: 1100 }
    }
    setReady(true)
    requestDraw()
  }

  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (f) => {
        const v = view.current
        if (!v) return
        const m = motion.current
        const base = m?.kind === 'zoom' ? m.target : v.scale
        zoomTo(base * f, size.current.w / 2, size.current.h / 2)
      },
      fit: () => tweenTo(fitView(), 650),
      focus: (p) => view.current && tweenTo(focusView(p, Math.max(view.current.scale, FOCUS_SCALE))),
      centerPixel: () => {
        const v = view.current
        if (!v) return null
        const x = Math.floor((size.current.w / 2 - v.ox) / v.scale)
        const y = Math.floor((size.current.h / 2 - v.oy) / v.scale)
        return { x: Math.min(dims.current.width - 1, Math.max(0, x)), y: Math.min(dims.current.height - 1, Math.max(0, y)) }
      },
    }),
    [],
  )

  // Native-resolution bitmap of the board, rebuilt when pixels change. Pixels that changed since
  // the last build get a ripple.
  useEffect(() => {
    if (!width || !height) return
    let bmp = bitmap.current
    if (!bmp || bmp.width !== width || bmp.height !== height) {
      bmp = document.createElement('canvas')
      bmp.width = width
      bmp.height = height
      bitmap.current = bmp
    }
    const ctx = bmp.getContext('2d')!
    const img = ctx.createImageData(width, height)
    const out = new Uint32Array(img.data.buffer)
    for (let i = 0; i < out.length; i++) out[i] = PALETTE_U32[colors[i]] ?? PALETTE_U32[0]
    ctx.putImageData(img, 0, 0)

    const prev = prevColors.current
    if (prev && prev.length === colors.length && !reducedMotion()) {
      const now = performance.now()
      for (let i = 0, n = 0; i < colors.length && n < 64; i++) {
        if (prev[i] !== colors[i]) {
          flashes.current.push({ x: i % width, y: Math.floor(i / width), t0: now, color: colors[i] })
          n++
        }
      }
    }
    // usePlace mutates its arrays in place, so keep a copy to diff against.
    prevColors.current = colors.slice()
    tryInit()
    requestDraw()
  }, [colors, width, height, version])

  useEffect(() => {
    requestDraw()
  }, [selected, previewColor])

  useEffect(() => {
    const el = wrapRef.current
    const cv = canvasRef.current
    if (!el || !cv) return
    const ro = new ResizeObserver(([e]) => {
      const { width: w, height: h } = e.contentRect
      const old = size.current
      size.current = { w, h }
      const dpr = window.devicePixelRatio || 1
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
      if (view.current) {
        const v = view.current
        view.current = clamp({ ...v, ox: v.ox + (w - old.w) / 2, oy: v.oy + (h - old.h) / 2 })
      }
      tryInit()
      draw(performance.now()) // resizing clears the canvas; repaint before the browser does
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf.current)
      raf.current = 0
    }
  }, [])

  // ---------- input

  const toPixel = (clientX: number, clientY: number): Pt | null => {
    const v = view.current
    if (!v) return null
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = Math.floor((clientX - rect.left - v.ox) / v.scale)
    const y = Math.floor((clientY - rect.top - v.oy) / v.scale)
    return x >= 0 && y >= 0 && x < dims.current.width && y < dims.current.height ? { x, y } : null
  }

  const setHover = (p: Pt | null) => {
    const h = hover.current
    if (h?.x === p?.x && h?.y === p?.y) return
    hover.current = p
    live.current.onHover(p)
    requestDraw()
  }

  // Non-passive wheel listener so we can preventDefault page scroll.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = view.current
      if (!v) return
      const rect = cv.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      if (e.ctrlKey) {
        // Trackpad pinch: many tiny events, apply directly so it tracks the fingers.
        motion.current = null
        const scale = clampScale(v.scale * Math.exp(-dy * 0.012))
        const k = scale / v.scale
        view.current = clamp({ scale, ox: cx - (cx - v.ox) * k, oy: cy - (cy - v.oy) * k })
        requestDraw()
      } else {
        const m = motion.current
        const base = m?.kind === 'zoom' ? m.target : v.scale
        zoomTo(base * Math.exp(-dy * 0.0022), cx, cy)
      }
    }
    cv.addEventListener('wheel', onWheel, { passive: false })
    return () => cv.removeEventListener('wheel', onWheel)
  }, [])

  const pinchInfo = () => {
    const [a, b] = [...pointers.current.values()]
    const rect = canvasRef.current!.getBoundingClientRect()
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2 - rect.left, cy: (a.y + b.y) / 2 - rect.top }
  }

  return (
    <div className={`canvas-wrap${ready ? ' ready' : ''}`} ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
          if (!view.current) return
          motion.current = null
          e.currentTarget.setPointerCapture(e.pointerId)
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          if (pointers.current.size === 1) {
            gesture.current = { moved: false, startX: e.clientX, startY: e.clientY, samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] }
          } else if (pointers.current.size === 2 && gesture.current) {
            gesture.current.moved = true
            gesture.current.pinchDist = pinchInfo().dist
          }
        }}
        onPointerMove={(e) => {
          const g = gesture.current
          const prev = pointers.current.get(e.pointerId)
          const v = view.current
          if (g && prev && v) {
            if (pointers.current.size === 2 && g.pinchDist) {
              const before = pinchInfo()
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
              const after = pinchInfo()
              const scale = clampScale(v.scale * (after.dist / before.dist))
              const k = scale / v.scale
              view.current = clamp({ scale, ox: after.cx - (before.cx - v.ox) * k, oy: after.cy - (before.cy - v.oy) * k })
              g.samples = []
              requestDraw()
            } else {
              const dx = e.clientX - prev.x
              const dy = e.clientY - prev.y
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
              if (Math.abs(e.clientX - g.startX) + Math.abs(e.clientY - g.startY) > 5) {
                if (!g.moved) wrapRef.current?.classList.add('dragging')
                g.moved = true
              }
              if (g.moved) {
                view.current = clamp({ ...v, ox: v.ox + dx, oy: v.oy + dy })
                g.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp })
                if (g.samples.length > 6) g.samples.shift()
                requestDraw()
              }
            }
          }
          if (e.pointerType === 'mouse') setHover(g?.moved ? null : toPixel(e.clientX, e.clientY))
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId)
          const g = gesture.current
          if (pointers.current.size > 0) return
          gesture.current = null
          wrapRef.current?.classList.remove('dragging')
          if (!g) return
          if (g.moved) {
            // Fling: carry the release velocity into a decaying glide.
            const recent = g.samples.filter((s) => e.timeStamp - s.t < 90)
            if (recent.length >= 2 && !reducedMotion()) {
              const a = recent[0]
              const b = recent[recent.length - 1]
              const dt = Math.max(8, b.t - a.t)
              const vx = (b.x - a.x) / dt
              const vy = (b.y - a.y) / dt
              if (Math.hypot(vx, vy) > 0.12) {
                motion.current = { kind: 'fling', vx, vy }
                requestDraw()
              }
            }
            return
          }
          const p = toPixel(e.clientX, e.clientY)
          if (p && view.current) {
            live.current.onSelect(p)
            if (view.current.scale < FOCUS_SCALE / 2) tweenTo(focusView(p, FOCUS_SCALE), 650)
          }
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId)
          if (!pointers.current.size) {
            gesture.current = null
            wrapRef.current?.classList.remove('dragging')
          }
        }}
        onPointerLeave={() => setHover(null)}
      />
    </div>
  )
}

/** r/place-style reticle: four corner brackets around the pixel, black with a white halo. */
function drawReticle(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, alpha: number, mul: number) {
  const size = Math.max(s, 10)
  const pad = Math.max(3, size * 0.14)
  const half = (size / 2 + pad) * mul
  const arm = Math.max(4, size * 0.4)
  const l = cx - half
  const t = cy - half
  const r = cx + half
  const b = cy + half
  const path = () => {
    ctx.beginPath()
    ctx.moveTo(l, t + arm); ctx.lineTo(l, t); ctx.lineTo(l + arm, t)
    ctx.moveTo(r - arm, t); ctx.lineTo(r, t); ctx.lineTo(r, t + arm)
    ctx.moveTo(r, b - arm); ctx.lineTo(r, b); ctx.lineTo(r - arm, b)
    ctx.moveTo(l + arm, b); ctx.lineTo(l, b); ctx.lineTo(l, b - arm)
  }
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineCap = 'square'
  ctx.lineJoin = 'miter'
  path()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(5, size * 0.12 + 3)
  ctx.stroke()
  path()
  ctx.strokeStyle = '#111318'
  ctx.lineWidth = Math.max(2.5, size * 0.12)
  ctx.stroke()
  ctx.restore()
}
