/**
 * Audição na nuvem (opcional): Whisper (modelo aberto) rodando no próprio
 * servidor do JARVIS, via transformers.js/ONNX — sem serviço externo.
 * Liga com JARVIS_STT_NUVEM=1. O modelo (~250 MB) é baixado na primeira vez
 * e fica em JARVIS_MODELOS_DIR (volume do Docker).
 *
 * O navegador manda PCM float32 mono a 16 kHz (até 20 s); nada é gravado.
 */
let asr = null
let carregando = null
let falha = ''

export function estadoStt() {
  return { pronta: Boolean(asr), carregando: Boolean(carregando), falha }
}

export function carregarStt(modelo = process.env.JARVIS_STT_MODELO || 'onnx-community/whisper-small') {
  if (asr) return Promise.resolve(asr)
  if (carregando) return carregando
  carregando = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = process.env.JARVIS_MODELOS_DIR || '/data/modelos'
    env.allowLocalModels = false
    asr = await pipeline('automatic-speech-recognition', modelo, { dtype: 'q8' })
    console.log(`[stt] Whisper pronto (${modelo})`)
    return asr
  })()
    .catch((err) => {
      falha = String(err?.message ?? err)
      console.warn(`[stt] não carregou: ${falha}`)
      return null
    })
    .finally(() => (carregando = null))
  return carregando
}

function semLaco(texto) {
  const w = texto.split(/\s+/)
  for (let n = 1; n <= 4; n++)
    for (let i = 0; i + n * 4 <= w.length; i++) {
      const g = w.slice(i, i + n).join(' ').toLowerCase()
      let rep = 1
      while (w.slice(i + rep * n, i + rep * n + n).join(' ').toLowerCase() === g) rep++
      if (rep >= 4) return i < 2 ? '' : w.slice(0, i + n).join(' ')
    }
  return texto
}

export async function transcrever(buf) {
  if (buf.length % 4) throw new Error('áudio inválido')
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
  if (pcm.length < 4800) return ''
  const p = asr ?? (await carregarStt())
  if (!p) throw new Error(falha || 'audição na nuvem indisponível')
  const audio = pcm.length > 16000 * 20 ? pcm.subarray(0, 16000 * 20) : pcm
  const r = await p(audio, { language: 'portuguese', task: 'transcribe', max_new_tokens: 96 })
  let t = semLaco(String(r?.text ?? '').trim())
  if (/^(legendas?|obrigad[oa] por assistir|inscreva-se|\[.*\]|\(.*\)|♪+|\.+)$/i.test(t) || /legendas pela comunidade|amara\.org/i.test(t)) t = ''
  return t
}
