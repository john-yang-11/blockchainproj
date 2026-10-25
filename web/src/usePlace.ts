import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { getAbiItem, parseEventLogs, type Address, type Hash, type Log } from 'viem'
import { placeAbi } from './abi'
import { contractAddress, deployBlock, logChunk } from './config'

export type Placement = {
  pixelId: number
  x: number
  y: number
  painter: Address
  color: number
  overwrites: number
  price: bigint
  blockNumber: bigint
  txHash: Hash
  logIndex: number
}

export type PlaceParams = {
  width: number
  height: number
  basePrice: bigint
  priceIncrement: bigint
  cooldown: number
}

export type PlaceState = {
  status: 'loading' | 'ready' | 'error'
  error?: string
  params?: PlaceParams
  colors: Uint8Array
  /** Recent placements (for the activity feed) plus everything seen live, oldest first. */
  placements: Placement[]
  totalPlacements: number
  /** Bumped every time pixels change, so the canvas knows to redraw. */
  version: number
}

type Client = NonNullable<ReturnType<typeof usePublicClient>>

const MAX_PARALLEL = 4
/** Canvas words per getCanvas call: 2048 words = 131k pixels, ~4.5M gas of SLOADs, well under RPC eth_call caps. */
const CANVAS_CHUNK = 2048
/** How many recent placements to backfill for the activity feed. The full history can be huge, so we don't load it. */
const RECENT = 200
const pixelPlaced = getAbiItem({ abi: placeAbi, name: 'PixelPlaced' })

/** Unpack 4-bit colors from 256-bit words into `out`, starting at word index `firstWord`. */
function unpackColors(words: readonly bigint[], firstWord: number, out: Uint8Array) {
  for (let w = 0; w < words.length; w++) {
    const word = words[w]
    if (word === 0n) continue // blank (white) — most of a fresh board
    // Split into 32-bit pieces so the inner loop runs on Numbers, not BigInts.
    let base = (firstWord + w) * 64
    for (let q = 0; q < 8; q++, base += 8) {
      let part = Number((word >> BigInt(q * 32)) & 0xffffffffn)
      for (let i = 0; i < 8; i++, part >>>= 4) out[base + i] = part & 0xf
    }
  }
}

export function toPlacements(logs: Log[], width: number): Placement[] {
  return parseEventLogs({ abi: placeAbi, eventName: 'PixelPlaced', logs }).map((l) => {
    const id = Number(l.args.pixelId)
    return {
      pixelId: id,
      x: id % width,
      y: Math.floor(id / width),
      painter: l.args.painter,
      color: l.args.color,
      overwrites: l.args.overwrites,
      price: l.args.price,
      blockNumber: l.blockNumber!,
      txHash: l.transactionHash!,
      logIndex: l.logIndex!,
    }
  })
}

const byChain = (a: Placement, b: Placement) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

/** All placements on one pixel, oldest first. The pixel id is an indexed topic, so this stays cheap on any board size. */
export async function fetchPixelHistory(client: Client, pixelId: number, width: number): Promise<Placement[]> {
  if (!contractAddress) return []
  const head = await client.getBlockNumber()
  const ranges: [bigint, bigint][] = []
  for (let from = deployBlock; from <= head; from += logChunk + 1n)
    ranges.push([from, from + logChunk > head ? head : from + logChunk])
  const out: Placement[] = []
  let next = 0
  const worker = async () => {
    while (next < ranges.length) {
      const [fromBlock, toBlock] = ranges[next++]
      const logs = await client.getLogs({ address: contractAddress, event: pixelPlaced, args: { pixelId: BigInt(pixelId) }, fromBlock, toBlock })
      out.push(...toPlacements(logs, width))
    }
  }
  await Promise.all(Array.from({ length: MAX_PARALLEL }, worker))
  return out.sort(byChain)
}

export function usePlace(): PlaceState {
  const client = usePublicClient()
  const [state, setState] = useState<PlaceState>({
    status: 'loading',
    colors: new Uint8Array(0),
    placements: [],
    totalPlacements: 0,
    version: 0,
  })

  useEffect(() => {
    if (!client || !contractAddress) {
      setState((s) => ({ ...s, status: 'error', error: 'VITE_CONTRACT_ADDRESS is not set — see README.' }))
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const address = contractAddress

    const fetchRange = (fromBlock: bigint, toBlock: bigint) => client.getLogs({ address, event: pixelPlaced, fromBlock, toBlock })

    ;(async () => {
      try {
        const base = { address, abi: placeAbi } as const
        const [width, height, basePrice, priceIncrement, cooldown] = await Promise.all([
          client.readContract({ ...base, functionName: 'width' }),
          client.readContract({ ...base, functionName: 'height' }),
          client.readContract({ ...base, functionName: 'basePrice' }),
          client.readContract({ ...base, functionName: 'priceIncrement' }),
          client.readContract({ ...base, functionName: 'cooldown' }),
        ])
        const params: PlaceParams = {
          width: Number(width),
          height: Number(height),
          basePrice,
          priceIncrement,
          cooldown: Number(cooldown),
        }
        const total = params.width * params.height

        // Snapshot the canvas at a fixed block so live polling picks up exactly where it left off.
        const snapshot = await client.getBlockNumber()
        const colors = new Uint8Array(total)
        const starts: number[] = []
        for (let w = 0; w < total / 64; w += CANVAS_CHUNK) starts.push(w)
        const [totalPlacements] = await Promise.all([
          client.readContract({ ...base, functionName: 'totalPlacements', blockNumber: snapshot }),
          ...starts.map(async (from) => {
            const words = await client.readContract({
              ...base,
              functionName: 'getCanvas',
              args: [BigInt(from), BigInt(CANVAS_CHUNK)],
              blockNumber: snapshot,
            })
            unpackColors(words, from, colors)
          }),
        ])
        if (cancelled) return
        setState((s) => ({ ...s, status: 'ready', params, colors, totalPlacements: Number(totalPlacements), version: s.version + 1 }))

        // Live updates: poll getLogs (works on every RPC, unlike eth_newFilter).
        let cursor = snapshot
        const poll = async () => {
          try {
            const head = await client.getBlockNumber()
            if (head > cursor) {
              const from = cursor + 1n
              const to = head - from > logChunk ? from + logChunk : head
              const fresh = toPlacements(await fetchRange(from, to), params.width)
              cursor = to
              if (fresh.length && !cancelled) {
                setState((s) => {
                  for (const p of fresh) s.colors[p.pixelId] = p.color
                  return {
                    ...s,
                    placements: [...s.placements, ...fresh],
                    totalPlacements: s.totalPlacements + fresh.length,
                    version: s.version + 1,
                  }
                })
              }
            }
          } catch (e) {
            console.warn('poll failed', e)
          }
          if (!cancelled) timer = setTimeout(poll, client.pollingInterval)
        }
        poll()

        // Backfill recent activity, newest first. The window starts small and grows while results stay
        // small, and shrinks if the RPC rejects a range (too many logs / response too large).
        const recent: Placement[] = []
        let span = 256n
        let to = snapshot
        while (!cancelled && to >= deployBlock && recent.length < RECENT) {
          const from = to - span + 1n < deployBlock ? deployBlock : to - span + 1n
          let logs
          try {
            logs = await fetchRange(from, to)
          } catch (e) {
            if (span > 1n) {
              span /= 2n
              continue
            }
            throw e
          }
          recent.push(...toPlacements(logs, params.width))
          to = from - 1n
          if (logs.length < RECENT && span < logChunk) span *= 2n
        }
        if (!cancelled && recent.length) {
          const keep = recent.sort(byChain).slice(-RECENT)
          setState((s) => ({ ...s, placements: [...keep, ...s.placements] }))
        }
      } catch (e) {
        console.error(e)
        if (!cancelled) setState((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'error', error: errMsg(e) }))
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client])

  return state
}

export function errMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { shortMessage?: string; message?: string }
    return err.shortMessage ?? err.message ?? String(e)
  }
  return String(e)
}
