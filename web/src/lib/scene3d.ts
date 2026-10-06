// Pure math for the 3D "candle field" backdrop: a seeded RNG, a pinhole camera projection, rows of
// candlestick price walks that scroll left, and colour helpers. No DOM access, so it is testable.

/** Small, fast seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Camera looking down +z with no roll or pitch. World: x right, y up, floor at y = 0.
 * The horizon (y = camY at infinity) sits at screen row `horizon`.
 */
export type Camera = { x: number; y: number; focal: number; cx: number; horizon: number }

export function projectX(cam: Camera, x: number, z: number): number {
  return cam.cx + ((x - cam.x) * cam.focal) / z
}

export function projectY(cam: Camera, y: number, z: number): number {
  return cam.horizon - ((y - cam.y) * cam.focal) / z
}

/** Half the world width visible at depth z for a screen of the given width. */
export function halfWidthAt(cam: Camera, screenWidth: number, z: number): number {
  return ((screenWidth / 2) * z) / cam.focal
}

export type Candle = {
  open: number
  close: number
  high: number
  low: number
  /** Where the live candle's close is heading; equals close once finalised. */
  target: number
  /** Global index along the row; x = index * spacing - scroll. */
  index: number
}

export type Row = {
  z: number
  spacing: number
  /** Body width as a fraction of spacing. */
  width: number
  /** Floor-to-price mapping: y = base + price * amp (price is a 0..1 probability). */
  base: number
  amp: number
  /** World units per second. */
  speed: number
  /** World x where a new live candle appears; it then drifts left by one spacing. */
  right: number
  scroll: number
  /** Ring buffer of candles, oldest first starting at `head`. */
  candles: Candle[]
  head: number
  rand: () => number
}

export type RowSpec = { z: number; spacing: number; width: number; base: number; amp: number; speed: number; seed: number }

/** A row whose candles cover world x from `left` to `right`; the newest (live) one sits at `right`. */
export function createRow(spec: RowSpec, left: number, right: number): Row {
  const count = Math.max(3, Math.ceil((right - left) / spec.spacing) + 2)
  const rand = mulberry32(spec.seed)
  const row: Row = { ...spec, right, scroll: -right, candles: [], head: 0, rand }
  let price = 0.35 + rand() * 0.3
  for (let i = 0; i < count; i++) {
    const c: Candle = { open: 0, close: 0, high: 0, low: 0, target: 0, index: i - count + 1 }
    fillCandle(c, price, rand)
    if (i < count - 1) finalise(c)
    price = c.target
    row.candles.push(c)
  }
  return row
}

/** One step of a mean-reverting random walk on [0.06, 0.94], with wicks around the body. */
export function fillCandle(c: Candle, open: number, rand: () => number) {
  const drift = (0.5 - open) * 0.15
  const step = (rand() + rand() + rand() - 1.5) * 0.22
  const close = Math.min(0.94, Math.max(0.06, open + drift + step))
  c.open = open
  c.target = close
  c.close = open
  c.high = Math.max(open, close) + rand() * rand() * 0.09 + 0.012
  c.low = Math.min(open, close) - rand() * rand() * 0.09 - 0.012
}

export function newest(row: Row): Candle {
  return row.candles[(row.head + row.candles.length - 1) % row.candles.length]
}

export function candleAt(row: Row, i: number): Candle {
  return row.candles[(row.head + i) % row.candles.length]
}

/**
 * Advance a row by dt seconds at time t. The newest candle is "live": its close eases toward its
 * target and wiggles a little. Once it has drifted one spacing left, it is finalised and the
 * oldest candle is recycled as the next live one on the right (no allocation).
 */
export function stepRow(row: Row, dt: number, t: number) {
  row.scroll += row.speed * dt
  let live = newest(row)
  while (candleX(row, live) <= row.right - row.spacing) {
    finalise(live)
    const recycled = row.candles[row.head]
    row.head = (row.head + 1) % row.candles.length
    recycled.index = live.index + 1
    fillCandle(recycled, live.close, row.rand)
    live = recycled
  }
  const p = Math.min(1, Math.max(0, (row.right - candleX(row, live)) / row.spacing))
  const ease = 1 - (1 - p) * (1 - p)
  const wiggle = Math.sin(t * 2.3 + live.index) * 0.014 + Math.sin(t * 5.1 + live.index * 1.7) * 0.007
  live.close = live.open + (live.target - live.open) * ease + wiggle * (1 - p * 0.6)
  if (live.close > live.high) live.high = live.close
  if (live.close < live.low) live.low = live.close
}

function finalise(c: Candle) {
  c.close = c.target
  c.high = Math.max(c.high, c.open, c.close)
  c.low = Math.min(c.low, c.open, c.close)
}

/** World x of a candle's centre. */
export function candleX(row: Row, c: Candle): number {
  return c.index * row.spacing - row.scroll
}

export type RGB = [number, number, number]

/** Parse #rgb, #rrggbb or rgb()/rgba(); returns the fallback for anything else. */
export function parseColor(input: string, fallback: RGB): RGB {
  const s = input.trim()
  let m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as RGB
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s)
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  return fallback
}

/** Linear mix: t = 0 gives a, t = 1 gives b. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Pull a colour toward its own grey by `amount` (0 keeps it, 1 is fully grey). */
export function desaturate(c: RGB, amount: number): RGB {
  const g = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114
  return mix(c, [g, g, g], amount)
}

export function css(c: RGB, alpha = 1): string {
  const r = Math.round(Math.min(255, Math.max(0, c[0])))
  const g = Math.round(Math.min(255, Math.max(0, c[1])))
  const b = Math.round(Math.min(255, Math.max(0, c[2])))
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha.toFixed(3)})`
}

/** 0 at `near`, 1 at `far`, smooth in between. */
export function fog(z: number, near: number, far: number): number {
  const t = Math.min(1, Math.max(0, (z - near) / (far - near)))
  return t * t * (3 - 2 * t)
}
