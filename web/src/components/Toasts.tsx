import { dismissToast, useToasts } from '../lib/toast'

export function Toasts() {
  const toasts = useToasts()
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span className="toast-ico" aria-hidden="true">
            {t.kind === 'success' ? '✓' : t.kind === 'error' ? '!' : <span className="spinner" />}
          </span>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            {t.detail && <div className="toast-detail">{t.detail}</div>}
            {t.href && (
              <a href={t.href} target="_blank" rel="noreferrer">
                {t.linkLabel ?? 'View transaction'} ↗
              </a>
            )}
          </div>
          <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
