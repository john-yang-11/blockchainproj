import { PublicKey, clusterApiUrl } from '@solana/web3.js'
import idl from './idl/place.json'

const env = import.meta.env

/** "localnet" (solana-test-validator on 127.0.0.1) or "devnet". */
export const cluster: 'localnet' | 'devnet' = env.VITE_CLUSTER === 'devnet' ? 'devnet' : 'localnet'
export const clusterName = cluster === 'devnet' ? 'Solana devnet' : 'Solana localnet'
export const rpcUrl: string = env.VITE_RPC_URL || (cluster === 'devnet' ? clusterApiUrl('devnet') : 'http://127.0.0.1:8899')
export const programId = new PublicKey(env.VITE_PROGRAM_ID || idl.address)

/** Solana Explorer link for a tx or account; localnet works via the explorer's custom-RPC mode. */
export function explorerUrl(kind: 'tx' | 'address', id: string) {
  const q = cluster === 'devnet' ? '?cluster=devnet' : `?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`
  return `https://explorer.solana.com/${kind}/${id}${q}`
}

/** The 16-color palette from r/place 2017. Index 0 (white) is the blank canvas color. */
export const PALETTE = [
  '#FFFFFF', '#E4E4E4', '#888888', '#222222',
  '#FFA7D1', '#E50000', '#E59500', '#A06A42',
  '#E5D900', '#94E044', '#02BE01', '#00D3DD',
  '#0083C7', '#0000EA', '#CF6EE4', '#820080',
] as const

export const PALETTE_RGB = PALETTE.map((hex) => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
})
