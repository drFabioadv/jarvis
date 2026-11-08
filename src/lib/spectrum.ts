/**
 * O espectro da voz — o que alimenta as barras em volta do reator.
 *
 * Três fontes, uma só forma de saída (BANDS valores entre 0 e 1, dos graves
 * aos agudos, em escala logarítmica de 80 Hz a 8 kHz):
 *
 *   - voz da nuvem (ElevenLabs / Kokoro): análise real do áudio que está
 *     saindo, quadro a quadro — a tonalidade de verdade;
 *   - voz do navegador (speechSynthesis): o navegador não entrega o som, então
 *     o espectro é sintetizado a partir do texto que está sendo falado. Cada
 *     vogal acende os seus formantes (o "a" aberto, o "i" agudo, o "u" grave),
 *     as sibilantes acendem os agudos, as pausas apagam tudo, e a entonação
 *     sobe no fim das perguntas. Sincronizado pelos eventos de palavra da fala;
 *   - o microfone: quando é você falando.
 */

export const BANDS = 48
const F_LO = 80
const F_HI = 8000

/** Frequência central de cada banda. */
export const bandHz = Array.from(
  { length: BANDS },
  (_, i) => F_LO * Math.pow(F_HI / F_LO, i / (BANDS - 1)),
)
const bandLog = bandHz.map((f) => Math.log(f))

/** O que as barras mostram da voz dele. Lido a cada quadro. */
export const jarvisBands = new Float32Array(BANDS)
const target = new Float32Array(BANDS)

// ---------------------------------------------------------------- áudio real

/** Preenche `out` a partir de um AnalyserNode (fala da nuvem ou microfone). */
export function fromAnalyser(
  analyser: AnalyserNode,
  bins: Uint8Array,
  out: Float32Array,
  gain = 1,
) {
  analyser.getByteFrequencyData(bins as Uint8Array<ArrayBuffer>)
  const hzPerBin = analyser.context.sampleRate / analyser.fftSize
  for (let i = 0; i < BANDS; i++) {
    const lo = Math.max(1, Math.floor((i ? (bandHz[i - 1] + bandHz[i]) / 2 : bandHz[0]) / hzPerBin))
    const hi = Math.max(lo, Math.ceil((i < BANDS - 1 ? (bandHz[i] + bandHz[i + 1]) / 2 : F_HI) / hzPerBin))
    let m = 0
    for (let b = lo; b <= hi && b < bins.length; b++) m = Math.max(m, bins[b])
    // Agudos chegam mais fracos; um leve realce deixa o desenho equilibrado.
    const tilt = 1 + (i / BANDS) * 0.9
    const v = Math.min(1, Math.pow(m / 255, 1.6) * 1.5 * tilt * gain)
    out[i] += (v - out[i]) * (v > out[i] ? 0.6 : 0.22)
  }
}

let cloud: { analyser: AnalyserNode; bins: Uint8Array } | null = null

/** A fala da nuvem começou: as barras passam a ler o áudio real. */
export function cloudBegin(analyser: AnalyserNode) {
  cloud = { analyser, bins: new Uint8Array(analyser.frequencyBinCount) }
}
export function cloudEnd() {
  cloud = null
}

// ---------------------------------------------------------------- voz sintetizada

type Seg = { ch: string; t: number; d: number }
let timeline: Seg[] = []
let timeAt: number[] = []
let total = 0
let startedAt = 0
let synthOn = false
let question = false

/** Formantes (F1, F2) das vogais do português, em Hz. */
const VOWEL: Record<string, [number, number]> = {
  a: [750, 1300], á: [750, 1300], à: [750, 1300], â: [600, 1250], ã: [620, 1250],
  e: [450, 1950], é: [600, 1800], ê: [450, 1950],
  i: [300, 2300], í: [300, 2300], y: [300, 2300],
  o: [460, 850], ó: [600, 950], ô: [460, 850], õ: [460, 850],
  u: [320, 800], ú: [320, 800], w: [320, 800],
}
const SIBILANT = new Set(['s', 'z', 'x', 'ç', 'c', 'j', 'f', 'v', 'h'])
const PLOSIVE = new Set(['p', 't', 'k', 'b', 'd', 'g', 'q'])
const NASAL = new Set(['m', 'n', 'l', 'r'])

function durationOf(ch: string): number {
  if (VOWEL[ch]) return 85
  if (SIBILANT.has(ch)) return 70
  if (PLOSIVE.has(ch)) return 45
  if (NASAL.has(ch)) return 55
  if (ch === ' ') return 35
  if (ch === ',' || ch === ';' || ch === ':') return 230
  if (ch === '.' || ch === '!' || ch === '?') return 380
  if (/\d/.test(ch)) return 160
  return 40
}

/**
 * Uma frase vai ser falada. `rate` é a velocidade do speechSynthesis (1 =
 * normal), que só serve para estimar o ritmo; os eventos de palavra corrigem.
 */
export function synthBegin(text: string, rate = 1) {
  const lower = text.toLowerCase()
  timeline = []
  timeAt = []
  let t = 0
  for (const ch of lower) {
    const d = durationOf(ch) / rate
    timeAt.push(t)
    timeline.push({ ch, t, d })
    t += d
  }
  total = t
  question = /\?\s*$/.test(text)
  startedAt = performance.now()
  synthOn = true
}

/** O navegador chegou à palavra que começa em `charIndex`: ressincroniza. */
export function synthBoundary(charIndex: number) {
  if (!synthOn) return
  const at = timeAt[Math.min(charIndex, timeAt.length - 1)] ?? 0
  startedAt = performance.now() - at
}

export function synthEnd() {
  synthOn = false
}

function gauss(centreHz: number, width: number, amp: number, out: Float32Array) {
  const c = Math.log(centreHz)
  for (let i = 0; i < BANDS; i++) {
    const x = (bandLog[i] - c) / width
    out[i] += amp * Math.exp(-x * x)
  }
}

function noise(fromHz: number, toHz: number, amp: number, out: Float32Array) {
  for (let i = 0; i < BANDS; i++) {
    if (bandHz[i] >= fromHz && bandHz[i] <= toHz) out[i] += amp * (0.55 + Math.random() * 0.45)
  }
}

function synthFrame(now: number) {
  target.fill(0)
  const t = now - startedAt
  if (t > total + 150) {
    synthOn = false
    return
  }
  // Onde estamos na frase.
  let k = 0
  let lo = 0
  let hi = timeline.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (timeline[mid].t <= t) {
      k = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const seg = timeline[k]
  if (!seg) return
  const into = Math.min(1, (t - seg.t) / seg.d)
  // Envelope da sílaba: sobe rápido e cai no fim do som.
  const env = Math.sin(Math.PI * Math.min(1, into * 1.15)) * 0.35 + 0.65
  const progress = Math.min(1, t / Math.max(1, total))

  // Entonação: a voz desce ao longo da frase (declinação) e sobe nas perguntas.
  let f0 = 118 + Math.sin(now / 170) * 9 - progress * 18
  if (question && progress > 0.75) f0 += (progress - 0.75) * 4 * 55

  const ch = seg.ch
  const v = VOWEL[ch]
  if (v) {
    // Vogal: fundamental + harmônicos + os dois formantes.
    gauss(f0, 0.09, 0.95 * env, target)
    gauss(f0 * 2, 0.08, 0.55 * env, target)
    gauss(f0 * 3, 0.08, 0.35 * env, target)
    gauss(v[0], 0.22, 0.9 * env, target)
    gauss(v[1], 0.18, 0.75 * env, target)
    gauss(2700, 0.2, 0.28 * env, target)
  } else if (SIBILANT.has(ch)) {
    noise(3200, 8000, 0.75 * env, target)
    if (ch === 'z' || ch === 'j' || ch === 'v') gauss(f0, 0.1, 0.45 * env, target)
  } else if (PLOSIVE.has(ch)) {
    // Explosão curta, espalhada.
    const burst = into < 0.5 ? 1 : 0.25
    noise(400, 4500, 0.55 * burst, target)
  } else if (NASAL.has(ch)) {
    gauss(f0, 0.09, 0.75 * env, target)
    gauss(280, 0.25, 0.6 * env, target)
    gauss(1100, 0.25, 0.3 * env, target)
  } else if (/\d/.test(ch)) {
    gauss(f0, 0.09, 0.7, target)
    gauss(600, 0.3, 0.6, target)
    gauss(1800, 0.25, 0.45, target)
  }
  // Pausas (espaço, vírgula, ponto) ficam em silêncio: as barras caem.

  for (let i = 0; i < BANDS; i++) {
    const tv = Math.min(1, target[i] * 1.25 * (0.85 + Math.random() * 0.3))
    jarvisBands[i] += (tv - jarvisBands[i]) * (tv > jarvisBands[i] ? 0.5 : 0.2)
  }
}

// Para testes no console: __spectrum.synthBegin('Olá, senhor.')
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__spectrum = { synthBegin, synthEnd }
}

/** Chamado a cada quadro pelo visual. Atualiza e devolve as bandas dele. */
export function readJarvis(now = performance.now()): Float32Array {
  if (cloud) fromAnalyser(cloud.analyser, cloud.bins, jarvisBands)
  else if (synthOn) synthFrame(now)
  else for (let i = 0; i < BANDS; i++) jarvisBands[i] *= 0.86
  return jarvisBands
}
