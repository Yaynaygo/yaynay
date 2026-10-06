import { describe, expect, it } from 'vitest'
import {
  candleAt,
  candleX,
  createRow,
  css,
  desaturate,
  fog,
  halfWidthAt,
  mulberry32,
  newest,
  parseColor,
  projectX,
  projectY,
  stepRow,
  type Camera,
} from './scene3d'

const spec = { z: 10, spacing: 1, width: 0.4, base: 0.5, amp: 2, speed: 0.25, seed: 7 }

describe('scene3d', () => {
  it('seeded RNG is deterministic and in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 100; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('projects with perspective around the horizon', () => {
    const cam: Camera = { x: 0, y: 2, focal: 500, cx: 400, horizon: 200 }
    expect(projectX(cam, 0, 10)).toBe(400)
    expect(projectX(cam, 1, 10)).toBe(450)
    expect(projectX(cam, 1, 20)).toBe(425)
    // Eye level maps to the horizon; the floor lies below it and rises toward it with depth.
    expect(projectY(cam, 2, 7)).toBe(200)
    expect(projectY(cam, 0, 10)).toBe(300)
    expect(projectY(cam, 0, 20)).toBe(250)
    expect(halfWidthAt(cam, 800, 10)).toBe(8)
  })

  it('builds a row that covers the requested range with the live candle on the right', () => {
    const row = createRow(spec, -6, 5)
    expect(candleX(row, newest(row))).toBeCloseTo(5)
    expect(candleX(row, candleAt(row, 0))).toBeLessThanOrEqual(-6)
    for (let i = 1; i < row.candles.length; i++) {
      const prev = candleAt(row, i - 1)
      const c = candleAt(row, i)
      expect(c.open).toBeCloseTo(prev.target)
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.target))
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.target))
    }
  })

  it('is deterministic for a seed', () => {
    const a = createRow(spec, -6, 5)
    const b = createRow(spec, -6, 5)
    expect(a.candles.map((c) => c.target)).toEqual(b.candles.map((c) => c.target))
  })

  it('scrolls left and recycles candles without allocating new ones', () => {
    const row = createRow(spec, -6, 5)
    const pool = new Set(row.candles)
    const firstLive = newest(row).index
    let t = 0
    // 4 s per spacing at this speed; run 30 s at 30 fps.
    for (let i = 0; i < 900; i++) {
      t += 1 / 30
      stepRow(row, 1 / 30, t)
    }
    expect(newest(row).index).toBe(firstLive + 7)
    expect(row.candles.every((c) => pool.has(c))).toBe(true)
    // The live candle is always within one spacing left of the spawn point.
    const x = candleX(row, newest(row))
    expect(x).toBeLessThanOrEqual(5)
    expect(x).toBeGreaterThan(4)
    // Indices stay contiguous and prices stay in range.
    for (let i = 1; i < row.candles.length; i++) {
      expect(candleAt(row, i).index).toBe(candleAt(row, i - 1).index + 1)
      expect(candleAt(row, i).target).toBeGreaterThanOrEqual(0.06)
      expect(candleAt(row, i).target).toBeLessThanOrEqual(0.94)
    }
    // Finalised candles close at their target; the open of each equals the previous close.
    for (let i = 1; i < row.candles.length - 1; i++) {
      expect(candleAt(row, i).close).toBe(candleAt(row, i).target)
      expect(candleAt(row, i).open).toBe(candleAt(row, i - 1).close)
    }
  })

  it('parses theme colours', () => {
    expect(parseColor('#f7f3ea', [0, 0, 0])).toEqual([247, 243, 234])
    expect(parseColor(' #fff ', [0, 0, 0])).toEqual([255, 255, 255])
    expect(parseColor('rgba(12, 143, 87, 0.12)', [0, 0, 0])).toEqual([12, 143, 87])
    expect(parseColor('oklch(0.7 0.1 150)', [1, 2, 3])).toEqual([1, 2, 3])
    expect(css([255.4, -3, 10])).toBe('rgb(255,0,10)')
    expect(css([1, 2, 3], 0.5)).toBe('rgba(1,2,3,0.500)')
    expect(desaturate([255, 0, 0], 1).every((v) => Math.abs(v - 76.245) < 1e-9)).toBe(true)
  })

  it('fog ramps smoothly from near to far', () => {
    expect(fog(5, 7, 40)).toBe(0)
    expect(fog(50, 7, 40)).toBe(1)
    expect(fog(23.5, 7, 40)).toBeCloseTo(0.5)
  })
})
