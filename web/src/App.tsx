import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletReadyState } from '@solana/wallet-adapter-base'
import { LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { PALETTE, cluster, clusterName, explorerUrl, programId } from './config'
import { PixelCanvas, type CanvasHandle, type Pt } from './PixelCanvas'
import { ACC_PLAYER, decodePlayer, placePixelIx, playerPda, priceFor, programError } from './solana'
import { errMsg, fetchPixelHistory, usePlace, type Placement, type PlaceState } from './usePlace'

type Drawer = 'activity' | 'leaders'
type TxState = { kind: 'idle' } | { kind: 'busy'; msg: string } | { kind: 'err'; msg: string }
type Toast = { id: number; msg: string; kind: 'ok' | 'err'; href?: string; leaving?: boolean }
type PushToast = (msg: string, kind?: Toast['kind'], href?: string) => void

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
const sol = (lamports: bigint | number) => {
  const n = Number(lamports) / LAMPORTS_PER_SOL
  return `${n === 0 ? '0' : n < 0.001 ? n.toPrecision(2) : Number(n.toPrecision(4))} SOL`
}
const fmt = (n: number) => n.toLocaleString('en-US')

const COLOR_NAMES = [
  'White', 'Light gray', 'Gray', 'Black', 'Pink', 'Red', 'Orange', 'Brown',
  'Yellow', 'Lime', 'Green', 'Cyan', 'Blue', 'Indigo', 'Magenta', 'Purple',
]

/** How long exit animations run before the element unmounts (matches the CSS). */
const EXIT_MS = 220

export default function App() {
  const place = usePlace()
  const { params } = place
  const canvas = useRef<CanvasHandle>(null)
  const [selected, setSelected] = useState<Pt | null>(null)
  const [hover, setHover] = useState<Pt | null>(null)
  const [scale, setScale] = useState(1)
  const [color, setColor] = useState(5)
  const [drawer, setDrawer] = useState<Drawer | null>(null)
  const [walletOpen, setWalletOpen] = useState(false)
  const { toasts, push } = useToasts()
  const cooldown = useCooldown(params?.cooldown ?? 0)
  const total = useTweenedNumber(place.totalPlacements)
  useLocalAirdrop(push)

  const drawerP = usePresence(drawer)
  const trayP = usePresence(params ? selected : null)

  const select = useCallback((p: Pt | null, focus = false) => {
    setSelected(p)
    if (p && focus) canvas.current?.focus(p)
  }, [])

  // Esc closes the topmost thing, arrow keys nudge the reticle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'Escape') {
        if (walletOpen) setWalletOpen(false)
        else if (drawer) setDrawer(null)
        else setSelected(null)
        return
      }
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
      if (d && selected && params) {
        e.preventDefault()
        select(
          {
            x: Math.min(params.width - 1, Math.max(0, selected.x + d[0])),
            y: Math.min(params.height - 1, Math.max(0, selected.y + d[1])),
          },
          true,
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer, selected, params, select, walletOpen])

  const coord = hover ?? selected
  const toggle = (d: Drawer) => setDrawer((cur) => (cur === d ? null : d))

  return (
    <div className="app">
      <div className="stage">
        {params && (
          <PixelCanvas
            ref={canvas}
            colors={place.colors}
            width={params.width}
            height={params.height}
            version={place.version}
            selected={selected}
            previewColor={selected ? color : null}
            onSelect={(p) => select(p)}
            onHover={setHover}
            onScale={setScale}
          />
        )}
        {place.status === 'loading' && (
          <div className="overlay">
            <div className="loader" aria-hidden>
              {PALETTE.slice(4, 13).map((c, i) => (
                <i key={c} style={{ background: c, animationDelay: `${(i % 3) * 90 + Math.floor(i / 3) * 90}ms` }} />
              ))}
            </div>
            <span>Reading the canvas from {clusterName}…</span>
          </div>
        )}
        {place.status === 'error' && (
          <div className="overlay error">
            <b>Couldn't load the canvas</b>
            <span>{place.error}</span>
          </div>
        )}
      </div>

      <header className="hud top">
        <div className="glass brand enter" style={{ animationDelay: '60ms' }}>
          <Logo />
          <div className="brand-text">
            <h1>OnChain Place</h1>
            <span className="sub">
              <i className={`live-dot ${place.status}`} />
              {cluster === 'devnet' ? 'Devnet' : 'Localnet'}
              {params && (
                <>
                  <span className="sep" />
                  <span className="num">{fmt(total)}</span>&nbsp;placed
                </>
              )}
            </span>
          </div>
        </div>

        {params && (
          <div className="glass coords enter" style={{ animationDelay: '120ms' }} aria-live="off">
            <span className="num">{coord ? `${coord.x}, ${coord.y}` : `${params.width} × ${params.height}`}</span>
            <span className="zoom">{scale >= 10 ? Math.round(scale) : scale.toFixed(1)}×</span>
          </div>
        )}

        <div className="top-right enter" style={{ animationDelay: '180ms' }}>
          <WalletButton onConnect={() => setWalletOpen(true)} />
          <div className="glass seg-icons">
            <button className={drawer === 'activity' ? 'on' : ''} onClick={() => toggle('activity')} title="Recent activity">
              <ActivityIcon /> <span className="label">Activity</span>
            </button>
            <button className={drawer === 'leaders' ? 'on' : ''} onClick={() => toggle('leaders')} title="Leaderboard">
              <TrophyIcon /> <span className="label">Leaders</span>
            </button>
          </div>
        </div>
      </header>

      {drawerP.item && (
        <aside className="glass drawer" data-leaving={drawerP.leaving || undefined}>
          <div className="drawer-head">
            <h2 key={drawerP.item} className="swap">{drawerP.item === 'activity' ? 'Recent activity' : 'Leaderboard'}</h2>
            <button className="icon-btn" onClick={() => setDrawer(null)} aria-label="Close">
              <CloseIcon />
            </button>
          </div>
          <div className="drawer-body" key={drawerP.item}>
            {drawerP.item === 'activity' ? (
              <Activity
                placements={place.placements}
                total={place.totalPlacements}
                onPick={(p) => {
                  select(p, true)
                  if (window.innerWidth < 760) setDrawer(null)
                }}
              />
            ) : (
              <Leaderboard refreshKey={place.totalPlacements} />
            )}
          </div>
        </aside>
      )}

      <div className="glass zoom-controls enter" style={{ animationDelay: '240ms' }}>
        <button onClick={() => canvas.current?.zoomBy(2)} aria-label="Zoom in" title="Zoom in"><PlusIcon /></button>
        <button onClick={() => canvas.current?.zoomBy(0.5)} aria-label="Zoom out" title="Zoom out"><MinusIcon /></button>
        <button onClick={() => canvas.current?.fit()} aria-label="Show whole canvas" title="Fit canvas"><FitIcon /></button>
      </div>

      <div className="hud bottom">
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`} data-leaving={t.leaving || undefined}>
              {t.kind === 'ok' ? <CheckIcon /> : <AlertIcon />}
              <span>{t.msg}</span>
              {t.href && (
                <a href={t.href} target="_blank" rel="noreferrer">
                  View <ExternalIcon />
                </a>
              )}
            </div>
          ))}
        </div>
        {params && trayP.item ? (
          <Tray
            place={place}
            selected={trayP.item}
            leaving={trayP.leaving}
            color={color}
            setColor={setColor}
            cooldown={cooldown}
            onConnect={() => setWalletOpen(true)}
            onClose={() => setSelected(null)}
            onPlaced={(msg, sig) => {
              setSelected(null)
              push(msg, 'ok', explorerUrl('tx', sig))
            }}
          />
        ) : (
          params && (
            <PlaceButton
              left={cooldown.left}
              total={params.cooldown}
              onClick={() => {
                const p = canvas.current?.centerPixel()
                if (p) select(p, true)
              }}
            />
          )
        )}
      </div>

      <WalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
    </div>
  )
}

// ---------------------------------------------------------------- hooks

/** Keeps the last non-null value mounted for EXIT_MS after it goes null, so it can animate out. */
function usePresence<T>(value: T | null, ms = EXIT_MS) {
  const [item, setItem] = useState<T | null>(value)
  if (value !== null && value !== item) setItem(value)
  useEffect(() => {
    if (value !== null) return
    const t = setTimeout(() => setItem(null), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return { item: value ?? item, leaving: value === null && item !== null }
}

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const push = useCallback<PushToast>((msg, kind = 'ok', href) => {
    const id = ++seq.current
    setToasts((l) => [...l.slice(-2), { id, msg, kind, href }])
    setTimeout(() => setToasts((l) => l.map((t) => (t.id === id ? { ...t, leaving: true } : t))), 4200)
    setTimeout(() => setToasts((l) => l.filter((t) => t.id !== id)), 4200 + EXIT_MS)
  }, [])
  return { toasts, push }
}

/** Counts smoothly toward `value` instead of jumping. */
function useTweenedNumber(value: number, ms = 900) {
  const [shown, setShown] = useState(value)
  const cur = useRef(value)
  useEffect(() => {
    const from = cur.current
    if (from === value) return
    let raf = 0
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms)
      cur.current = from + (value - from) * (1 - Math.pow(1 - t, 3))
      setShown(Math.round(cur.current))
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, ms])
  return shown
}

/** Wallet cooldown: read the on-chain Player account once, then count down locally. */
function useCooldown(cooldownSecs: number) {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  const [readyAt, setReadyAt] = useState(0)
  const refetch = useCallback(async () => {
    if (!publicKey) return setReadyAt(0)
    try {
      const info = await connection.getAccountInfo(playerPda(publicKey), 'confirmed')
      if (!info) return setReadyAt(0)
      // The program checks the cooldown against the chain clock, which can drift from this
      // machine's clock (badly, on a local validator), so measure the time left in chain time.
      const chainNow = await connection.getBlockTime(await connection.getSlot('confirmed'))
      const left = decodePlayer(info.data).lastPlaced + cooldownSecs - (chainNow ?? Date.now() / 1000)
      setReadyAt(Date.now() + left * 1000)
    } catch (e) {
      console.warn('cooldown read failed', e)
    }
  }, [connection, publicKey, cooldownSecs])
  useEffect(() => {
    refetch()
  }, [refetch])
  const now = useNow(readyAt > Date.now() ? 250 : 1000)
  return { left: Math.max(0, Math.ceil((readyAt - now) / 1000)), refetch }
}

function useBalance() {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  const [balance, setBalance] = useState<{ key: string; lamports: number } | null>(null)
  useEffect(() => {
    if (!publicKey) return
    const key = publicKey.toBase58()
    let live = true
    connection
      .getBalance(publicKey)
      .then((lamports) => live && setBalance({ key, lamports }))
      .catch(() => {})
    const sub = connection.onAccountChange(publicKey, (a) => setBalance({ key, lamports: a.lamports }), 'confirmed')
    return () => {
      live = false
      connection.removeAccountChangeListener(sub).catch(() => {})
    }
  }, [connection, publicKey])
  return publicKey && balance?.key === publicKey.toBase58() ? balance.lamports : null
}

/** Localnet: top up the connected wallet from the validator's faucet so it can pay for pixels. */
function useLocalAirdrop(push: PushToast) {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  useEffect(() => {
    if (cluster !== 'localnet' || !publicKey) return
    connection
      .getBalance(publicKey)
      .then(async (bal) => {
        if (bal < LAMPORTS_PER_SOL / 2) {
          const sig = await connection.requestAirdrop(publicKey, 2 * LAMPORTS_PER_SOL)
          await connection.confirmTransaction(sig, 'confirmed')
        }
      })
      .catch((e) => push(`Airdrop failed: ${errMsg(e)}`, 'err'))
  }, [connection, publicKey, push])
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

// ---------------------------------------------------------------- bottom dock

function PlaceButton({ left, total, onClick }: { left: number; total: number; onClick: () => void }) {
  const cooling = left > 0
  const frac = total > 0 ? Math.min(1, left / total) : 0
  const C = 2 * Math.PI * 9
  return (
    <button className={`place-btn${cooling ? ' cooling' : ''}`} disabled={cooling} onClick={onClick}>
      {cooling ? (
        <>
          <svg className="ring" width="24" height="24" viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="9" className="arc" style={{ strokeDasharray: C, strokeDashoffset: C * (1 - frac) }} />
          </svg>
          <span className="num">{fmtClock(left)}</span>
        </>
      ) : (
        <>
          <BrushIcon /> Place a pixel
        </>
      )}
    </button>
  )
}

function Tray({
  place,
  selected,
  leaving,
  color,
  setColor,
  cooldown,
  onConnect,
  onClose,
  onPlaced,
}: {
  place: PlaceState
  selected: Pt
  leaving: boolean
  color: number
  setColor: (c: number) => void
  cooldown: ReturnType<typeof useCooldown>
  onConnect: () => void
  onClose: () => void
  onPlaced: (msg: string, signature: string) => void
}) {
  const { connection } = useConnection()
  const { publicKey, sendTransaction, signTransaction } = useWallet()
  const [tx, setTx] = useState<TxState>({ kind: 'idle' })
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<Placement[] | null>(null)
  const params = place.params!
  const id = selected.y * params.width + selected.x
  const pxKey = `${selected.x},${selected.y}`

  // Per-pixel state resets when the reticle moves, but the tray itself stays put (no re-entrance).
  const [prevKey, setPrevKey] = useState(pxKey)
  if (prevKey !== pxKey) {
    setPrevKey(pxKey)
    setHistory(null)
    setShowHistory(false)
    if (tx.kind === 'err') setTx({ kind: 'idle' })
  }

  // Refetch this pixel's history whenever a live placement lands on it.
  const liveHits = useMemo(
    () => place.placements.filter((p) => p.x === selected.x && p.y === selected.y).length,
    [place.placements, selected.x, selected.y],
  )
  useEffect(() => {
    let stale = false
    fetchPixelHistory(connection, selected.x, selected.y, params.width)
      .then((h) => !stale && setHistory(h))
      .catch((e) => console.warn('pixel history failed', e))
    return () => {
      stale = true
    }
  }, [connection, selected.x, selected.y, params.width, liveHits])

  // The overwrite tier is stored on-chain in each pixel's byte, so it comes with the canvas load.
  const count = place.tiers[id] ?? 0
  const price = priceFor(params, count)
  const current = place.colors[id]

  async function paint() {
    if (!publicKey) return
    try {
      setTx({ kind: 'busy', msg: 'Simulating…' })
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(
        placePixelIx(publicKey, params.width, selected.x, selected.y, color),
      )
      // Simulate first so program errors (cooldown, bounds) come back readable instead of as a wallet failure.
      const sim = await connection.simulateTransaction(transaction)
      if (sim.value.err) throw new Error(programError(sim.value.logs) ?? JSON.stringify(sim.value.err))
      setTx({ kind: 'busy', msg: 'Approve in wallet…' })
      // Prefer sign-only and send through our own RPC: wallets that sign *and* send (MetaMask's Solana
      // account) submit to whatever cluster the wallet is on, which is often mainnet, not ours.
      const signature = signTransaction
        ? await connection.sendRawTransaction((await signTransaction(transaction)).serialize())
        : await sendTransaction(transaction, connection)
      setTx({ kind: 'busy', msg: 'Confirming…' })
      const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
      if (res.value.err) throw new Error('Transaction failed')
      cooldown.refetch()
      setTx({ kind: 'idle' })
      onPlaced(`Painted (${selected.x}, ${selected.y}) for ${sol(price)}`, signature)
    } catch (e) {
      setTx({ kind: 'err', msg: friendlyError(e) })
      cooldown.refetch()
    }
  }

  const busy = tx.kind === 'busy'
  const last = history?.[0]

  return (
    <div className="glass tray" data-leaving={leaving || undefined}>
      <div className="tray-head">
        <div className="tray-pixel" key={pxKey}>
          <div className="swap-chips" aria-hidden>
            <i className="chip" style={{ background: PALETTE[current] }} />
            <ArrowIcon />
            <i key={color} className="chip next" style={{ background: PALETTE[color] }} />
          </div>
          <div className="tray-meta">
            <b className="num">
              {selected.x}, {selected.y}
            </b>
            <span className="muted">
              {count === 0
                ? 'Never painted'
                : `Painted ${count === 15 ? '15+' : count}×${last ? ` · last by ${short(last.painter)}` : ''}`}
            </span>
          </div>
        </div>
        {!!history?.length && (
          <button className={`chip-btn${showHistory ? ' on' : ''}`} onClick={() => setShowHistory((s) => !s)}>
            History <span className="count">{history.length}</span>
            <ChevronIcon />
          </button>
        )}
      </div>

      <Collapse open={showHistory && !!history?.length}>
        <ul className="feed history">
          {history?.map((p, i) => <FeedItem key={`${p.signature}:${p.x}:${p.y}`} p={p} i={i} />)}
        </ul>
      </Collapse>

      <Palette color={color} setColor={setColor} />

      <div className="tray-actions">
        <button className="round" onClick={onClose} aria-label="Cancel" title="Cancel (Esc)">
          <CloseIcon />
        </button>
        {!publicKey ? (
          <button className="confirm" onClick={onConnect}>
            <WalletIcon /> Connect wallet to paint
          </button>
        ) : (
          <button className="confirm" disabled={busy || cooldown.left > 0} onClick={paint}>
            <span className="confirm-inner" key={cooldown.left > 0 ? 'cool' : busy ? tx.msg : 'go'}>
              {cooldown.left > 0 ? (
                <>
                  <ClockIcon /> Ready in <span className="num">{fmtClock(cooldown.left)}</span>
                </>
              ) : busy ? (
                <>
                  <span className="spinner" /> {tx.msg}
                </>
              ) : (
                <>
                  Paint for <span className="num">{sol(price)}</span>
                </>
              )}
            </span>
          </button>
        )}
      </div>
      {tx.kind === 'err' && (
        <p className="tx-err" key={tx.msg}>
          <AlertIcon /> {tx.msg}
        </p>
      )}
      <p className="fine">
        {sol(params.basePrice)} to start, +{sol(params.priceIncrement)} each repaint · one pixel every {fmtClock(params.cooldown)}
      </p>
    </div>
  )
}

/** Palette with a selection ring that glides between swatches. */
function Palette({ color, setColor }: { color: number; setColor: (c: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLSpanElement>(null)
  const place = useCallback(() => {
    const el = wrap.current?.children[color + 1] as HTMLElement | undefined
    const r = ring.current
    if (!el || !r) return
    r.style.transform = `translate(${el.offsetLeft}px, ${el.offsetTop}px)`
    r.style.width = `${el.offsetWidth}px`
    r.style.height = `${el.offsetHeight}px`
  }, [color])
  useLayoutEffect(place, [place])
  useEffect(() => {
    const ro = new ResizeObserver(place)
    if (wrap.current) ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [place])

  return (
    <div className="palette" role="radiogroup" aria-label="Color" ref={wrap}>
      <span className="palette-ring" ref={ring} aria-hidden />
      {PALETTE.map((hex, i) => (
        <button
          key={hex}
          role="radio"
          aria-checked={i === color}
          className={i === color ? 'swatch on' : 'swatch'}
          style={{ background: hex }}
          onClick={() => setColor(i)}
          title={COLOR_NAMES[i]}
          aria-label={COLOR_NAMES[i]}
        />
      ))}
    </div>
  )
}

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`collapse${open ? ' open' : ''}`} aria-hidden={!open}>
      <div>{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------- drawer content

function Activity({ placements, total, onPick }: { placements: Placement[]; total: number; onPick: (p: Pt) => void }) {
  // `placements` is oldest first (backfill, then live), so the newest are at the end.
  const recent = useMemo(() => placements.slice(-100).reverse(), [placements])
  useNow(15_000) // keep "2m ago" fresh
  if (!recent.length)
    return <Empty>{total > 0 ? 'New placements will show up here live.' : 'No pixels placed yet. Be the first.'}</Empty>
  return (
    <ul className="feed">
      {recent.map((p, i) => (
        <FeedItem key={`${p.signature}:${p.x}:${p.y}`} p={p} i={i} onClick={() => onPick(p)} showCoords />
      ))}
    </ul>
  )
}

function FeedItem({ p, i, onClick, showCoords }: { p: Placement; i: number; onClick?: () => void; showCoords?: boolean }) {
  return (
    <li onClick={onClick} className={onClick ? 'clickable' : ''} style={{ '--i': Math.min(i, 14) } as React.CSSProperties}>
      <i className="dot" style={{ background: PALETTE[p.color] }} />
      <div className="feed-main">
        <span className="addr">{short(p.painter)}</span>
        <span className="muted small">
          {showCoords && (
            <span className="num">
              {p.x}, {p.y} ·{' '}
            </span>
          )}
          {ago(p.timestamp)}
        </span>
      </div>
      <span className="price num">{sol(p.price)}</span>
      <a href={explorerUrl('tx', p.signature)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="View transaction" className="ext">
        <ExternalIcon />
      </a>
    </li>
  )
}

type LeaderRow = { addr: string; placed: number; spent: bigint }

function Leaderboard({ refreshKey }: { refreshKey: number }) {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  const [sortBy, setSortBy] = useState<'placed' | 'spent'>('placed')
  const [players, setPlayers] = useState<LeaderRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let stale = false
    // Every Player PDA owned by the program, found by its 8-byte account discriminator.
    connection
      .getProgramAccounts(programId, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(ACC_PLAYER) } }] })
      .then((accs) => {
        if (stale) return
        setFailed(false)
        setPlayers(
          accs.map(({ account }) => {
            const p = decodePlayer(account.data)
            return { addr: p.wallet.toBase58(), placed: p.placed, spent: p.spent }
          }),
        )
      })
      .catch((e) => {
        console.warn('leaderboard failed', e)
        if (!stale) setFailed(true)
      })
    return () => {
      stale = true
    }
  }, [connection, refreshKey])

  const rows = useMemo(
    () =>
      [...(players ?? [])]
        .sort((a, b) => (sortBy === 'placed' ? b.placed - a.placed : b.spent > a.spent ? 1 : b.spent < a.spent ? -1 : 0))
        .slice(0, 50),
    [players, sortBy],
  )
  const top = rows[0]
  const me = publicKey?.toBase58()

  return (
    <>
      <div className="seg" data-at={sortBy === 'placed' ? 0 : 1}>
        <span className="seg-thumb" aria-hidden />
        <button className={sortBy === 'placed' ? 'on' : ''} onClick={() => setSortBy('placed')}>Most pixels</button>
        <button className={sortBy === 'spent' ? 'on' : ''} onClick={() => setSortBy('spent')}>Most spent</button>
      </div>
      {players === null && failed ? (
        <Empty>Couldn't reach the RPC for the leaderboard. Try again in a moment.</Empty>
      ) : players === null ? (
        <ul className="leaders">
          {Array.from({ length: 6 }, (_, i) => <li key={i} className="skeleton" />)}
        </ul>
      ) : !rows.length ? (
        <Empty>No players yet.</Empty>
      ) : (
        <ol className="leaders" key={sortBy}>
          {rows.map((r, i) => {
            const share = sortBy === 'placed' ? r.placed / Math.max(1, top.placed) : Number(r.spent) / Math.max(1, Number(top.spent))
            return (
              <li key={r.addr} className={r.addr === me ? 'me' : ''} style={{ '--i': Math.min(i, 14), '--w': share } as React.CSSProperties}>
                <span className="bar" aria-hidden />
                <span className={`rank r${i + 1}`}>{i + 1}</span>
                <Identicon addr={r.addr} />
                <span className="addr">
                  {short(r.addr)}
                  {r.addr === me && <span className="you">you</span>}
                </span>
                <span className="price num">{sortBy === 'placed' ? `${fmt(r.placed)} px` : sol(r.spent)}</span>
              </li>
            )
          })}
        </ol>
      )}
    </>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden>
        {[5, 8, 10, 12].map((c) => <i key={c} style={{ background: PALETTE[c] }} />)}
      </div>
      <p className="muted">{children}</p>
    </div>
  )
}

// ---------------------------------------------------------------- wallet

function WalletButton({ onConnect }: { onConnect: () => void }) {
  const { publicKey, disconnect, wallet, connecting } = useWallet()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const menu = usePresence(open && publicKey ? true : null)
  const balance = useBalance()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  if (!publicKey) {
    return (
      <button className="glass wallet-btn connect" onClick={onConnect} disabled={connecting}>
        {connecting ? <span className="spinner" /> : <WalletIcon />}
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>
    )
  }
  const addr = publicKey.toBase58()
  return (
    <div className="wallet-anchor" ref={ref}>
      <button className={`glass wallet-btn${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)}>
        <Identicon addr={addr} />
        <span className="num">{short(addr)}</span>
        <ChevronIcon />
      </button>
      {menu.item && (
        <div className="glass popover" data-leaving={menu.leaving || undefined}>
          <div className="pop-head">
            <Identicon addr={addr} size={36} />
            <div>
              <b className="num">{short(addr)}</b>
              <span className="muted small">{wallet?.adapter.name}</span>
            </div>
          </div>
          <div className="balance">
            <span className="muted small">Balance</span>
            <b className="num">{balance === null ? '—' : sol(balance)}</b>
          </div>
          <button
            className="menu-item"
            onClick={() => {
              navigator.clipboard?.writeText(addr).catch(() => {})
              setCopied(true)
              setTimeout(() => setCopied(false), 1400)
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : 'Copy address'}
          </button>
          <a className="menu-item" href={explorerUrl('address', addr)} target="_blank" rel="noreferrer">
            <ExternalIcon /> View on explorer
          </a>
          {cluster === 'devnet' && (
            <a className="menu-item" href="https://faucet.solana.com" target="_blank" rel="noreferrer">
              <DropIcon /> Get devnet SOL
            </a>
          )}
          <button
            className="menu-item danger"
            onClick={() => {
              setOpen(false)
              disconnect()
            }}
          >
            <LogoutIcon /> Disconnect
          </button>
        </div>
      )}
    </div>
  )
}

function WalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wallets, select, publicKey, connecting, wallet } = useWallet()
  const shown = usePresence(open ? true : null)

  // Close once a wallet is connected.
  useEffect(() => {
    if (open && publicKey) onClose()
  }, [open, publicKey, onClose])

  if (!shown.item) return null
  const usable = wallets.filter(
    (w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable,
  )
  return (
    <div className="modal-root" data-leaving={shown.leaving || undefined}>
      <div className="backdrop" onClick={onClose} />
      <div className="glass modal" role="dialog" aria-modal="true" aria-label="Connect a wallet">
        <div className="modal-head">
          <h2>Connect a wallet</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <p className="muted small">Paint on {clusterName}. Every pixel is a transaction to the program.</p>
        <div className="wallet-list">
          {usable.map((w, i) => {
            const busy = connecting && wallet?.adapter.name === w.adapter.name
            return (
              <button
                key={w.adapter.name}
                className="wallet-row"
                style={{ '--i': i } as React.CSSProperties}
                disabled={connecting}
                onClick={() => select(w.adapter.name) /* autoConnect connects as soon as a wallet is selected */}
              >
                <img src={w.adapter.icon} alt="" width={32} height={32} />
                <span>{w.adapter.name === 'Burner Wallet' ? 'Local burner wallet' : w.adapter.name}</span>
                {busy ? <span className="spinner" /> : <span className="tag">{w.adapter.name === 'Burner Wallet' ? 'localnet' : 'Detected'}</span>}
              </button>
            )
          })}
          {!usable.length && (
            <a className="wallet-row" href="https://phantom.com/download" target="_blank" rel="noreferrer">
              <span className="install-icon"><WalletIcon /></span>
              <span>No wallet found. Install Phantom</span>
              <ExternalIcon />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

/** A 5×5 mirrored pixel avatar from the address bytes, in palette colors. */
function Identicon({ addr, size = 22 }: { addr: string; size?: number }) {
  const { fg, cells } = useMemo(() => {
    let bytes: Uint8Array
    try {
      bytes = bs58.decode(addr)
    } catch {
      bytes = new Uint8Array(32)
    }
    const cells: [number, number][] = []
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++)
        if (bytes[1 + y * 3 + x] & 1) {
          cells.push([x, y])
          if (x < 2) cells.push([4 - x, y])
        }
    return { fg: PALETTE[4 + (bytes[0] % 12)], cells }
  }, [addr])
  return (
    <svg className="identicon" width={size} height={size} viewBox="-1 -1 7 7" shapeRendering="crispEdges" aria-hidden>
      <rect x="-1" y="-1" width="7" height="7" fill="currentColor" opacity="0.08" />
      {cells.map(([x, y]) => <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" fill={fg} />)}
    </svg>
  )
}

function Logo() {
  return (
    <svg className="logo" width="32" height="32" viewBox="0 0 4 4" shapeRendering="crispEdges" aria-hidden>
      <rect width="2" height="2" fill="#E50000" />
      <rect x="2" width="2" height="2" fill="#0083C7" />
      <rect y="2" width="2" height="2" fill="#E5D900" />
      <rect x="2" y="2" width="2" height="2" fill="#02BE01" />
    </svg>
  )
}

// ---------------------------------------------------------------- icons + utils

const svg = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
const CloseIcon = () => <svg {...svg}><path d="M6 6l12 12M18 6L6 18" /></svg>
const CheckIcon = () => <svg {...svg}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
const ClockIcon = () => <svg {...svg}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
const ActivityIcon = () => <svg {...svg}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
const TrophyIcon = () => <svg {...svg}><path d="M8 4h8v5a4 4 0 0 1-8 0V4zM8 6H4v1a3 3 0 0 0 4 3M16 6h4v1a3 3 0 0 1-4 3M12 13v4M8 20h8M10 17h4" /></svg>
const FitIcon = () => <svg {...svg}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
const PlusIcon = () => <svg {...svg}><path d="M12 5v14M5 12h14" /></svg>
const MinusIcon = () => <svg {...svg}><path d="M5 12h14" /></svg>
const ArrowIcon = () => <svg {...svg} width={14} height={14}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
const ChevronIcon = () => <svg {...svg} width={14} height={14} className="chev"><path d="M6 9l6 6 6-6" /></svg>
const ExternalIcon = () => <svg {...svg} width={14} height={14}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
const CopyIcon = () => <svg {...svg}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></svg>
const LogoutIcon = () => <svg {...svg}><path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11" /></svg>
const WalletIcon = () => <svg {...svg}><path d="M4 7a2 2 0 0 1 2-2h12v4M4 7v10a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2z" /><circle cx="16" cy="14" r="1.2" fill="currentColor" /></svg>
const DropIcon = () => <svg {...svg}><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" /></svg>
const AlertIcon = () => <svg {...svg}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>
const BrushIcon = () => <svg {...svg}><rect x="4" y="4" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" /><rect x="13" y="13" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" opacity="0.55" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /></svg>

function fmtClock(s: number) {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function ago(unix: number) {
  if (!unix) return 'just now'
  const s = Math.max(0, Date.now() / 1000 - unix)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function friendlyError(e: unknown): string {
  const msg = errMsg(e)
  if (/CooldownActive/.test(msg)) return 'Cooldown still active. Wait a bit.'
  if (/User rejected|denied/i.test(msg)) return 'Transaction rejected in wallet.'
  if (/insufficient (funds|lamports)|AccountNotFound|no record of a prior credit/i.test(msg)) return 'Not enough devnet SOL for the pixel price + fee. Get some free at faucet.solana.com.'
  return msg
}
