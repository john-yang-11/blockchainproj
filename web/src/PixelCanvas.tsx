import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
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

const MAX_SCALE = 64
/** Zoom level a click jumps to when you pick a pixel while zoomed out (r/place does the same). */
const FOCUS_SCALE = 20

// Palette as little-endian RGBA words, so the bitmap fill writes one Uint32 per pixel.
const PALETTE_U32 = PALETTE_RGB.map(([r, g, b]) => (255 << 24) | (b << 16) | (g << 8) | r)

export function PixelCanvas({ ref, colors, width, height, version, selected, previewColor, onSelect, onHover, onScale }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bitmapRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setViewRaw] = useState<View | null>(null)
  const [hover, setHover] = useState<Pt | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ moved: boolean; last: View; startX: number; startY: number; pinchDist?: number } | null>(null)
  const anim = useRef(0)
  const viewRef = useRef(view)
  viewRef.current = view

  const fitScale = useCallback(() => {
    const s = Math.min(size.w / width, size.h / height) * 0.92
    // Whole-number zoom keeps pixels evenly sized, but only round once that doesn't waste much screen.
    return s >= 3 ? Math.floor(s) : s
  }, [size, width, height])
  const minScale = useCallback(() => Math.min(1, fitScale() * 0.5), [fitScale])

  // Keep the middle of the screen over the board so it can never be flung out of sight.
  const clamp = useCallback(
    (v: View): View => {
      const scale = Math.min(MAX_SCALE, Math.max(minScale(), v.scale))
      const cx = size.w / 2
      const cy = size.h / 2
      return {
        scale,
        ox: Math.min(cx, Math.max(cx - width * scale, v.ox)),
        oy: Math.min(cy, Math.max(cy - height * scale, v.oy)),
      }
    },
    [size, width, height, minScale],
  )

  const setView = useCallback(
    (next: View | ((v: View) => View)) => {
      cancelAnimationFrame(anim.current)
      setViewRaw((v) => (v ? clamp(typeof next === 'function' ? next(v) : next) : v))
    },
    [clamp],
  )

  const fitView = useCallback((): View => {
    const scale = fitScale()
    return { scale, ox: (size.w - width * scale) / 2, oy: (size.h - height * scale) / 2 }
  }, [fitScale, size, width, height])

  /** Ease toward `target`, interpolating zoom logarithmically so it feels even. */
  const animateTo = useCallback(
    (target: View) => {
      cancelAnimationFrame(anim.current)
      const from = viewRef.current
      const to = clamp(target)
      if (!from) return setViewRaw(to)
      const t0 = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / 320)
        const e = 1 - Math.pow(1 - t, 3)
        const scale = from.scale * Math.pow(to.scale / from.scale, e)
        // Interpolate the board point at screen center, then rebuild offsets for this scale.
        const fx = (size.w / 2 - from.ox) / from.scale
        const fy = (size.h / 2 - from.oy) / from.scale
        const tx = (size.w / 2 - to.ox) / to.scale
        const ty = (size.h / 2 - to.oy) / to.scale
        const px = fx + (tx - fx) * e
        const py = fy + (ty - fy) * e
        setViewRaw({ scale, ox: size.w / 2 - px * scale, oy: size.h / 2 - py * scale })
        if (t < 1) anim.current = requestAnimationFrame(step)
      }
      anim.current = requestAnimationFrame(step)
    },
    [clamp, size],
  )

  const focusView = useCallback(
    (p: Pt, scale: number): View => ({
      scale,
      ox: size.w / 2 - (p.x + 0.5) * scale,
      oy: size.h / 2 - (p.y + 0.5) * scale,
    }),
    [size],
  )

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) =>
      setView((v) => {
        const scale = Math.min(MAX_SCALE, Math.max(minScale(), v.scale * factor))
        const k = scale / v.scale
        return { scale, ox: cx - (cx - v.ox) * k, oy: cy - (cy - v.oy) * k }
      }),
    [setView, minScale],
  )

  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (f) =>
        view && animateTo({ scale: view.scale * f, ox: size.w / 2 - (size.w / 2 - view.ox) * f, oy: size.h / 2 - (size.h / 2 - view.oy) * f }),
      fit: () => animateTo(fitView()),
      focus: (p) => view && animateTo(focusView(p, Math.max(view.scale, FOCUS_SCALE))),
      centerPixel: () => {
        if (!view) return null
        const x = Math.floor((size.w / 2 - view.ox) / view.scale)
        const y = Math.floor((size.h / 2 - view.oy) / view.scale)
        return { x: Math.min(width - 1, Math.max(0, x)), y: Math.min(height - 1, Math.max(0, y)) }
      },
    }),
    [view, size, width, height, animateTo, fitView, focusView],
  )

  useEffect(() => {
    if (view) onScale(view.scale)
  }, [view, onScale])

  // Native-resolution bitmap of the board, rebuilt when pixels change.
  useEffect(() => {
    if (!width || !height) return
    let bmp = bitmapRef.current
    if (!bmp || bmp.width !== width || bmp.height !== height) {
      bmp = document.createElement('canvas')
      bmp.width = width
      bmp.height = height
      bitmapRef.current = bmp
    }
    const ctx = bmp.getContext('2d')!
    const img = ctx.createImageData(width, height)
    const out = new Uint32Array(img.data.buffer)
    for (let i = 0; i < out.length; i++) out[i] = PALETTE_U32[colors[i]] ?? PALETTE_U32[0]
    ctx.putImageData(img, 0, 0)
  }, [colors, width, height, version])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (size.w && !view) setViewRaw(fitView())
  }, [size, view, fitView])

  // Draw.
  useEffect(() => {
    const cv = canvasRef.current
    const bmp = bitmapRef.current
    if (!cv || !bmp || !view) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(size.w * dpr)
    cv.height = Math.round(size.h * dpr)
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    const { scale: s, ox, oy } = view

    // Board, lifted off the background with a soft shadow.
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.28)'
    ctx.shadowBlur = 24
    ctx.shadowOffsetY = 6
    ctx.fillStyle = '#fff'
    ctx.fillRect(ox, oy, width * s, height * s)
    ctx.restore()
    // Zoomed out, average pixels instead of dropping them so the overview doesn't shimmer.
    ctx.imageSmoothingEnabled = s < 1
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, ox, oy, width * s, height * s)
    ctx.imageSmoothingEnabled = false

    // Grid, only across the visible part of the board.
    if (s >= 12) {
      const x0 = Math.max(0, Math.floor(-ox / s))
      const x1 = Math.min(width, Math.ceil((size.w - ox) / s))
      const y0 = Math.max(0, Math.floor(-oy / s))
      const y1 = Math.min(height, Math.ceil((size.h - oy) / s))
      ctx.strokeStyle = `rgba(0,0,0,${Math.min(0.12, (s - 12) / 80 + 0.05)})`
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

    if (hover && s >= 4 && (!selected || hover.x !== selected.x || hover.y !== selected.y)) {
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(ox + hover.x * s) + 0.5, Math.round(oy + hover.y * s) + 0.5, Math.round(s) - 1, Math.round(s) - 1)
    }

    if (selected) {
      const px = ox + selected.x * s
      const py = oy + selected.y * s
      if (previewColor !== null) {
        ctx.fillStyle = PALETTE[previewColor]
        ctx.fillRect(px, py, s, s)
      }
      drawReticle(ctx, px, py, s)
    }
  }, [view, size, version, selected, previewColor, hover, width, height])

  const toPixel = (clientX: number, clientY: number): Pt | null => {
    const rect = canvasRef.current!.getBoundingClientRect()
    if (!view) return null
    const x = Math.floor((clientX - rect.left - view.ox) / view.scale)
    const y = Math.floor((clientY - rect.top - view.oy) / view.scale)
    return x >= 0 && y >= 0 && x < width && y < height ? { x, y } : null
  }

  // Non-passive wheel listener so we can preventDefault page scroll.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = cv.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top)
    }
    cv.addEventListener('wheel', onWheel, { passive: false })
    return () => cv.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const pinchInfo = () => {
    const [a, b] = [...pointers.current.values()]
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2 - rect.left,
      cy: (a.y + b.y) / 2 - rect.top,
    }
  }

  const updateHover = (p: Pt | null) => {
    setHover((h) => (h?.x === p?.x && h?.y === p?.y ? h : p))
    onHover(p)
  }

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h }}
        onPointerDown={(e) => {
          if (!view) return
          cancelAnimationFrame(anim.current)
          e.currentTarget.setPointerCapture(e.pointerId)
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          if (pointers.current.size === 1) {
            gesture.current = { moved: false, last: view, startX: e.clientX, startY: e.clientY }
          } else if (pointers.current.size === 2 && gesture.current) {
            gesture.current.moved = true
            gesture.current.pinchDist = pinchInfo().dist
          }
        }}
        onPointerMove={(e) => {
          const g = gesture.current
          const prev = pointers.current.get(e.pointerId)
          if (g && prev) {
            if (pointers.current.size === 2 && g.pinchDist) {
              const before = pinchInfo()
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
              const after = pinchInfo()
              setView((v) => {
                const scale = Math.min(MAX_SCALE, Math.max(minScale(), v.scale * (after.dist / before.dist)))
                const k = scale / v.scale
                return {
                  scale,
                  ox: after.cx - (before.cx - v.ox) * k,
                  oy: after.cy - (before.cy - v.oy) * k,
                }
              })
            } else {
              const dx = e.clientX - prev.x
              const dy = e.clientY - prev.y
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
              if (Math.abs(e.clientX - g.startX) + Math.abs(e.clientY - g.startY) > 5) g.moved = true
              if (g.moved) setView((v) => ({ ...v, ox: v.ox + dx, oy: v.oy + dy }))
            }
          }
          if (e.pointerType === 'mouse') updateHover(g?.moved ? null : toPixel(e.clientX, e.clientY))
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId)
          const g = gesture.current
          if (pointers.current.size > 0) return
          gesture.current = null
          if (g && !g.moved && view) {
            const p = toPixel(e.clientX, e.clientY)
            if (p) {
              onSelect(p)
              if (view.scale < FOCUS_SCALE / 2) animateTo(focusView(p, FOCUS_SCALE))
            }
          }
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId)
          if (!pointers.current.size) gesture.current = null
        }}
        onPointerLeave={() => updateHover(null)}
      />
    </div>
  )
}

/** r/place-style reticle: four corner brackets around the pixel, black with a white halo. */
function drawReticle(ctx: CanvasRenderingContext2D, px: number, py: number, s: number) {
  const size = Math.max(s, 10)
  const x = px + s / 2 - size / 2
  const y = py + s / 2 - size / 2
  const pad = Math.max(3, size * 0.14)
  const arm = Math.max(4, size * 0.4)
  const l = x - pad
  const t = y - pad
  const r = x + size + pad
  const b = y + size + pad
  const path = () => {
    ctx.beginPath()
    ctx.moveTo(l, t + arm); ctx.lineTo(l, t); ctx.lineTo(l + arm, t)
    ctx.moveTo(r - arm, t); ctx.lineTo(r, t); ctx.lineTo(r, t + arm)
    ctx.moveTo(r, b - arm); ctx.lineTo(r, b); ctx.lineTo(r - arm, b)
    ctx.moveTo(l + arm, b); ctx.lineTo(l, b); ctx.lineTo(l, b - arm)
  }
  ctx.lineCap = 'square'
  ctx.lineJoin = 'miter'
  path()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(5, size * 0.12 + 3)
  ctx.stroke()
  path()
  ctx.strokeStyle = '#000'
  ctx.lineWidth = Math.max(2.5, size * 0.12)
  ctx.stroke()
}
