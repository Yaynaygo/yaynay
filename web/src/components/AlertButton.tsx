import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { addAlert, formatCents, removeAlert, useAlerts, type AlertOp } from '../lib/alerts'
import { BellIcon } from './Notifications'
import '../styles/notifications.css'
import { track } from '../lib/progress'

const MIN_C = 0.1
const MAX_C = 99.9
const clampC = (c: number) => Math.min(MAX_C, Math.max(MIN_C, Math.round(c * 10) / 10))

/** "Alert" button with a popover to arm a one-shot price alert on one outcome. */
export function AlertButton(props: { tokenId: string; outcome: string; title: string; slug: string; price: number }) {
  const all = useAlerts()
  const mine = all.filter((a) => a.tokenId === props.tokenId)
  const armed = mine.filter((a) => !a.firedAt)
  const nowC = Math.round(props.price * 1000) / 10
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [op, setOp] = useState<AlertOp>('above')
  const [saved, setSaved] = useState('')
  // Opens rightwards unless that would run off the screen.
  const [alignStart, setAlignStart] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    input.current?.select()
    const onDoc = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      btn.current?.focus()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Typing a target picks the direction for you; Above/Below still overrides.
  const setTargetC = (c: number) => {
    const v = clampC(c)
    setTarget(String(v))
    setOp(v >= nowC ? 'above' : 'below')
    setSaved('')
  }

  const toggle = () => {
    if (!open) {
      const r = btn.current?.getBoundingClientRect()
      setAlignStart(!!r && r.left + 300 < window.innerWidth - 12)
      setTargetC(nowC + 5 > MAX_C ? nowC - 5 : nowC + 5)
    }
    setOpen((o) => !o)
  }

  const targetC = Number(target)
  const valid = target.trim() !== '' && Number.isFinite(targetC) && targetC >= MIN_C && targetC <= MAX_C
  const alreadyTrue = valid && (op === 'above' ? nowC >= targetC : nowC <= targetC)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid || alreadyTrue) return
    addAlert({ tokenId: props.tokenId, slug: props.slug, title: props.title, outcome: props.outcome, op, price: clampC(targetC) / 100 })
    track('alert_set', { slug: props.slug })
    setSaved(`Done. We'll ping you when ${props.outcome} goes ${op} ${formatCents(clampC(targetC) / 100)}.`)
  }

  return (
    <div className="nt-anchor" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className={`subtle nt-alert-btn${armed.length ? ' armed' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        aria-label={`Price alert for ${props.outcome}${armed.length ? `, ${armed.length} active` : ''}`}
      >
        <BellIcon size={15} />
        <span>Alert</span>
        {armed.length > 0 && <span className="nt-mini-count num">{armed.length}</span>}
      </button>
      {open && (
        <div className={`nt-pop${alignStart ? ' start' : ''}`} id={id} role="dialog" aria-label={`Price alert for ${props.outcome}`}>
          <form onSubmit={submit} className="nt-pop-form">
            <div className="nt-pop-head">
              <strong>Ping me when {props.outcome} is…</strong>
              <span className="muted">
                Now <span className="num">{formatCents(props.price)}</span>
              </span>
            </div>
            <div className="nt-seg" role="radiogroup" aria-label="Direction">
              {(['above', 'below'] as const).map((o) => (
                <button key={o} type="button" role="radio" aria-checked={op === o} className={`nt-seg-btn ${o}${op === o ? ' active' : ''}`} onClick={() => (setOp(o), setSaved(''))}>
                  {o === 'above' ? '↑ Above' : '↓ Below'}
                </button>
              ))}
            </div>
            <div className="nt-price">
              <button type="button" className="nt-step" onClick={() => setTargetC((valid ? targetC : nowC) - 1)} aria-label="One cent lower">
                −
              </button>
              <label className="nt-price-box">
                <input
                  ref={input}
                  inputMode="decimal"
                  value={target}
                  onChange={(e) => {
                    const v = e.target.value.replace(',', '.')
                    if (!/^\d{0,2}(\.\d?)?$/.test(v)) return
                    setTarget(v)
                    setSaved('')
                    const n = Number(v)
                    if (v && Number.isFinite(n)) setOp(n >= nowC ? 'above' : 'below')
                  }}
                  aria-label="Target price in cents"
                  aria-invalid={target !== '' && !valid}
                />
                <span aria-hidden="true">¢</span>
              </label>
              <button type="button" className="nt-step" onClick={() => setTargetC((valid ? targetC : nowC) + 1)} aria-label="One cent higher">
                +
              </button>
            </div>
            <div className="nt-quick">
              {[-10, -5, 5, 10].map((d) => (
                <button key={d} type="button" className="chip" disabled={nowC + d < MIN_C || nowC + d > MAX_C} onClick={() => setTargetC(nowC + d)}>
                  {d > 0 ? '+' : '−'}
                  {Math.abs(d)}¢
                </button>
              ))}
            </div>
            {alreadyTrue && <div className="nt-hint">It's already {op} that. Pick a price it hasn't reached yet.</div>}
            {target !== '' && !valid && <div className="nt-hint">Pick a price between 0.1¢ and 99.9¢.</div>}
            <button type="submit" className="block nt-set" disabled={!valid || alreadyTrue}>
              Set alert
            </button>
            <div className="nt-saved" role="status">
              {saved}
            </div>
          </form>
          {mine.length > 0 && (
            <ul className="nt-pop-list" aria-label="Alerts on this outcome">
              {mine.map((a) => (
                <li key={a.id} className={a.firedAt ? 'fired' : ''}>
                  <span className={`nt-op ${a.op}`} aria-hidden="true">
                    {a.op === 'above' ? '↑' : '↓'}
                  </span>
                  <span>
                    {a.op} <span className="num">{formatCents(a.price)}</span>
                    {a.firedAt && <span className="muted"> · fired</span>}
                  </span>
                  <button type="button" className="nt-remove" onClick={() => removeAlert(a.id)} aria-label={`Remove alert ${a.op} ${formatCents(a.price)}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
