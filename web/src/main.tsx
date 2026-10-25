import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { UnsafeBurnerWalletAdapter } from '@solana/wallet-adapter-unsafe-burner'
import { cluster, rpcUrl } from './config'
import App from './App'
import './index.css'

function Root() {
  // Phantom, Solflare, Backpack, MetaMask (Solana) etc. register themselves via Wallet Standard,
  // so only the local burner needs listing. It holds a throwaway key in localStorage: localnet only.
  const wallets = useMemo(() => (cluster === 'localnet' ? [new UnsafeBurnerWalletAdapter()] : []), [])
  return (
    <ConnectionProvider endpoint={rpcUrl} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect>
        <App />
      </WalletProvider>
    </ConnectionProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
