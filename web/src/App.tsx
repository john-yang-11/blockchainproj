import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useChainId,
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from 'wagmi'
import { formatEther, type Address } from 'viem'
import { placeAbi } from './abi'
import { PALETTE, chain, contractAddress } from './config'
import { PixelCanvas, type CanvasHandle, type Pt } from './PixelCanvas'
import { errMsg, fetchPixelHistory, usePlace, type Placement, type PlaceState } from './usePlace'

type Drawer = 'activity' | 'leaders' | null
type TxState = { kind: 'idle' } | { kind: 'busy'; msg: string } | { kind: 'err'; msg: string }
type Toast = { id: number; msg: string; kind: 'ok' | 'err' }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const eth = (wei: bigint) => {
  const s = formatEther(wei)
  return `${s.length > 10 ? Number(s).toPrecision(4) : s} ETH`
}
const fmt = (n: number) => n.toLocaleString('en-US')

const COLOR_NAMES = [
  'White', 'Light gray', 'Gray', 'Black', 'Pink', 'Red', 'Orange', 'Brown',
  'Yellow', 'Lime', 'Green', 'Cyan', 'Blue', 'Indigo', 'Magenta', 'Purple',
]

export default function App() {
  const place = usePlace()
  const { params } = place
  const canvas = useRef<CanvasHandle>(null)
  const [selected, setSelected] = useState<Pt | null>(null)
  const [hover, setHover] = useState<Pt | null>(null)
  const [scale, setScale] = useState(1)
  const [color, setColor] = useState(5)
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const cooldown = useCooldown()

  const showToast = useCallback((msg: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now()
    setToast({ id, msg, kind })
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 4000)
  }, [])

  const select = useCallback((p: Pt | null, focus = false) => {
    setSelected(p)
    if (p && focus) canvas.current?.focus(p)
  }, [])

  // Esc closes the tray, arrow keys nudge the reticle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'Escape') {
        if (drawer) setDrawer(null)
        else setSelected(null)
        return
      }
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
      if (d && selected && params) {
        e.preventDefault()
        const p = {
          x: Math.min(params.width - 1, Math.max(0, selected.x + d[0])),
          y: Math.min(params.height - 1, Math.max(0, selected.y + d[1])),
        }
        select(p, true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer, selected, params, select])

  const coord = hover ?? selected

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
              {PALETTE.slice(4, 13).map((c) => <i key={c} style={{ background: c }} />)}
            </div>
            Loading canvas…
          </div>
        )}
        {place.status === 'error' && <div className="overlay error">{place.error}</div>}
      </div>

      <header className="hud top">
        <div className="pill brand">
          <Logo />
          <div className="brand-text">
            <h1>OnChain Place</h1>
            <span className="sub">
              <i className="dot live" />
              {chain.name}
              {params && ` · ${fmt(params.width)}×${fmt(params.height)}`}
              {place.status === 'ready' && ` · ${fmt(place.totalPlacements)} pixels placed`}
            </span>
          </div>
        </div>

        {params && (
          <div className="pill coords" aria-live="off">
            {coord ? `(${coord.x}, ${coord.y})` : `${fmt(params.width)}×${fmt(params.height)}`}
            <span className="zoom">{scale >= 10 ? Math.round(scale) : scale.toFixed(1)}×</span>
          </div>
        )}

        <div className="top-right">
          <Wallet />
          <div className="icon-row">
            <button
              className={`pill icon ${drawer === 'activity' ? 'on' : ''}`}
              onClick={() => setDrawer(drawer === 'activity' ? null : 'activity')}
              title="Recent activity"
            >
              <ActivityIcon /> <span className="label">Activity</span>
            </button>
            <button
              className={`pill icon ${drawer === 'leaders' ? 'on' : ''}`}
              onClick={() => setDrawer(drawer === 'leaders' ? null : 'leaders')}
              title="Leaderboard"
            >
              <TrophyIcon /> <span className="label">Leaders</span>
            </button>
          </div>
        </div>
      </header>

      {drawer && (
        <aside className="drawer">
          <div className="drawer-head">
            <h2>{drawer === 'activity' ? 'Recent activity' : 'Leaderboard'}</h2>
            <button className="close" onClick={() => setDrawer(null)} aria-label="Close">
              <CloseIcon />
            </button>
          </div>
          <div className="drawer-body">
            {drawer === 'activity' ? (
              <Activity
                placements={place.placements}
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

      <div className="zoom-controls">
        <button className="pill icon" onClick={() => canvas.current?.zoomBy(2)} aria-label="Zoom in">+</button>
        <button className="pill icon" onClick={() => canvas.current?.zoomBy(0.5)} aria-label="Zoom out">−</button>
        <button className="pill icon" onClick={() => canvas.current?.fit()} aria-label="Show whole canvas">
          <FitIcon />
        </button>
      </div>

      <div className="hud bottom">
        {toast && (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.msg}
          </div>
        )}
        {params && selected ? (
          <Tray
            key={`${selected.x},${selected.y}`}
            place={place}
            selected={selected}
            color={color}
            setColor={setColor}
            cooldown={cooldown}
            onClose={() => setSelected(null)}
            onPlaced={(msg) => {
              setSelected(null)
              showToast(msg)
            }}
          />
        ) : (
          params && (
            <button
              className="place-btn"
              disabled={cooldown.left > 0}
              onClick={() => {
                const p = canvas.current?.centerPixel()
                if (p) select(p, true)
              }}
            >
              {cooldown.left > 0 ? (
                <>
                  <ClockIcon /> {fmtClock(cooldown.left)}
                </>
              ) : (
                'Place a pixel'
              )}
            </button>
          )
        )}
      </div>
    </div>
  )
}

/** Wallet cooldown: one read, then a local countdown. */
function useCooldown() {
  const { address } = useConnection()
  const { data: remaining, refetch, dataUpdatedAt } = useReadContract({
    address: contractAddress,
    abi: placeAbi,
    functionName: 'cooldownRemaining',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!contractAddress },
  })
  const readyAt = address && remaining !== undefined ? dataUpdatedAt + Number(remaining) * 1000 : 0
  const now = useNow(readyAt > Date.now() ? 250 : 1000)
  return { left: Math.max(0, Math.ceil((readyAt - now) / 1000)), refetch }
}

function Tray({
  place,
  selected,
  color,
  setColor,
  cooldown,
  onClose,
  onPlaced,
}: {
  place: PlaceState
  selected: Pt
  color: number
  setColor: (c: number) => void
  cooldown: ReturnType<typeof useCooldown>
  onClose: () => void
  onPlaced: (msg: string) => void
}) {
  const { address, isConnected } = useConnection()
  const chainId = useChainId()
  const client = usePublicClient()
  const { mutateAsync: writeContract } = useWriteContract()
  const { mutateAsync: switchChain } = useSwitchChain()
  const [tx, setTx] = useState<TxState>({ kind: 'idle' })
  const [showHistory, setShowHistory] = useState(false)
  const params = place.params!
  const id = selected.y * params.width + selected.x

  // Refetch this pixel's history whenever a live placement lands on it.
  const liveHits = useMemo(() => place.placements.filter((p) => p.pixelId === id).length, [place.placements, id])
  const [history, setHistory] = useState<Placement[] | null>(null)
  useEffect(() => {
    if (!client) return
    let stale = false
    fetchPixelHistory(client, id, params.width)
      .then((h) => !stale && setHistory(h.reverse()))
      .catch((e) => console.warn('pixel history failed', e))
    return () => {
      stale = true
    }
  }, [client, id, params.width, liveHits])
  // Overwrite counts aren't bulk-loaded (a 1000×1000 board would be 62,500 words), so read this one pixel.
  const { data: overwrites, refetch: refetchCount } = useReadContract({
    address: contractAddress,
    abi: placeAbi,
    functionName: 'overwritesOf',
    args: [BigInt(selected.x), BigInt(selected.y)],
    query: { enabled: !!contractAddress },
  })
  useEffect(() => {
    refetchCount()
  }, [liveHits, refetchCount])
  const count = overwrites ?? 0
  const price = params.basePrice + params.priceIncrement * BigInt(count)
  const current = place.colors[id]

  async function paint() {
    if (!address || !client || !contractAddress) return
    try {
      if (chainId !== chain.id) {
        setTx({ kind: 'busy', msg: `Switching to ${chain.name}…` })
        await switchChain({ chainId: chain.id })
      }
      setTx({ kind: 'busy', msg: 'Checking price…' })
      // Re-read on-chain price in case someone overwrote this pixel since our last poll.
      const livePrice = await client.readContract({
        address: contractAddress,
        abi: placeAbi,
        functionName: 'priceOf',
        args: [BigInt(selected.x), BigInt(selected.y)],
      })
      const call = {
        address: contractAddress,
        abi: placeAbi,
        functionName: 'placePixel',
        args: [BigInt(selected.x), BigInt(selected.y), color],
        value: livePrice,
      } as const
      // Simulate first so contract errors (cooldown, price) come back decoded instead of as a wallet failure.
      await client.simulateContract({ ...call, account: address })
      setTx({ kind: 'busy', msg: 'Confirm in wallet…' })
      const hash = await writeContract(call)
      setTx({ kind: 'busy', msg: 'Placing…' })
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Transaction reverted')
      cooldown.refetch()
      onPlaced(`Placed (${selected.x}, ${selected.y}) for ${eth(livePrice)}`)
    } catch (e) {
      setTx({ kind: 'err', msg: friendlyError(e) })
      cooldown.refetch()
    }
  }

  const busy = tx.kind === 'busy'
  const last = history?.[0]

  return (
    <div className="tray">
      <div className="tray-head">
        <div className="tray-pixel">
          <i className="dot lg" style={{ background: PALETTE[current] }} />
          <div>
            <b>
              ({selected.x}, {selected.y})
            </b>
            <span className="muted">
              {count === 0
                ? ' · never painted'
                : ` · painted ${count}×${last ? ` · last by ${short(last.painter)}` : ''}`}
            </span>
          </div>
        </div>
        {!!history?.length && (
          <button className="link" onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? 'Hide history' : `History (${history.length})`}
          </button>
        )}
      </div>

      {showHistory && history && (
        <ul className="feed history">
          {history.map((p) => (
            <FeedItem key={`${p.txHash}:${p.logIndex}`} p={p} />
          ))}
        </ul>
      )}

      <div className="palette" role="radiogroup" aria-label="Color">
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

      <div className="tray-actions">
        <button className="round cancel" onClick={onClose} aria-label="Cancel" title="Cancel (Esc)">
          <CloseIcon />
        </button>
        {!isConnected ? (
          <div className="confirm-wrap">
            <Wallet compact />
          </div>
        ) : (
          <button className="confirm" disabled={busy || cooldown.left > 0} onClick={paint}>
            {cooldown.left > 0 ? (
              <>
                <ClockIcon /> Ready in {fmtClock(cooldown.left)}
              </>
            ) : busy ? (
              <>
                <span className="spinner" /> {tx.msg}
              </>
            ) : (
              <>
                <CheckIcon /> Place for {eth(price)}
              </>
            )}
          </button>
        )}
      </div>
      {tx.kind === 'err' && <p className="tx err">{tx.msg}</p>}
      <p className="fine">
        Pixels start at {eth(params.basePrice)} and cost {eth(params.priceIncrement)} more each time they're painted over.
        One pixel every {fmtClock(params.cooldown)} per wallet.
      </p>
    </div>
  )
}

function Activity({ placements, onPick }: { placements: Placement[]; onPick: (p: Pt) => void }) {
  const recent = useMemo(
    () =>
      [...placements]
        .sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber < b.blockNumber ? 1 : -1))
        .slice(0, 100),
    [placements],
  )
  if (!recent.length) return <p className="muted">No pixels placed yet. Be the first.</p>
  return (
    <ul className="feed">
      {recent.map((p) => (
        <FeedItem key={`${p.txHash}:${p.logIndex}`} p={p} onClick={() => onPick(p)} showCoords />
      ))}
    </ul>
  )
}

function FeedItem({ p, onClick, showCoords }: { p: Placement; onClick?: () => void; showCoords?: boolean }) {
  const explorer = chain.blockExplorers?.default.url
  return (
    <li onClick={onClick} className={onClick ? 'clickable' : ''}>
      <i className="dot" style={{ background: PALETTE[p.color] }} />
      <span className="addr">{short(p.painter)}</span>
      {showCoords && <span className="muted">({p.x}, {p.y})</span>}
      <span className="price">{eth(p.price)}</span>
      {explorer && (
        <a href={`${explorer}/tx/${p.txHash}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="View transaction">
          ↗
        </a>
      )}
    </li>
  )
}

function Leaderboard({ refreshKey }: { refreshKey: number }) {
  const { address } = useConnection()
  const [sortBy, setSortBy] = useState<'placed' | 'spent'>('placed')
  const { data, refetch } = useReadContract({
    address: contractAddress,
    abi: placeAbi,
    functionName: 'getPlayers',
    args: [0n, 1000n],
    query: { enabled: !!contractAddress },
  })
  useEffect(() => {
    refetch()
  }, [refreshKey, refetch])

  const rows = useMemo(() => {
    if (!data) return []
    const [addrs, stats] = data
    return addrs
      .map((a, i) => ({ addr: a as Address, placed: Number(stats[i].placed), spent: stats[i].spent }))
      .sort((a, b) => (sortBy === 'placed' ? b.placed - a.placed : b.spent > a.spent ? 1 : b.spent < a.spent ? -1 : 0))
      .slice(0, 50)
  }, [data, sortBy])

  return (
    <>
      <div className="seg">
        <button className={sortBy === 'placed' ? 'on' : ''} onClick={() => setSortBy('placed')}>Most pixels</button>
        <button className={sortBy === 'spent' ? 'on' : ''} onClick={() => setSortBy('spent')}>Most spent</button>
      </div>
      {!rows.length ? (
        <p className="muted">No players yet.</p>
      ) : (
        <ol className="leaders">
          {rows.map((r, i) => (
            <li key={r.addr} className={r.addr.toLowerCase() === address?.toLowerCase() ? 'me' : ''}>
              <span className={`rank r${i + 1}`}>{i + 1}</span>
              <span className="addr">{short(r.addr)}</span>
              <span className="muted">{fmt(r.placed)} px</span>
              <span className="price">{eth(r.spent)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

function Wallet({ compact }: { compact?: boolean }) {
  const { address, isConnected } = useConnection()
  const connectors = useConnectors()
  const { mutate: connect, isPending, error } = useConnect()
  const { mutate: disconnect } = useDisconnect()

  if (isConnected && address) {
    return (
      <button className="pill wallet" onClick={() => disconnect()} title="Disconnect">
        <i className="dot live" />
        {short(address)}
      </button>
    )
  }
  return (
    <div className={compact ? 'wallet-wrap compact' : 'wallet-wrap'}>
      <div className="wallet-row">
        {/* Hide the generic injected button when the wallet announced itself by name (EIP-6963). */}
        {connectors.filter((c) => c.id !== 'injected' || connectors.length === 1 || !connectors.some((o) => o.type === 'injected' && o.id !== 'injected')).map((c) => (
          <button key={c.uid} className="pill wallet connect" disabled={isPending} onClick={() => connect({ connector: c })}>
            {isPending ? 'Connecting…' : c.type === 'mock' ? 'Anvil test account' : c.name === 'Injected' ? 'Connect wallet' : c.name}
          </button>
        ))}
      </div>
      {error && <span className="tx err">{error.message.split('\n')[0]}</span>}
    </div>
  )
}

function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 4 4" shapeRendering="crispEdges" aria-hidden>
      <rect width="2" height="2" fill="#E50000" />
      <rect x="2" width="2" height="2" fill="#0083C7" />
      <rect y="2" width="2" height="2" fill="#E5D900" />
      <rect x="2" y="2" width="2" height="2" fill="#02BE01" />
    </svg>
  )
}

const svg = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
const CloseIcon = () => <svg {...svg}><path d="M6 6l12 12M18 6L6 18" /></svg>
const CheckIcon = () => <svg {...svg}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
const ClockIcon = () => <svg {...svg}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
const ActivityIcon = () => <svg {...svg}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
const TrophyIcon = () => <svg {...svg}><path d="M8 4h8v5a4 4 0 0 1-8 0V4zM8 6H4v1a3 3 0 0 0 4 3M16 6h4v1a3 3 0 0 1-4 3M12 13v4M8 20h8M10 17h4" /></svg>
const FitIcon = () => <svg {...svg}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

function fmtClock(s: number) {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function friendlyError(e: unknown): string {
  const msg = errMsg(e)
  if (/CooldownActive/.test(msg)) return 'Cooldown still active — wait a bit.'
  if (/InsufficientPayment/.test(msg)) return 'Price changed — someone just painted this pixel. Try again.'
  if (/User rejected|denied/i.test(msg)) return 'Transaction rejected in wallet.'
  if (/insufficient funds/i.test(msg)) return 'Not enough ETH for price + gas.'
  return msg
}
