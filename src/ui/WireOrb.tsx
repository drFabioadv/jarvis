import { useEffect, useRef } from 'react'
import { useStore, type Phase } from '../store'
import { BANDS, readJarvis } from '../lib/spectrum'
import { micBands } from '../lib/audio'

/**
 * A esfera de fios de luz do layout do vídeo.
 *
 * Uns vinte anéis finos, cada um deformado por ondas próprias e girando em
 * torno de um eixo diferente, projetados em 2D com brilho aditivo. Juntos dão
 * a impressão de um novelo de energia azul.
 *
 * Reage à voz: quando ele fala (ou você fala), cada anel puxa uma faixa do
 * espectro e se deforma com ela — graves incham os anéis de fora, agudos
 * fazem os de dentro tremerem.
 */

type Strand = {
  ax: number
  ay: number
  az: number
  spin: number
  k1: number
  k2: number
  ph: number
  amp: number
  band: number
  radius: number
  bright: number
}

const N = 22
const SEG = 140

const SPEED: Record<Phase, number> = {
  offline: 0.1,
  boot: 1.6,
  dormant: 0.35,
  waking: 1.4,
  listening: 0.8,
  thinking: 1.5,
  tooling: 1.8,
  speaking: 0.9,
}

/**
 * Onde a esfera fica: no centro (sem cartões abertos) ou no canto superior
 * esquerdo, menor (com cartões abertos). Ela desliza até lá suavemente.
 */
const layout = { x: 0.5, y: 0.47, scale: 1 }
export function setOrbLayout(open: boolean | 'cerebro') {
  if (open === 'cerebro') {
    // Segundo cérebro aberto: a esfera fica em cima, no centro, menor.
    layout.x = 0.5
    layout.y = 0.17
    layout.scale = 0.42
    return
  }
  layout.x = open ? 0.19 : 0.5
  layout.y = open ? 0.32 : 0.47
  layout.scale = open ? 0.6 : 1
}

export function WireOrb() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const g = canvas?.getContext('2d')
    if (!canvas || !g) return

    // Semente fixa: o desenho é sempre o mesmo novelo, só se move.
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const strands: Strand[] = Array.from({ length: N }, (_, i) => ({
      ax: rnd() * Math.PI * 2,
      ay: rnd() * Math.PI * 2,
      az: rnd() * Math.PI * 2,
      spin: (rnd() - 0.5) * 0.5,
      k1: 2 + Math.floor(rnd() * 3),
      k2: 3 + Math.floor(rnd() * 4),
      ph: rnd() * Math.PI * 2,
      amp: 0.04 + rnd() * 0.07,
      band: Math.floor((i / N) * BANDS),
      radius: 0.78 + rnd() * 0.3,
      bright: rnd() < 0.18 ? 1 : 0.45 + rnd() * 0.35,
    }))

    const mic = new Float32Array(BANDS)
    let raf = 0
    let w = 0
    let h = 0
    let dpr = 1
    let t = 0
    let last = performance.now()
    let energy = 0
    let speedNow = 0.35
    const pos = { x: layout.x, y: layout.y, scale: layout.scale }

    const resize = () => {
      dpr = Math.min(1.5, window.devicePixelRatio || 1)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const s = useStore.getState()
      const phase = s.phase
      speedNow += (SPEED[phase] - speedNow) * 0.04
      t += dt * speedNow

      const userTalking = phase === 'listening' || phase === 'waking'
      const jv = readJarvis(now)
      if (userTalking) micBands(mic)
      const src = userTalking ? mic : jv
      let sum = 0
      for (let i = 0; i < BANDS; i++) sum += src[i]
      energy += (sum / BANDS - energy) * 0.25

      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      pos.x += (layout.x - pos.x) * 0.06
      pos.y += (layout.y - pos.y) * 0.06
      pos.scale += (layout.scale - pos.scale) * 0.06
      const cx = w * pos.x
      const cy = h * pos.y
      const R = Math.min(w, h) * 0.26 * pos.scale * (1 + energy * 0.18)
      g.globalCompositeOperation = 'lighter'
      g.lineJoin = 'round'

      for (const st of strands) {
        const v = src[st.band] ?? 0
        const rot = t * st.spin * 2 + st.az
        const ca = Math.cos(st.ax + t * 0.11), sa = Math.sin(st.ax + t * 0.11)
        const cb = Math.cos(st.ay), sb = Math.sin(st.ay)
        const cr = Math.cos(rot), sr = Math.sin(rot)
        g.beginPath()
        for (let i = 0; i <= SEG; i++) {
          const th = (i / SEG) * Math.PI * 2
          const wob =
            1 +
            st.amp * Math.sin(st.k1 * th + st.ph + t * 1.3) +
            st.amp * 0.6 * Math.sin(st.k2 * th - t * 0.9) +
            v * 0.22 * Math.sin(5 * th + t * 6 + st.ph)
          const r = R * st.radius * wob
          // Anel no plano XY, girado em três eixos.
          let x = Math.cos(th) * r
          let y = Math.sin(th) * r
          let z = 0
          ;[x, y] = [x * cr - y * sr, x * sr + y * cr]
          ;[y, z] = [y * ca - z * sa, y * sa + z * ca]
          ;[x, z] = [x * cb + z * sb, -x * sb + z * cb]
          const px = cx + x
          const py = cy + y * 0.92
          if (i === 0) g.moveTo(px, py)
          else g.lineTo(px, py)
        }
        const a = Math.min(1.4, st.bright * (0.7 + v * 1.1 + energy * 0.5))
        // Metade dos fios azul, metade roxa.
        const roxo = st.band % 2 === 1
        g.strokeStyle = roxo ? `rgba(150,80,255,${(0.12 * a).toFixed(3)})` : `rgba(60,130,255,${(0.11 * a).toFixed(3)})`
        g.lineWidth = 9
        g.stroke()
        g.strokeStyle = roxo ? `rgba(175,120,255,${(0.45 * a).toFixed(3)})` : `rgba(100,180,255,${(0.42 * a).toFixed(3)})`
        g.lineWidth = 2.4
        g.stroke()
        g.strokeStyle = roxo ? `rgba(235,220,255,${(0.8 * a * st.bright).toFixed(3)})` : `rgba(225,245,255,${(0.85 * a * st.bright).toFixed(3)})`
        g.lineWidth = 0.9
        g.stroke()
      }

      // Núcleo: um brilho difuso no centro.
      const core = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.9)
      core.addColorStop(0, `rgba(110,110,255,${0.1 + energy * 0.25})`)
      core.addColorStop(0.6, `rgba(120,70,255,${0.04 + energy * 0.08})`)
      core.addColorStop(1, 'rgba(60,40,255,0)')
      g.fillStyle = core
      g.beginPath()
      g.arc(cx, cy, R * 0.9, 0, Math.PI * 2)
      g.fill()
      g.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={ref} className="wire-orb" aria-hidden="true" />
}
