import { Component, type ReactNode } from 'react'

/** Keeps one broken view from blanking the whole app, and offers a way back. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[yaynay] render error:', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="container" style={{ padding: '80px 24px' }}>
        <div className="card" style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
          <h2>Something went wrong on this screen</h2>
          <p className="sub" style={{ marginTop: 8 }}>
            Your funds are not affected: they stay in your own wallets. Reload the page to continue.
          </p>
          <p className="mono muted" style={{ marginBottom: 16 }}>
            {this.state.error.message}
          </p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    )
  }
}
