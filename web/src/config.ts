import { http, createConfig } from 'wagmi'
import { baseSepolia, foundry } from 'wagmi/chains'
import { injected, mock } from 'wagmi/connectors'
import type { Address } from 'viem'

const env = import.meta.env

export const chain = env.VITE_CHAIN === 'baseSepolia' ? baseSepolia : foundry
export const contractAddress = env.VITE_CONTRACT_ADDRESS as Address | undefined
export const deployBlock = BigInt(env.VITE_DEPLOY_BLOCK || 0)
export const logChunk = BigInt(env.VITE_LOG_CHUNK || 9000)
const rpcUrl: string | undefined = env.VITE_RPC_URL || undefined

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [
    injected(),
    // Local only: anvil's default accounts are unlocked, so we can send txs without a browser wallet.
    ...(env.VITE_CHAIN === 'baseSepolia'
      ? []
      : [
          mock({
            accounts: [
              '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
              '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
            ],
            features: { reconnect: true },
          }),
        ]),
  ],
  transports: { [chain.id]: http(rpcUrl) } as Record<typeof chain.id, ReturnType<typeof http>>,
  pollingInterval: chain.id === foundry.id ? 1_000 : 2_000,
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
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
