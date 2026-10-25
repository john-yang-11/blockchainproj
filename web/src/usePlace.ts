import { useEffect, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import type { Connection } from '@solana/web3.js'
import { programId } from './config'
import {
  CHUNK_SIZE,
  chunkCount,
  chunkPda,
  configPda,
  decodeConfig,
  parsePlacements,
  recentPlacements,
  type Placement,
  type PlaceParams,
} from './solana'

export type { Placement, PlaceParams }

export type PlaceState = {
  status: 'loading' | 'ready' | 'error'
  error?: string
  params?: PlaceParams
  /** Palette index per pixel (low nibble of the on-chain byte). */
  colors: Uint8Array
  /** Overwrite tier per pixel (high nibble), which sets the price. */
  tiers: Uint8Array
  /** Recent placements (for the activity feed) plus everything seen live, oldest first. */
  placements: Placement[]
  totalPlacements: number
  /** Bumped every time pixels change, so the canvas knows to redraw. */
  version: number
}

/** How many recent placements to backfill for the activity feed. Full history is never loaded. */
const RECENT = 200
/** Full re-read of the canvas accounts, in case the log websocket dropped something. */
const RESYNC_MS = 20_000

/** Reads config + every chunk account (≤100 per RPC call) into flat color/tier arrays. */
async function loadCanvas(connection: Connection) {
  const cfg = await connection.getAccountInfo(configPda, 'confirmed')
  if (!cfg) throw new Error(`No canvas found for program ${programId.toBase58()}. Deploy and initialize it first (see README).`)
  const params = decodeConfig(cfg.data)
  const total = params.width * params.height
  const colors = new Uint8Array(total)
  const tiers = new Uint8Array(total)
  const keys = Array.from({ length: chunkCount(params) }, (_, i) => chunkPda(i))
  for (let start = 0; start < keys.length; start += 100) {
    const infos = await connection.getMultipleAccountsInfo(keys.slice(start, start + 100), 'confirmed')
    infos.forEach((info, j) => {
      if (!info) return // chunk not initialized yet: shows as blank
      const base = (start + j) * CHUNK_SIZE
      const bytes = info.data.subarray(8, 8 + Math.min(CHUNK_SIZE, total - base))
      for (let k = 0; k < bytes.length; k++) {
        colors[base + k] = bytes[k] & 0xf
        tiers[base + k] = bytes[k] >> 4
      }
    })
  }
  return { params, colors, tiers }
}

/** This pixel's placements among its chunk's recent transactions, newest first. Best effort, capped. */
export async function fetchPixelHistory(connection: Connection, x: number, y: number, width: number): Promise<Placement[]> {
  const chunk = Math.floor((y * width + x) / CHUNK_SIZE)
  const all = await recentPlacements(connection, chunkPda(chunk), 300)
  return all.filter((p) => p.x === x && p.y === y)
}

export function usePlace(): PlaceState {
  const { connection } = useConnection()
  const [state, setState] = useState<PlaceState>({
    status: 'loading',
    colors: new Uint8Array(0),
    tiers: new Uint8Array(0),
    placements: [],
    totalPlacements: 0,
    version: 0,
  })

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let sub: number | undefined
    const seen = new Set<string>()

    const apply = (fresh: Placement[]) => {
      fresh = fresh.filter((p) => {
        const key = `${p.signature}:${p.x}:${p.y}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!fresh.length || cancelled) return
      setState((s) => {
        if (!s.params) return s
        for (const p of fresh) {
          const i = p.y * s.params.width + p.x
          s.colors[i] = p.color
          s.tiers[i] = Math.min(15, p.tierBefore + 1)
        }
        return {
          ...s,
          placements: [...s.placements, ...fresh],
          totalPlacements: s.totalPlacements + fresh.length,
          version: s.version + 1,
        }
      })
    }

    ;(async () => {
      try {
        const { params, colors, tiers } = await loadCanvas(connection)
        if (cancelled) return
        setState((s) => ({
          ...s,
          status: 'ready',
          params,
          colors,
          tiers,
          totalPlacements: params.totalPlacements,
          version: s.version + 1,
        }))

        // Live updates: every place_pixel emits a PixelPlaced event into the program's logs.
        sub = connection.onLogs(
          programId,
          (l) => {
            if (!l.err) apply(parsePlacements(l.logs, l.signature, 0))
          },
          'confirmed',
        )

        // Periodic resync from the accounts themselves (the chain is the source of truth).
        const resync = async () => {
          try {
            const fresh = await loadCanvas(connection)
            if (!cancelled)
              setState((s) => ({
                ...s,
                params: fresh.params,
                colors: fresh.colors,
                tiers: fresh.tiers,
                totalPlacements: Math.max(s.totalPlacements, fresh.params.totalPlacements),
                version: s.version + 1,
              }))
          } catch (e) {
            console.warn('resync failed', e)
          }
          if (!cancelled) timer = setTimeout(resync, RESYNC_MS)
        }
        timer = setTimeout(resync, RESYNC_MS)

        // Backfill the activity feed from recent transactions on the config account
        // (every placement writes to it).
        const recent = await recentPlacements(connection, configPda, RECENT)
        if (cancelled) return
        for (const p of recent) seen.add(`${p.signature}:${p.x}:${p.y}`)
        setState((s) => ({ ...s, placements: [...recent.reverse(), ...s.placements] }))
      } catch (e) {
        console.error(e)
        if (!cancelled) setState((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'error', error: errMsg(e) }))
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(timer)
      if (sub !== undefined) connection.removeOnLogsListener(sub).catch(() => {})
    }
  }, [connection])

  return state
}

export function errMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { message?: string }
    return err.message ?? String(e)
  }
  return String(e)
}
