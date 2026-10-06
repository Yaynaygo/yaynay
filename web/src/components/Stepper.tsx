export type StepState = 'todo' | 'active' | 'done' | 'failed'
export type Step = {
  label: string
  state: StepState
  detail?: string
  /** Optional explorer link shown under the step. */
  href?: string
  hrefLabel?: string
}

const STATE_LABEL: Record<StepState, string> = { todo: 'Up next', active: 'In progress', done: 'Done', failed: 'Needs attention' }

/** A vertical timeline of the on-chain legs of a transfer. */
export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="wl-timeline">
      {steps.map((s, i) => (
        <li key={s.label} className={`wl-tl-step ${s.state}`}>
          <span className="wl-tl-ico" aria-hidden="true">
            {s.state === 'done' ? (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M2.5 6.2 5 8.6l4.5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : s.state === 'failed' ? (
              '!'
            ) : (
              i + 1
            )}
          </span>
          <div className="wl-tl-body">
            <div className="wl-tl-label">{s.label}</div>
            <div className="wl-tl-meta">
              <span className="wl-tl-state">{STATE_LABEL[s.state]}</span>
              {s.detail && <span className="mono">{s.detail}</span>}
              {s.href && (
                <a href={s.href} target="_blank" rel="noreferrer">
                  {s.hrefLabel ?? 'View tx'} ↗
                </a>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}
