import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { arbitrum, base, bsc, mainnet, optimism, tempo } from 'viem/chains'
import { arc, polygon } from './config'

// Arc is the hub; the other chains are only sources for "Top up Arc" (LI.FI) balance reads and receipts.
export const wagmiConfig = createConfig({
  chains: [arc, polygon, mainnet, base, arbitrum, optimism, bsc, tempo],
  connectors: [injected()],
  transports: {
    [arc.id]: http(),
    [polygon.id]: http('https://polygon-bor-rpc.publicnode.com'),
    [mainnet.id]: http('https://ethereum-rpc.publicnode.com'),
    [base.id]: http('https://base-rpc.publicnode.com'),
    [arbitrum.id]: http('https://arbitrum-one-rpc.publicnode.com'),
    [optimism.id]: http('https://optimism-rpc.publicnode.com'),
    [bsc.id]: http('https://bsc-rpc.publicnode.com'),
    [tempo.id]: http(),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
