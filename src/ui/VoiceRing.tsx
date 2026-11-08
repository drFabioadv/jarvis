import { useEffect, useRef } from 'react'
import { useStore, type Phase } from '../store'
import { BANDS, readJarvis } from '../lib/spectrum'
import { micBands } from '../lib/audio'

/**
 * O anel de voz em volta do reator.
 *
 * Barras radiais espelhadas — graves no topo, agudos descendo pelos lados —
 * que sobem e descem com a tonalidade da fala: a voz dele quando ele
 * responde, o seu microfone quando é você falando. Em volta, anéis de HUD
 * girando em sentidos opostos e uma auréola que acompanha o contorno da voz.
 *
 * Paleta: azul nos graves, roxo nos médios, laranja nos agudos. Quando é você
 * falando, tudo puxa para o azul; quando ele está pensando, um cometa laranja
 * corre em volta do anel.
 *
 * Canvas 2D por cima da cena 3D, sem eventos de ponteiro. Brilho feito com
 * duas passadas (uma larga e fraca, outra fina e forte) em vez de shadowBlur,
 * que custa caro num notebook.
 */

const BARS_PER_SIDE = 64

const BLUE: RGB = [61, 139, 255]
const PURPLE: RGB = [160, 92, 255]
const ORANGE: RGB = [255, 138, 61]
const ICE: RGB = [120, 210, 255]
type RGB = [number, number, number]

const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]
/** Cor da banda: azul → roxo → laranja ao longo das frequências. */
const bandColour = (t: number): RGB => (t < 0.5 ? mix(BLUE, PURPLE, t * 2) : mix(PURPLE, ORANGE, (t - 0.5) * 2))
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`

/** Quanto cada fase acende o anel. */
const PRESENCE: Record<Phase, number> = {
  offline: 0,
  boot: 0.6,
  dormant: 0.55,
  waking: 1,
  listening: 1,
  thinking: 0.9,
  tooling: 0.9,
  speaking: 1,
}

export function VoiceRing() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const g = canvas.getContext('2d')
    if (!g) return

    const mic = new Float32Array(BANDS)
    const shown = new Float32Array(BANDS)
    let raf = 0
    let w = 0
    let h = 0
    let dpr = 1
    let presence = 0
    let userMix = 0 // 0 = voz dele, 1 = sua voz
    let comet = 0 // 0..1, intensidade do cometa de "pensando"

    const resize = () => {
      dpr = Math.min(1.5, window.devicePixelRatio || 1)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    /** Valor de uma banda em posição contínua (0..1), interpolado. */
    const sample = (arr: Float32Array, t: number) => {
      const x = t * (BANDS - 1)
      const i = Math.floor(x)
      const f = x - i
      return arr[i] * (1 - f) + (arr[Math.min(BANDS - 1, i + 1)] ?? 0) * f
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const s = useStore.getState()
      const phase = s.phase
      const reactor = s.ui.reactor
      const time = now / 1000

      presence += ((reactor.visible ? PRESENCE[phase] : 0) - presence) * 0.06
      const userTalking = phase === 'listening' || phase === 'waking'
      userMix += ((userTalking ? 1 : 0) - userMix) * 0.08
      const thinking = phase === 'thinking' || phase === 'tooling'
      comet += ((thinking ? 1 : 0) - comet) * 0.05

      // As fontes: voz dele e microfone, misturadas conforme quem está falando.
      const jv = readJarvis(now)
      if (userTalking) micBands(mic)
      else for (let i = 0; i < BANDS; i++) mic[i] *= 0.85
      for (let i = 0; i < BANDS; i++) {
        const v = jv[i] * (1 - userMix) + mic[i] * userMix
        shown[i] += (v - shown[i]) * 0.5
      }

      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      if (presence < 0.01) return

      const cx = w / 2
      const cy = h / 2
      const R = Math.min(h * 0.297, w * 0.4) * reactor.scale
      g.globalCompositeOperation = 'lighter'
      g.lineCap = 'round'

      // ------------------------------------------------ anéis de HUD
      const tickR = R * 1.66
      g.lineWidth = 1
      for (let i = 0; i < 120; i++) {
        const a = (i / 120) * Math.PI * 2 + time * 0.04
        const long = i % 10 === 0
        const r1 = tickR
        const r2 = tickR + (long ? 9 : 4)
        g.strokeStyle = rgba(long ? PURPLE : BLUE, (long ? 0.35 : 0.16) * presence)
        g.beginPath()
        g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
        g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
        g.stroke()
      }
      const arcs: [number, number, number, RGB, number][] = [
        // raio, início, tamanho, cor, velocidade
        [R * 1.78, 0.2, 1.1, BLUE, 0.12],
        [R * 1.78, 2.4, 0.5, ORANGE, 0.12],
        [R * 1.86, 1.2, 1.6, PURPLE, -0.07],
        [R * 1.86, 4.1, 0.35, ORANGE, -0.07],
        [R * 1.93, 3.0, 2.2, BLUE, 0.04],
      ]
      for (const [r, start, len, col, speed] of arcs) {
        const a0 = start + time * speed
        g.strokeStyle = rgba(col, 0.1 * presence)
        g.lineWidth = 6
        g.beginPath()
        g.arc(cx, cy, r, a0, a0 + len)
        g.stroke()
        g.strokeStyle = rgba(col, 0.5 * presence)
        g.lineWidth = 1.5
        g.beginPath()
        g.arc(cx, cy, r, a0, a0 + len)
        g.stroke()
      }

      // ------------------------------------------------ barras do espectro
      const r0 = R * 1.13
      const maxLen = R * 0.62
      const step = Math.PI / BARS_PER_SIDE
      const barW = Math.max(2, ((2 * Math.PI * r0) / (BARS_PER_SIDE * 2)) * 0.56)
      const cometAngle = (time * 1.6) % (Math.PI * 2)
      const tips: number[] = new Array(BARS_PER_SIDE * 2)

      for (let side = 0; side < 2; side++) {
        for (let b = 0; b < BARS_PER_SIDE; b++) {
          const t = b / (BARS_PER_SIDE - 1)
          // Topo = graves; desce pelos dois lados até os agudos embaixo.
          const ang = -Math.PI / 2 + (side === 0 ? 1 : -1) * (b + 0.5) * step
          let v = sample(shown, t)
          // Respiração em espera: uma onda lenta passeando pelo anel.
          const idle = 0.05 + 0.06 * (0.5 + 0.5 * Math.sin(time * 1.3 - t * 7 + side * 1.7))
          v = Math.max(v, idle * presence)
          // Cometa enquanto pensa.
          if (comet > 0.01) {
            let d = Math.abs(((ang - cometAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
            d = Math.exp(-(d * d) / 0.08)
            v = Math.max(v, d * 0.55 * comet)
          }
          const len = 3 + v * maxLen
          let col = bandColour(t)
          col = mix(col, ICE, userMix * 0.55)
          if (comet > 0.01) col = mix(col, ORANGE, comet * 0.35)
          const ca = Math.cos(ang)
          const sa = Math.sin(ang)
          const x1 = cx + ca * r0
          const y1 = cy + sa * r0
          const x2 = cx + ca * (r0 + len)
          const y2 = cy + sa * (r0 + len)
          const a = Math.min(1, 0.6 + v * 0.6) * presence
          // brilho largo
          g.strokeStyle = rgba(col, a * 0.32)
          g.lineWidth = barW * 3.2
          g.beginPath()
          g.moveTo(x1, y1)
          g.lineTo(x2, y2)
          g.stroke()
          // barra
          g.strokeStyle = rgba(col, a)
          g.lineWidth = barW
          g.beginPath()
          g.moveTo(x1, y1)
          g.lineTo(x2, y2)
          g.stroke()
          // reflexo para dentro
          g.strokeStyle = rgba(col, a * 0.3)
          g.lineWidth = barW * 0.7
          g.beginPath()
          g.moveTo(cx + ca * (r0 - 5), cy + sa * (r0 - 5))
          g.lineTo(cx + ca * (r0 - 5 - len * 0.22), cy + sa * (r0 - 5 - len * 0.22))
          g.stroke()
          // ponta luminosa nas barras altas
          if (v > 0.35) {
            g.fillStyle = rgba([255, 240, 230], (v - 0.35) * presence)
            g.beginPath()
            g.arc(x2, y2, barW * 0.7, 0, Math.PI * 2)
            g.fill()
          }
          tips[side === 0 ? b : BARS_PER_SIDE * 2 - 1 - b] = v
        }
      }

      // ------------------------------------------------ auréola da voz
      const n = tips.length
      const haloR = (i: number) => R * 1.06 + (tips[(i + n) % n] ?? 0) * R * 0.13
      const angOf = (i: number) => -Math.PI / 2 + (i + 0.5) * step
      const conic = g.createConicGradient(-Math.PI / 2, cx, cy)
      conic.addColorStop(0, rgba(BLUE, 0.9 * presence))
      conic.addColorStop(0.25, rgba(PURPLE, 0.9 * presence))
      conic.addColorStop(0.5, rgba(ORANGE, 0.9 * presence))
      conic.addColorStop(0.75, rgba(PURPLE, 0.9 * presence))
      conic.addColorStop(1, rgba(BLUE, 0.9 * presence))
      g.strokeStyle = conic
      for (const [lw, alpha] of [[6, 0.18], [1.6, 1]] as const) {
        g.globalAlpha = alpha
        g.lineWidth = lw
        g.beginPath()
        for (let i = 0; i <= n; i++) {
          const r = haloR(i)
          const a = angOf(i)
          const x = cx + Math.cos(a) * r
          const y = cy + Math.sin(a) * r
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.closePath()
        g.stroke()
      }
      g.globalAlpha = 1
      g.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={ref} className="voice-ring" aria-hidden="true" />
}
