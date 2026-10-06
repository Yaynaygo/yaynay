import { useEffect, useId, useState, type CSSProperties } from 'react'
import { markQuestsSeen, useProgress, type ChapterState, type QuestState } from '../lib/progress'
import { LEVELS, type Chapter } from '../lib/quests'
import '../styles/quests.css'

const QUESTS_HREF = '#/quests'

/** Quest checkbox drawn as a candle: an unlit outline that fills with wax as progress grows, then lights. */
export function QuestCandle({ progress, done, size = 34 }: { progress: number; done: boolean; size?: number }) {
  const clip = useId()
  const fill = done ? 1 : Math.max(0, Math.min(1, progress))
  const h = 15 * fill
  return (
    <svg className={`qs-candle${done ? ' lit' : ''}`} width={(size * 22) / 30} height={size} viewBox="0 0 22 30" aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <rect x="5" y={25 - h} width="12" height={h} />
        </clipPath>
      </defs>
      <path className="qs-candle-wick" d="M11 7.5v20" />
      <rect className="qs-candle-body" x="5" y="10" width="12" height="15" rx="3" />
      {fill > 0 && <rect className="qs-candle-wax" x="5" y="10" width="12" height="15" rx="3" clipPath={`url(#${clip})`} />}
      {done && <path className="qs-candle-flame" d="M11 1.2c1.9 2 3 3.4 3 4.8a3 3 0 0 1-6 0c0-1.4 1.1-2.8 3-4.8z" />}
    </svg>
  )
}

/** Level emblem: a ring that fills toward the next level around a candle that brightens with total XP. */
function LevelEmblem({ xp, totalXp, levelIndex, progress }: { xp: number; totalXp: number; levelIndex: number; progress: number }) {
  const id = useId()
  const r = 52
  const c = 2 * Math.PI * r
  const lit = Math.min(1, xp / totalXp)
  const flame = xp > 0 ? 0.55 + 0.45 * (levelIndex / (LEVELS.length - 1)) : 0
  return (
    <svg className="qs-emblem" viewBox="0 0 132 132" role="img" aria-label={`Level ${levelIndex + 1}, ${Math.round(progress * 100)}% to the next level`}>
      <defs>
        <linearGradient id={`${id}-ring`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--yes)" />
          <stop offset="1" stopColor="var(--highlight)" />
        </linearGradient>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" stopColor="var(--highlight)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--highlight)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="66" cy="66" r={r} className="qs-emblem-track" />
      <circle
        cx="66"
        cy="66"
        r={r}
        className="qs-emblem-ring"
        stroke={`url(#${id}-ring)`}
        strokeDasharray={`${c * progress} ${c}`}
        transform="rotate(-90 66 66)"
      />
      <circle cx="66" cy="66" r="42" className="qs-emblem-disc" />
      {LEVELS.map((_, i) => {
        // Level pips along the bottom of the disc.
        const a = Math.PI / 2 + (i - (LEVELS.length - 1) / 2) * 0.32
        return <circle key={i} cx={66 + 34 * Math.cos(a)} cy={66 + 34 * Math.sin(a)} r="2.4" className={`qs-pip${i <= levelIndex ? ' on' : ''}`} />
      })}
      {flame > 0 && <circle cx="66" cy="44" r={22 * flame} fill={`url(#${id}-glow)`} className="qs-glow" />}
      <path d="M66 38v50" className="qs-emblem-wick" />
      <rect x="55" y="50" width="22" height="34" rx="6" className="qs-emblem-body" />
      <rect x="55" y="50" width="22" height="34" rx="6" className="qs-emblem-wax" style={{ opacity: 0.18 + 0.82 * lit }} />
      {flame > 0 && (
        <g className="qs-emblem-flame" style={{ transform: `scale(${flame})` }}>
          <path d="M66 25c4 4.4 6.2 7.6 6.2 10.6a6.2 6.2 0 0 1-12.4 0c0-3 2.2-6.2 6.2-10.6z" fill="var(--highlight)" />
          <path d="M66 31.5c1.8 2 2.8 3.4 2.8 4.8a2.8 2.8 0 0 1-5.6 0c0-1.4 1-2.8 2.8-4.8z" fill="var(--no)" opacity="0.85" />
        </g>
      )}
    </svg>
  )
}

function Flame({ on }: { on: boolean }) {
  return (
    <svg className={`qs-flame${on ? ' on' : ''}`} width="14" height="20" viewBox="0 0 14 20" aria-hidden="true">
      <path d="M7 1c3 3.2 5 5.6 5 8.4A5 5 0 0 1 2 9.4C2 6.6 4 4.2 7 1z" />
      <rect x="4.5" y="14" width="5" height="5.5" rx="1.4" />
    </svg>
  )
}

const TONE_GLYPH: Record<Chapter['badge']['tone'], string> = {
  yes: '#fffdf8',
  highlight: '#15131c',
  no: '#fffdf8',
  ink: 'var(--ink-text)',
}

const SHAPES: Record<Chapter['badge']['shape'], string> = {
  shield: 'M50 5 L89 19 V49 C89 73 72 88 50 96 C28 88 11 73 11 49 V19 Z',
  hex: 'M50 4 L90 27 V73 L50 96 L10 73 V27 Z',
  diamond: 'M50 3 L95 50 L50 97 L5 50 Z',
  round: 'M50 5 A45 45 0 1 1 49.9 5 Z',
}

/** One emblem per chapter; each shows its own little candle scene. */
export function BadgeEmblem({ chapter, unlocked, size = 72 }: { chapter: Chapter; unlocked: boolean; size?: number }) {
  const { shape, tone } = chapter.badge
  const g = TONE_GLYPH[tone]
  return (
    <svg className={`qs-emblem-badge tone-${tone}${unlocked ? '' : ' locked'}`} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <path d={SHAPES[shape]} className="qs-badge-shape" />
      <path d={SHAPES[shape]} className="qs-badge-inner" transform="translate(50 50) scale(0.84) translate(-50 -50)" />
      {chapter.id === 'rookie' && (
        <g>
          <path d="M50 30v44" stroke={g} strokeWidth="3" strokeLinecap="round" />
          <rect x="42" y="42" width="16" height="26" rx="4" fill={g} />
          <path d="M50 18c3.4 3.6 5.2 6.2 5.2 8.8a5.2 5.2 0 0 1-10.4 0c0-2.6 1.8-5.2 5.2-8.8z" fill="#ffc845" stroke="#15131c" strokeWidth="1.2" />
        </g>
      )}
      {chapter.id === 'room' && (
        <g stroke={g} strokeWidth="2.6" strokeLinecap="round">
          <path d="M32 40v28M50 30v34M68 26v26" />
          <rect x="27" y="46" width="10" height="16" rx="2.5" fill={g} stroke="none" />
          <rect x="45" y="36" width="10" height="20" rx="2.5" fill="none" />
          <rect x="63" y="30" width="10" height="16" rx="2.5" fill={g} stroke="none" />
          <path d="M26 74h48" strokeWidth="2" opacity="0.6" />
        </g>
      )}
      {chapter.id === 'habits' && (
        <g>
          <path d="M40 34v34M60 30v34" stroke={g} strokeWidth="2.8" strokeLinecap="round" />
          <rect x="33" y="42" width="14" height="20" rx="3.5" fill={g} />
          <rect x="53" y="38" width="14" height="20" rx="3.5" fill={g} />
          <path d="M30 70h40" stroke={g} strokeWidth="3" strokeLinecap="round" />
        </g>
      )}
      {chapter.id === 'explorer' && (
        <g>
          <path d="M66 22a10 10 0 1 0 8 15 8 8 0 1 1-8-15z" fill="#ffc845" />
          <path d="M40 32v38" stroke="var(--yes)" strokeWidth="2.8" strokeLinecap="round" />
          <rect x="34" y="38" width="12" height="20" rx="3" fill="var(--yes)" />
          <path d="M58 46v28" stroke="var(--no)" strokeWidth="2.8" strokeLinecap="round" />
          <rect x="52" y="52" width="12" height="16" rx="3" fill="var(--no)" />
        </g>
      )}
      {!unlocked && (
        <g className="qs-lock" transform="translate(64 64)">
          <circle cx="14" cy="14" r="14" />
          <path d="M9.5 13v-3a4.5 4.5 0 0 1 9 0v3" fill="none" strokeWidth="2.2" />
          <rect x="7.5" y="13" width="13" height="9.5" rx="2.4" />
        </g>
      )}
    </svg>
  )
}

function Bar({ value, className = '' }: { value: number; className?: string }) {
  return (
    <span className={`qs-bar ${className}`} aria-hidden="true">
      <span style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </span>
  )
}

function QuestRow({ s, fresh }: { s: QuestState; fresh: boolean }) {
  const q = s.quest
  return (
    <li className={`qs-quest${s.done ? ' done' : ''}${fresh ? ' fresh' : ''}`}>
      <QuestCandle progress={s.progress / s.goal} done={s.done} />
      <div className="qs-q-main">
        <div className="qs-q-title">
          <span className="qs-q-name">{q.name}</span>
          {fresh && <span className="qs-new">New</span>}
          {!s.done && q.needsWallet && (
            <span className="qs-wallet" title="Needs a connected wallet">
              wallet
            </span>
          )}
        </div>
        <div className="qs-q-detail">
          <div>
            <p className="qs-q-desc">{q.description}</p>
            {s.goal > 1 && (
              <div className="qs-q-progress" title={q.how}>
                <Bar value={s.progress / s.goal} />
                <span className="num">
                  {s.progress}/{s.goal}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      <span className={`qs-xp${s.done ? ' earned' : ''}`} title={q.how}>
        +{q.xp} XP
      </span>
      {s.done ? (
        <span className="qs-done-mark" aria-label="Done">
          ✓
        </span>
      ) : q.cta.href ? (
        <a className="qs-go" href={q.cta.href}>
          {q.cta.label} →
        </a>
      ) : (
        <span className="qs-go hint">{q.how.replace(/\.$/, '')}</span>
      )}
    </li>
  )
}

function ChapterCard({ c, fresh }: { c: ChapterState; fresh: Set<string> }) {
  return (
    <section className={`card qs-chapter${c.complete ? ' complete' : ''}`} aria-labelledby={`qs-ch-${c.chapter.id}`}>
      <header className="qs-ch-head">
        <BadgeEmblem chapter={c.chapter} unlocked={c.complete} size={46} />
        <div className="qs-ch-text">
          <h2 id={`qs-ch-${c.chapter.id}`}>{c.chapter.name}</h2>
          <p>{c.chapter.tagline}</p>
        </div>
        <div className="qs-ch-count">
          <span className="num">
            {c.done}/{c.total}
          </span>
          <span className="qs-segs" aria-hidden="true">
            {c.quests.map((s) => (
              <i key={s.quest.id} className={s.done ? 'on' : ''} />
            ))}
          </span>
        </div>
      </header>
      <ul className="qs-list">
        {c.quests.map((s) => (
          <QuestRow key={s.quest.id} s={s} fresh={fresh.has(s.quest.id)} />
        ))}
      </ul>
      {c.complete && <p className="qs-ch-done">Badge unlocked · {c.chapter.badge.name}</p>}
    </section>
  )
}

// Deterministic scatter for the celebration burst (no layout jank between renders).
const SPARKS = Array.from({ length: 28 }, (_, i) => {
  const a = (i / 28) * Math.PI * 2 + (i % 3) * 0.4
  const dist = 90 + ((i * 37) % 110)
  return {
    x: Math.round(Math.cos(a) * dist * 1.6),
    y: Math.round(Math.sin(a) * dist - 60),
    r: ((i * 53) % 90) - 45,
    d: (i % 7) * 45,
    tone: i % 2 ? 'no' : 'yes',
    h: 10 + ((i * 7) % 9),
  }
})

function Burst() {
  return (
    <div className="qs-burst" aria-hidden="true">
      {SPARKS.map((s, i) => (
        <span
          key={i}
          className={`qs-spark ${s.tone}`}
          style={{ '--x': `${s.x}px`, '--y': `${s.y}px`, '--r': `${s.r}deg`, '--d': `${s.d}ms`, '--h': `${s.h}px` } as CSSProperties}
        />
      ))}
    </div>
  )
}

export function Quests(props: { connected: boolean }) {
  const p = useProgress()
  // Captured on arrival: what finished since the last visit gets the confetti and a "New" tag.
  const [fresh] = useState(() => new Set(p.quests.filter((s) => s.isNew).map((s) => s.quest.id)))
  const [burst, setBurst] = useState(fresh.size > 0)

  useEffect(() => {
    markQuestsSeen()
    const t = setTimeout(() => setBurst(false), 2600)
    return () => {
      clearTimeout(t)
      markQuestsSeen()
    }
  }, [])

  const { level, streak } = p
  const toNext = level.next === null ? 0 : level.next - p.xp

  return (
    <div className="qs-page">
      <div className="section-head">
        <div>
          <div className="eyebrow accent">Quests</div>
          <h1>Light every candle.</h1>
          <p className="qs-lead">Short quests that teach the ropes: the bridge, the book, the habits that keep you sharp.</p>
        </div>
      </div>

      {!props.connected && (
        <div className="qs-guest">
          <QuestCandle progress={0.4} done={false} size={22} />
          <p>
            You're playing as a guest. Progress lives in this browser for now and moves to your wallet the moment you connect, then
            saves per wallet.
          </p>
        </div>
      )}

      <section className="card qs-hero">
        {burst && <Burst />}
        <div className="qs-hero-emblem">
          <LevelEmblem xp={p.xp} totalXp={p.totalXp} levelIndex={level.index} progress={level.progress} />
        </div>
        <div className="qs-hero-main">
          <div className="eyebrow">
            Level {level.index + 1} of {LEVELS.length}
          </div>
          <h2 className="qs-level">
            {level.name}
            {fresh.size > 0 && <span className="qs-fresh-chip">+{fresh.size} new</span>}
          </h2>
          <div className="qs-xpline">
            <span className="num">
              <b>{p.xp}</b> XP
            </span>
            <span className="muted num">{level.next === null ? 'Max level. Every candle lit.' : `${toNext} XP to ${level.nextName}`}</span>
          </div>
          <Bar value={level.progress} className="big" />
          {p.recent.length > 0 && (
            <p className="qs-recent">
              <span className="eyebrow">Latest</span> {p.recent.slice(0, 3).map((r) => r.quest.name).join(' · ')}
            </p>
          )}
        </div>
        <div className="qs-hero-side">
          <div className="qs-side-block">
            <div className="eyebrow">Streak</div>
            <div className="qs-flames" aria-label={`${streak.current}-day streak`}>
              {Array.from({ length: 7 }, (_, i) => (
                <Flame key={i} on={i < Math.min(7, streak.current)} />
              ))}
            </div>
            <div className="qs-side-val num">
              {streak.current} {streak.current === 1 ? 'day' : 'days'}
              {streak.best > streak.current && <span className="muted"> · best {streak.best}</span>}
            </div>
          </div>
          <div className="qs-side-block">
            <div className="eyebrow">Quests done</div>
            <div className="qs-side-val num">
              <b>{p.doneCount}</b>
              <span className="muted"> / {p.totalCount}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="card qs-shelf" aria-label="Badges">
        <div className="qs-shelf-head">
          <h2>Badge shelf</h2>
          <span className="muted">One per chapter. Finish them all to fill the shelf.</span>
        </div>
        <ul className="qs-badges">
          {p.badges.map((b) => (
            <li key={b.chapter.id} className={`qs-badge${b.unlocked ? ' unlocked' : ''}`} tabIndex={0} aria-describedby={`qs-tip-${b.chapter.id}`}>
              <BadgeEmblem chapter={b.chapter} unlocked={b.unlocked} size={76} />
              <span className="qs-badge-name">{b.chapter.badge.name}</span>
              <span className="qs-tip" role="tooltip" id={`qs-tip-${b.chapter.id}`}>
                <b>{b.chapter.badge.name}</b>
                {b.unlocked ? `Unlocked: you finished ${b.chapter.name}.` : b.chapter.badge.earn}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="qs-chapters">
        {p.chapters.map((c) => (
          <ChapterCard key={c.chapter.id} c={c} fresh={fresh} />
        ))}
      </div>

      <p className="qs-fineprint">
        <b>Just for fun:</b> XP has no monetary value. Quests never ask you to trade more or bigger; the trading ones are one-offs, and
        a few dollars is plenty.
      </p>
    </div>
  )
}

/** One-line home-page nudge toward the next unfinished quest. Hides once every quest is done. */
export function QuestNudge() {
  const p = useProgress()
  const s = p.next
  if (!s) return null
  const q = s.quest
  return (
    <div className="card qs-nudge">
      <QuestCandle progress={s.progress / s.goal} done={false} size={30} />
      <div className="qs-nudge-text">
        <div className="eyebrow">
          Next quest · <a href={QUESTS_HREF}>{p.level.name}</a>
        </div>
        <div className="qs-nudge-name">
          <b>{q.name}</b>
          <span className="qs-nudge-desc">{q.description}</span>
        </div>
      </div>
      <div className="qs-nudge-xp" title={`${p.xp} XP · ${p.level.name}`}>
        <Bar value={p.level.progress} />
        <span className="qs-xp">+{q.xp} XP</span>
      </div>
      {q.cta.href ? (
        <a className="qs-go" href={q.cta.href}>
          {q.cta.label} →
        </a>
      ) : (
        <a className="qs-go" href={QUESTS_HREF}>
          Quests →
        </a>
      )}
    </div>
  )
}
