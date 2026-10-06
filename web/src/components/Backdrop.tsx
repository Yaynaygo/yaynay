import { useEffect, useRef } from 'react'
import '../styles/backdrop.css'
import {
  candleAt,
  candleX,
  createRow,
  css,
  desaturate,
  fog,
  halfWidthAt,
  mix,
  newest,
  parseColor,
  projectX,
  projectY,
  stepRow,
  type Camera,
  type RGB,
  type Row,
} from '../lib/scene3d'

// Decorative 3D "candle field" behind the page: rows of candlestick prisms floating over a
// perspective floor, scrolling left like a live chart. It stays fixed behind the content while the
// page scrolls: scrolling down lifts the camera into an aerial view and pushes the chart along.
// Drawn on a 2D canvas with our own projection; calm by design, paused when hidden, static for
// reduced motion.

const FPS_INTERVAL = 1000 / 30
const MAX_DPR = 1.5
const SPEED = 0.2 // world units per second
const FOG_NEAR = 7
// Scroll response: how far down the page the camera finishes rising, how high it rises, and how much
// chart travel (world units) one pixel of scrolling adds.
const LIFT_SCROLL = 1400
const LIFT_HEIGHT = 2.6
const TRAVEL_PER_PX = 0.0025
const FOG_FAR = 40

// Rows from far to near (painter's order). Spacing grows with depth so screen density stays even.
const EYE = 3.2 // camera height above the floor
const ROWS = [
  { z: 34, base: 1.8, amp: 4.4, seed: 61 },
  { z: 25, base: 1.4, amp: 3.8, seed: 47 },
  { z: 18.5, base: 1.0, amp: 3.3, seed: 29 },
  { z: 13.5, base: 0.8, amp: 2.9, seed: 17 },
  { z: 10, base: 0.6, amp: 2.6, seed: 11 },
  { z: 7.5, base: 0.5, amp: 2.4, seed: 7 },
].map((r) => ({ ...r, spacing: 0.6 + 0.05 * r.z, width: 0.32, speed: SPEED }))

type Palette = {
  text: RGB
  dark: boolean
  // Per row: [front, top, side, wick] for up and down candles, already fogged.
  up: string[][]
  down: string[][]
  rowAlpha: number[]
  shadow: string
  upGlow: string
  downGlow: string
  ribbonGlow: string
  ribbonLine: string
}

function readPalette(): Palette {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const v = (name: string) => style.getPropertyValue(name)
  const dark = root.dataset.theme === 'dark'
  const bg = parseColor(v('--bg'), dark ? [16, 14, 21] : [247, 243, 234])
  const text = parseColor(v('--text'), dark ? [243, 239, 230] : [21, 19, 28])
  const yes = parseColor(v('--yes'), [14, 156, 98])
  const no = parseColor(v('--no'), [240, 74, 74])
  const ribbon = parseColor(v('--highlight'), [255, 200, 69])
  const white: RGB = [255, 255, 255]
  const black: RGB = [0, 0, 0]
  const faces = (base: RGB, f: number) => {
    const fogged = (c: RGB) => css(desaturate(mix(c, bg, f * 0.55), f * 0.6))
    return [
      fogged(base),
      fogged(mix(base, white, dark ? 0.32 : 0.36)),
      fogged(mix(base, black, dark ? 0.32 : 0.2)),
      fogged(mix(base, dark ? white : black, 0.12)),
    ]
  }
  const fogs = ROWS.map((r) => fog(r.z, FOG_NEAR, FOG_FAR))
  return {
    text,
    dark,
    up: fogs.map((f) => faces(yes, f)),
    down: fogs.map((f) => faces(no, f)),
    rowAlpha: fogs.map((f) => 1 - f * 0.72),
    shadow: css(dark ? black : text, dark ? 0.5 : 0.1),
    upGlow: css(yes, 0.9),
    downGlow: css(no, 0.9),
    ribbonGlow: css(ribbon, dark ? 0.22 : 0.3),
    ribbonLine: css(dark ? ribbon : mix(ribbon, text, 0.25), 0.95),
  }
}

export function Backdrop() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')

    let width = 0
    let height = 0
    let palette = readPalette()
    let rows: Row[] = []
    let gridFade: CanvasGradient | null = null
    const cam: Camera = { x: 0, y: EYE, focal: 900, cx: 0, horizon: 300 }
    // Parallax target in world units, eased toward each frame.
    const target = { x: 0, y: 0 }
    let t = 0
    // Total distance the chart has moved, for the floor grid (time plus scroll pushes).
    let travel = 0
    // Scroll state: camera lift (0 at the top of the page, 1 a screen or two down) and chart travel
    // still to be applied, spread over the next frames so it glides rather than jumps.
    let lift = 0
    let liftTarget = 0
    let pendingTravel = 0
    let lastScrollY = window.scrollY
    let baseHorizon = 300
    let last = 0
    let raf = 0
    let visible = true

    function layout() {
      const w = wrap!.clientWidth
      const h = wrap!.clientHeight
      if (!w || !h) return
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
      canvas!.width = Math.round(w * dpr)
      canvas!.height = Math.round(h * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      const widthChanged = w !== width
      width = w
      height = h
      cam.cx = w / 2
      baseHorizon = h * 0.2
      cam.horizon = baseHorizon - lift * h * 0.09
      cam.focal = h * 0.95 * Math.min(1.1, Math.max(0.55, w / 1280))
      gridFade = null
      // Rows depend on the visible width; rebuild them (same seeds) when it changes.
      if (widthChanged || !rows.length) {
        rows = ROWS.map((spec) => {
          const hw = halfWidthAt(cam, w, spec.z)
          return createRow(spec, -hw - 1.2 - spec.spacing, hw * 0.9)
        })
        for (const row of rows) stepRow(row, 0, t)
      }
    }

    function drawGrid() {
      const c = ctx!
      const floorTop = projectY(cam, 0, 60)
      if (!gridFade) {
        gridFade = c.createLinearGradient(0, floorTop, 0, height)
        const col = palette.text
        gridFade.addColorStop(0, css(col, 0))
        gridFade.addColorStop(0.3, css(col, palette.dark ? 0.08 : 0.1))
        gridFade.addColorStop(1, css(col, palette.dark ? 0.2 : 0.26))
      }
      c.strokeStyle = gridFade
      c.lineWidth = 1
      c.beginPath()
      // Lines running into the distance, scrolling left with the candles.
      const g = 1.6
      const scroll = travel
      const zNear = 3.2
      const zFar = 60
      const reach = halfWidthAt(cam, width, 30) + g
      const start = Math.floor((cam.x - reach + scroll) / g) * g - scroll
      for (let x = start; x <= cam.x + reach; x += g) {
        c.moveTo(projectX(cam, x, zNear), projectY(cam, 0, zNear))
        c.lineTo(projectX(cam, x, zFar), projectY(cam, 0, zFar))
      }
      // Cross lines, spaced evenly in depth.
      for (let z = 4; z <= 44; z += z < 12 ? 1.6 : 3.2) {
        const y = projectY(cam, 0, z)
        c.moveTo(0, y)
        c.lineTo(width, y)
      }
      c.stroke()
    }

    function drawRow(ri: number) {
      const c = ctx!
      const row = rows[ri]
      const z = row.z
      const half = (row.spacing * row.width) / 2
      const z0 = z - half
      const z1 = z + half
      const f = cam.focal
      const n = row.candles.length
      const live = newest(row)
      c.globalAlpha = palette.rowAlpha[ri]

      // Find the visible candle range.
      let first = n
      let lastI = -1
      for (let i = 0; i < n; i++) {
        const cx = candleX(row, candleAt(row, i))
        const sx = projectX(cam, cx, z)
        const r = (half * 2 * f) / z0
        if (sx + r < 0 || sx - r > width) continue
        if (i < first) first = i
        lastI = i
      }
      if (lastI < 0) return

      // Soft floor shadows, one path for the row.
      const sy0 = projectY(cam, 0, z0 + half * 0.4)
      const sy1 = projectY(cam, 0, z1 + half * 0.4)
      const sh = Math.abs(sy0 - sy1) * 0.7
      c.fillStyle = palette.shadow
      c.beginPath()
      const sy = (sy0 + sy1) / 2
      const rx = (half * 1.4 * f) / z
      for (let i = first; i <= lastI; i++) {
        const x = projectX(cam, candleX(row, candleAt(row, i)), z)
        c.moveTo(x + rx, sy)
        c.ellipse(x, sy, rx, sh + 0.5, 0, 0, Math.PI * 2)
      }
      c.globalAlpha = palette.rowAlpha[ri] * 0.6
      c.fill()
      c.globalAlpha = palette.rowAlpha[ri]

      // Wicks first (bodies cover their middle). Two passes: up then down.
      c.lineWidth = Math.max(1, (0.05 * f) / z)
      c.lineCap = 'round'
      for (let pass = 0; pass < 2; pass++) {
        c.strokeStyle = (pass === 0 ? palette.up : palette.down)[ri][3]
        c.beginPath()
        for (let i = first; i <= lastI; i++) {
          const cd = candleAt(row, i)
          if (cd.close >= cd.open !== (pass === 0)) continue
          const x = projectX(cam, candleX(row, cd), z)
          c.moveTo(x, projectY(cam, row.base + cd.high * row.amp, z))
          c.lineTo(x, projectY(cam, row.base + cd.low * row.amp, z))
        }
        c.stroke()
      }

      // Bodies: three faces each, batched by colour. Faces of one box never overlap each other and
      // neighbouring boxes are separated by gaps, so batching keeps painter's order correct.
      for (let pass = 0; pass < 2; pass++) {
        const cols = (pass === 0 ? palette.up : palette.down)[ri]
        for (let face = 0; face < 3; face++) {
          c.fillStyle = cols[face]
          c.beginPath()
          for (let i = first; i <= lastI; i++) {
            const cd = candleAt(row, i)
            if (cd.close >= cd.open !== (pass === 0)) continue
            if (cd === live) continue
            boxFace(c, row, cd, face, z0, z1, half)
          }
          c.fill()
        }
      }

      // The live candle, drawn alone so it can glow a little in dark mode.
      const up = live.close >= live.open
      const cols = (up ? palette.up : palette.down)[ri]
      const lx = projectX(cam, candleX(row, live), z)
      if (lx > -50 && lx < width + 50) {
        if (palette.dark) {
          c.shadowColor = up ? palette.upGlow : palette.downGlow
          c.shadowBlur = (16 * 7.5) / z
        }
        for (let face = 0; face < 3; face++) {
          c.fillStyle = cols[face]
          c.beginPath()
          boxFace(c, row, live, face, z0, z1, half)
          c.fill()
        }
        c.shadowBlur = 0
        c.shadowColor = 'transparent'
      }
      c.globalAlpha = 1
    }

    // Adds one face of a candle body to the current path: 0 front, 1 top/bottom, 2 side.
    function boxFace(c: CanvasRenderingContext2D, row: Row, cd: Row['candles'][number], face: number, z0: number, z1: number, half: number) {
      const x = candleX(row, cd)
      const x0 = x - half
      const x1 = x + half
      let lo = row.base + Math.min(cd.open, cd.close) * row.amp
      let hi = row.base + Math.max(cd.open, cd.close) * row.amp
      const minH = 0.03
      if (hi - lo < minH) {
        const mid = (hi + lo) / 2
        lo = mid - minH / 2
        hi = mid + minH / 2
      }
      if (face === 0) {
        const ax = projectX(cam, x0, z0)
        const ay = projectY(cam, hi, z0)
        c.rect(ax, ay, projectX(cam, x1, z0) - ax, projectY(cam, lo, z0) - ay)
      } else if (face === 1) {
        // Top when it is below eye level, bottom when above.
        const y = hi < cam.y ? hi : lo
        c.moveTo(projectX(cam, x0, z0), projectY(cam, y, z0))
        c.lineTo(projectX(cam, x1, z0), projectY(cam, y, z0))
        c.lineTo(projectX(cam, x1, z1), projectY(cam, y, z1))
        c.lineTo(projectX(cam, x0, z1), projectY(cam, y, z1))
        c.closePath()
      } else {
        // The side facing the camera: right face for boxes left of it, left face otherwise.
        let sx: number
        if (x1 < cam.x) sx = x1
        else if (x0 > cam.x) sx = x0
        else return
        c.moveTo(projectX(cam, sx, z0), projectY(cam, hi, z0))
        c.lineTo(projectX(cam, sx, z1), projectY(cam, hi, z1))
        c.lineTo(projectX(cam, sx, z1), projectY(cam, lo, z1))
        c.lineTo(projectX(cam, sx, z0), projectY(cam, lo, z0))
        c.closePath()
      }
    }

    // A smooth translucent curve through the front row's closes, like a probability line.
    function drawRibbon() {
      const c = ctx!
      const row = rows[rows.length - 1]
      const half = (row.spacing * row.width) / 2
      const z = row.z - half
      const n = row.candles.length
      c.beginPath()
      let px = 0
      let py = 0
      for (let i = 0; i < n; i++) {
        const cd = candleAt(row, i)
        const x = projectX(cam, candleX(row, cd), z)
        const y = projectY(cam, row.base + cd.close * row.amp, z)
        if (i === 0) c.moveTo(x, y)
        else c.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2)
        px = x
        py = y
      }
      c.lineTo(px, py)
      c.lineJoin = 'round'
      c.lineCap = 'round'
      c.strokeStyle = palette.ribbonGlow
      c.lineWidth = 9
      c.stroke()
      c.strokeStyle = palette.ribbonLine
      c.lineWidth = 2
      c.stroke()
      // Pulsing dot on the live close.
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4)
      c.fillStyle = palette.ribbonGlow
      c.beginPath()
      c.arc(px, py, 7 + pulse * 6, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = palette.ribbonLine
      c.beginPath()
      c.arc(px, py, 3.5, 0, Math.PI * 2)
      c.fill()
    }

    function draw() {
      if (!width) return
      ctx!.clearRect(0, 0, width, height)
      drawGrid()
      for (let i = 0; i < rows.length; i++) drawRow(i)
      drawRibbon()
    }

    function frame(now: number) {
      raf = requestAnimationFrame(frame)
      const elapsed = now - last
      if (elapsed < FPS_INTERVAL - 2) return
      // Clamp so a long pause does not fast-forward the scene.
      const dt = Math.min(0.1, elapsed / 1000)
      last = now
      t += dt
      const k = Math.min(1, dt * 2.5)
      lift += (liftTarget - lift) * Math.min(1, dt * 3)
      cam.x += (target.x - cam.x) * k
      cam.y += (EYE + lift * LIFT_HEIGHT + target.y - cam.y) * k
      cam.horizon = baseHorizon - lift * height * 0.09
      const push = pendingTravel * Math.min(1, dt * 4)
      pendingTravel -= push
      travel += SPEED * dt + push
      for (const row of rows) {
        row.scroll += push
        stepRow(row, dt, t)
      }
      draw()
    }

    function update() {
      const run = visible && !document.hidden && !reduced.matches
      if (run && !raf) {
        last = performance.now()
        raf = requestAnimationFrame(frame)
      } else if (!run && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
      if (!run) draw()
    }

    // Scrolling either way pushes the chart forward (rows only ever move left) and lifts the camera.
    function onScroll() {
      const y = window.scrollY
      pendingTravel = Math.min(6, pendingTravel + Math.min(400, Math.abs(y - lastScrollY)) * TRAVEL_PER_PX)
      lastScrollY = y
      const p = Math.min(1, y / LIFT_SCROLL)
      liftTarget = p * p * (3 - 2 * p)
    }

    function onPointer(e: PointerEvent) {
      if (e.pointerType !== 'mouse' || !finePointer.matches) return
      target.x = (e.clientX / window.innerWidth - 0.5) * 0.9
      target.y = (0.5 - e.clientY / window.innerHeight) * 0.35
    }

    onScroll()
    pendingTravel = 0
    lift = liftTarget
    cam.y = EYE + lift * LIFT_HEIGHT
    layout()
    draw()
    update()

    const resize = new ResizeObserver(() => {
      layout()
      draw()
    })
    resize.observe(wrap)
    const io = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting
      update()
    })
    io.observe(wrap)
    const themeObserver = new MutationObserver(() => {
      palette = readPalette()
      gridFade = null
      draw()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-brand'] })
    document.addEventListener('visibilitychange', update)
    reduced.addEventListener('change', update)
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      cancelAnimationFrame(raf)
      raf = 0
      resize.disconnect()
      io.disconnect()
      themeObserver.disconnect()
      document.removeEventListener('visibilitychange', update)
      reduced.removeEventListener('change', update)
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('scroll', onScroll)
    }
  }, [])

  return (
    <div className="backdrop3d" ref={wrapRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  )
}
