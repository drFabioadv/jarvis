/**
 * Cérebro do PC: em vez do Claude, o JARVIS da bandeja manda os pedidos que
 * não resolve sozinho para a plataforma JARVIS no próprio computador
 * (cloud/src/pc.mjs), que usa o modelo aberto do Ollama na sua placa de
 * vídeo. Tudo fica no seu PC; nada é pago.
 *
 * Ligado por jarvis-config.json: "cerebro": "pc" (padrão quando instalado
 * pelo INSTALAR-JARVIS-PC.bat). Para voltar ao Claude: "cerebro": "claude".
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PASTA = process.env.JARVIS_DADOS || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'JARVIS', 'pc') : join(homedir(), '.jarvis-pc'))

function config() {
  const arq = join(PASTA, 'config.json')
  if (!existsSync(arq)) return null
  try {
    return JSON.parse(readFileSync(arq, 'utf8'))
  } catch {
    return null
  }
}

export function cerebroPcAtivo(cfg) {
  return String(cfg?.cerebro ?? '').toLowerCase() === 'pc'
}

/**
 * Pergunta ao cérebro do PC, recebendo a resposta aos pedaços.
 * @returns {Promise<string>} o texto completo
 */
export async function perguntarPc(texto, { aoTexto, signal, nova = false } = {}) {
  const c = config()
  if (!c) throw new Error('o cérebro do PC ainda não foi instalado (rode INSTALAR-JARVIS-PC.bat)')
  const r = await fetch(`http://127.0.0.1:${c.porta ?? 8090}/api/interno/conversa`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jarvis': '1', 'x-jarvis-interno': c.tokenInterno },
    body: JSON.stringify({ texto, nova }),
    signal: signal ?? AbortSignal.timeout(300000),
  })
  if (r.status === 409) throw new Error((await r.json()).erro)
  if (!r.ok || !r.body) throw new Error(`o cérebro do PC respondeu ${r.status}`)
  const dec = new TextDecoder()
  let buf = ''
  let tudo = ''
  let final = ''
  for await (const pedaco of r.body) {
    buf += dec.decode(pedaco, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const bloco = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (!bloco.startsWith('data: ')) continue
      const e = JSON.parse(bloco.slice(6))
      if (e.tipo === 'texto') {
        tudo += e.delta
        aoTexto?.(e.delta)
      } else if (e.tipo === 'fim') final = e.texto ?? ''
      else if (e.tipo === 'erro' && !tudo) final = e.mensagem
    }
  }
  if (!tudo && final) aoTexto?.(final)
  return tudo || final
}

/** O cérebro do PC está no ar? */
export async function pcNoAr() {
  const c = config()
  if (!c) return false
  try {
    return (await fetch(`http://127.0.0.1:${c.porta ?? 8090}/api/saude`, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}
