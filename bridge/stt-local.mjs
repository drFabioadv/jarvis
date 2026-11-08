/**
 * Audição local do JARVIS — o Whisper rodando no próprio PC, de graça.
 *
 * O reconhecimento de voz do navegador para de escutar quando a janela fica
 * escondida (o navegador corta o microfone de abas "em segundo plano"). Com o
 * Whisper, o navegador só grava os trechos de fala e manda para cá; quem
 * entende as palavras é este módulo, que não liga se a janela está visível,
 * escondida ou atrás de um jogo.
 *
 * O modelo (uns 80 MB) é baixado uma vez, na primeira vez que liga, e fica em
 * %LOCALAPPDATA%\JARVIS\modelos. Depois funciona sem internet.
 *
 * Em jarvis-config.json:
 *   "audicao": "local"   (padrão) Whisper no PC
 *   "audicao": "navegador"        o reconhecimento do navegador, como antes
 *   "modeloVoz": "onnx-community/whisper-small"   mais preciso, mais pesado
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

let asr = null
let loading = null
let failed = ''

export function localSttStatus() {
  return { ready: Boolean(asr), loading: Boolean(loading), failed }
}

export function loadLocalStt(model = 'onnx-community/whisper-small') {
  if (asr) return Promise.resolve(asr)
  if (loading) return loading
  loading = (async () => {
    const t0 = Date.now()
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = join(process.env.LOCALAPPDATA || join(homedir(), '.cache'), 'JARVIS', 'modelos')
    env.allowLocalModels = false
    const p = await pipeline('automatic-speech-recognition', model, { dtype: 'q8' })
    asr = p
    console.log(`[jarvis] audição local pronta (${model}, ${Math.round((Date.now() - t0) / 1000)} s)`)
    return p
  })()
    .catch((err) => {
      failed = String(err?.message ?? err)
      console.warn(`[jarvis] audição local falhou: ${failed}`)
      return null
    })
    .finally(() => {
      loading = null
    })
  return loading
}

function semLaco(text) {
  const w = text.split(/\s+/)
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i + n * 4 <= w.length; i++) {
      const g = w.slice(i, i + n).join(' ').toLowerCase()
      let rep = 1
      while (w.slice(i + rep * n, i + rep * n + n).join(' ').toLowerCase() === g) rep++
      if (rep >= 4) return i < 2 ? '' : w.slice(0, i + n).join(' ')
    }
  }
  return text
}

/** Transcreve áudio PCM float32 mono a 16 kHz. */
export async function transcribeLocal(pcm, model) {
  const p = asr ?? (await loadLocalStt(model))
  if (!p) throw new Error(failed || 'audição local indisponível')
  // Menos de 0,3 s não tem palavra que valha.
  if (pcm.length < 4800) return ''
  // Trechos longos demais são ruído contínuo (TV, jogo): no máximo 20 s.
  const audio = pcm.length > 16000 * 20 ? pcm.subarray(0, 16000 * 20) : pcm
  const r = await p(audio, { language: 'portuguese', task: 'transcribe', max_new_tokens: 96 })
  let text = String(r?.text ?? '').trim()
  // O Whisper às vezes entra em laço ("o que é o que é o que é..."): corta
  // na primeira repetição e descarta se sobrar só o laço.
  text = semLaco(text)
  // O Whisper às vezes "alucina" frases de legenda em silêncio ou ruído.
  if (/^(legendas?|obrigad[oa] por assistir|inscreva-se|\[.*\]|\(.*\)|♪+|\.+)$/i.test(text)) return ''
  if (/legendas pela comunidade|amara\.org/i.test(text)) return ''
  return text
}
