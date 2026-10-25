import { Buffer } from 'buffer'
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type Connection,
  type VersionedTransactionResponse,
} from '@solana/web3.js'
import idl from './idl/place.json'
import { programId } from './config'

/** Bytes per canvas chunk account; must match `CHUNK_SIZE` in programs/place/src/lib.rs. */
export const CHUNK_SIZE = 10_000
const DISC = 8

const disc = (list: { name: string; discriminator: number[] }[], name: string) =>
  Uint8Array.from(list.find((x) => x.name === name)!.discriminator)
const IX_PLACE = disc(idl.instructions, 'place_pixel')
export const ACC_PLAYER = disc(idl.accounts, 'Player')
const EV_PIXEL = disc(idl.events, 'PixelPlaced')

const u16 = (n: number) => {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, n, true)
  return b
}

export const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0]
export const chunkPda = (i: number) => PublicKey.findProgramAddressSync([Buffer.from('chunk'), u16(i)], programId)[0]
export const playerPda = (wallet: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('player'), wallet.toBuffer()], programId)[0]

export type PlaceParams = {
  authority: PublicKey
  width: number
  height: number
  basePrice: bigint
  priceIncrement: bigint
  cooldown: number
  totalPlacements: number
  totalCollected: bigint
}

/** Borsh layout of `Config` (no padding): see the struct in lib.rs. */
export function decodeConfig(data: Uint8Array): PlaceParams {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    authority: new PublicKey(data.subarray(DISC, DISC + 32)),
    width: v.getUint16(40, true),
    height: v.getUint16(42, true),
    basePrice: v.getBigUint64(44, true),
    priceIncrement: v.getBigUint64(52, true),
    cooldown: Number(v.getBigInt64(60, true)),
    totalPlacements: Number(v.getBigUint64(68, true)),
    totalCollected: v.getBigUint64(76, true),
  }
}

export type PlayerStats = { wallet: PublicKey; lastPlaced: number; placed: number; spent: bigint }

export function decodePlayer(data: Uint8Array): PlayerStats {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    wallet: new PublicKey(data.subarray(DISC, DISC + 32)),
    lastPlaced: Number(v.getBigInt64(40, true)),
    placed: Number(v.getBigUint64(48, true)),
    spent: v.getBigUint64(56, true),
  }
}

export const chunkCount = (p: PlaceParams) => Math.ceil((p.width * p.height) / CHUNK_SIZE)
export const priceFor = (p: PlaceParams, tier: number) => p.basePrice + p.priceIncrement * BigInt(tier)

export function placePixelIx(painter: PublicKey, width: number, x: number, y: number, color: number) {
  const chunk = Math.floor((y * width + x) / CHUNK_SIZE)
  const data = new Uint8Array(8 + 2 + 2 + 2 + 1)
  data.set(IX_PLACE, 0)
  data.set(u16(chunk), 8)
  data.set(u16(x), 10)
  data.set(u16(y), 12)
  data[14] = color
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: chunkPda(chunk), isSigner: false, isWritable: true },
      { pubkey: playerPda(painter), isSigner: false, isWritable: true },
      { pubkey: painter, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

export type Placement = {
  x: number
  y: number
  color: number
  tierBefore: number
  painter: string
  price: bigint
  timestamp: number
  slot: number
  signature: string
}

/** Anchor `emit!` writes `Program data: <base64(discriminator ++ borsh fields)>` to the logs. */
export function parsePlacements(logs: readonly string[], signature: string, slot: number): Placement[] {
  const out: Placement[] = []
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue
    const b = Uint8Array.from(atob(line.slice(14)), (c) => c.charCodeAt(0))
    if (b.length < 8 + 54 || !EV_PIXEL.every((d, i) => b[i] === d)) continue
    const v = new DataView(b.buffer)
    out.push({
      x: v.getUint16(8, true),
      y: v.getUint16(10, true),
      color: b[12],
      tierBefore: b[13],
      painter: new PublicKey(b.subarray(14, 46)).toBase58(),
      price: v.getBigUint64(46, true),
      timestamp: Number(v.getBigInt64(54, true)),
      slot,
      signature,
    })
  }
  return out
}

/** Placements from the most recent transactions that touched `address`, newest first. */
export async function recentPlacements(connection: Connection, address: PublicKey, limit: number): Promise<Placement[]> {
  const sigs = (await connection.getSignaturesForAddress(address, { limit })).filter((s) => !s.err)
  const out: Placement[] = []
  for (let i = 0; i < sigs.length; i += 50) {
    const batch = sigs.slice(i, i + 50)
    const txs = await connection.getTransactions(
      batch.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    )
    txs.forEach((tx: VersionedTransactionResponse | null, j) => {
      if (tx?.meta?.logMessages) out.push(...parsePlacements(tx.meta.logMessages, batch[j].signature, tx.slot))
    })
  }
  return out
}

/** Pulls the Anchor error name/message out of simulation logs, e.g. "CooldownActive". */
export function programError(logs: readonly string[] | null | undefined): string | null {
  const line = logs?.find((l) => l.includes('Error Code:'))
  if (!line) return null
  const m = line.match(/Error Code: (\w+)\. Error Number: \d+\. Error Message: (.*)\.?$/)
  return m ? `${m[1]}: ${m[2]}` : line
}
