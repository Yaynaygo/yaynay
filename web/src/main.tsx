import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from './wagmi'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { BRAND, STORAGE } from './config'

// After a deploy, an open tab may request lazy chunks that no longer exist; reload once to pick up
// the new build instead of failing the deposit or trade flow.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  if (!sessionStorage.getItem('yaynay:reloaded')) {
    sessionStorage.setItem('yaynay:reloaded', '1')
    window.location.reload()
  }
})

// Market artwork is cropped to a square; very wide logo images (league wordmarks) lose their letters
// that way, so they are shown whole instead. `load` doesn't bubble, hence the capture listener.
document.addEventListener(
  'load',
  (e) => {
    const img = e.target
    if (!(img instanceof HTMLImageElement) || !img.naturalWidth || !img.naturalHeight) return
    // Only very wide or tall PNGs: those are logos and wordmarks (e.g. UEFA Nations League). Photos stay cropped.
    const ratio = img.naturalWidth / img.naturalHeight
    const logo = /\.png(\?|$)/i.test(img.currentSrc || img.src)
    img.classList.toggle('img-fit', logo && (ratio > 1.6 || ratio < 0.62))
  },
  true,
)

document.title = `${BRAND.name} · ${BRAND.tagline}`

// Apply the saved theme before the first paint (inline scripts are blocked by our CSP). Without a
// saved choice, follow the operating system.
try {
  const saved = localStorage.getItem(STORAGE.theme)
  document.documentElement.dataset.theme =
    saved === 'dark' || saved === 'light' ? saved : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
} catch {
  // ignore
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
