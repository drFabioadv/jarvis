/**
 * Gateway de modelos do JARVIS 3.0.
 *
 * Fala com qualquer servidor compatível com a API da OpenAI — vLLM (GPU
 * própria), Ollama, llama.cpp, ou provedores serverless de modelos abertos.
 * Nada aqui conhece um fornecedor específico: provedores e modelos vêm da
 * configuração (cloud/modelos.exemplo.json).
 *
 * Por nível (rápido, principal, avançado, visão, embeddings) há uma lista de
 * modelos autorizados: se um falha (timeout, 429, 5xx, rede), tenta de novo
 * uma vez e depois passa para o próximo. Antes de cada chamada confere o
 * orçamento do dia; depois registra tokens, custo e latência.
 */

export class ErroOrcamento extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'ErroOrcamento'
  }
}
export class ErroSemModelo extends Error {
  constructor(nivel) {
    super(`Nenhum modelo configurado para o nível "${nivel}". Configure em modelos.json ou nas variáveis LLM_*.`)
    this.name = 'ErroSemModelo'
  }
}

const TRANSITORIO = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const espera = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {object} opts
 * @param {object} opts.modelos   config normalizada (provedores, niveis, precos, orcamento)
 * @param {object} [opts.env]     de onde ler as chaves (chaveEnv)
 * @param {(u: object) => Promise<void>} [opts.registrar]  grava o uso
 * @param {() => Promise<number>} [opts.gastoHoje]          custo de hoje, em USD
 * @param {typeof fetch} [opts.fetch]
 */
export function criarGateway({ modelos, env = process.env, registrar = async () => {}, gastoHoje = async () => 0, fetch: f = fetch, timeoutPadrao = 60000 }) {
  const metricas = new Map() // modelo -> { chamadas, falhas, latenciaMedia }

  function custo(modelo, uso) {
    const p = modelos.precos[modelo]
    if (!p) return 0
    return ((uso.prompt_tokens ?? 0) * p.entrada + (uso.completion_tokens ?? 0) * p.saida) / 1e6
  }

  function cabecalhos(prov) {
    const h = { 'content-type': 'application/json', ...(prov.cabecalhos ?? {}) }
    const chave = prov.chaveEnv ? env[prov.chaveEnv] : undefined
    if (chave) h.authorization = `Bearer ${chave}`
    return h
  }

  function anotar(modelo, ok, ms) {
    const m = metricas.get(modelo) ?? { chamadas: 0, falhas: 0, latenciaMedia: 0 }
    m.chamadas++
    if (!ok) m.falhas++
    m.latenciaMedia = m.latenciaMedia + (ms - m.latenciaMedia) / m.chamadas
    metricas.set(modelo, m)
  }

  async function conferirOrcamento() {
    const limite = modelos.orcamento.diarioUsd
    if (limite > 0 && (await gastoHoje()) >= limite) throw new ErroOrcamento(`Orçamento diário de US$ ${limite} atingido. Ajuste em modelos.json (orcamento.diarioUsd).`)
  }

  /** Uma tentativa num modelo; devolve a resposta (já montada, mesmo em streaming). */
  async function tentar(alvo, nivel, corpo, { aoTexto, signal, ownerId }) {
    const prov = modelos.provedores[alvo.provedor]
    const url = `${prov.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const ctrl = new AbortController()
    const tempo = setTimeout(() => ctrl.abort(new Error('tempo esgotado')), alvo.timeoutMs ?? timeoutPadrao)
    const parar = () => ctrl.abort(signal.reason)
    signal?.addEventListener('abort', parar, { once: true })
    const t0 = Date.now()
    let uso = {}
    try {
      const stream = Boolean(aoTexto)
      const res = await f(url, {
        method: 'POST',
        headers: cabecalhos(prov),
        body: JSON.stringify({ ...corpo, model: alvo.modelo, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const txt = (await res.text().catch(() => '')).slice(0, 300)
        const err = new Error(`${alvo.provedor}/${alvo.modelo} respondeu ${res.status}: ${txt}`)
        err.status = res.status
        throw err
      }
      let msg
      if (!stream) {
        const j = await res.json()
        uso = j.usage ?? {}
        msg = j.choices?.[0]?.message ?? { role: 'assistant', content: '' }
        msg.finish = j.choices?.[0]?.finish_reason
      } else {
        msg = await lerStream(res, aoTexto, (u) => (uso = u))
      }
      const ms = Date.now() - t0
      anotar(alvo.modelo, true, ms)
      await registrar({ ownerId, provedor: alvo.provedor, modelo: alvo.modelo, nivel, tokensEntrada: uso.prompt_tokens ?? 0, tokensSaida: uso.completion_tokens ?? 0, custoUsd: custo(alvo.modelo, uso), latenciaMs: ms, ok: true })
      return { ...msg, modelo: alvo.modelo, provedor: alvo.provedor, uso }
    } catch (err) {
      const ms = Date.now() - t0
      anotar(alvo.modelo, false, ms)
      await registrar({ ownerId, provedor: alvo.provedor, modelo: alvo.modelo, nivel, tokensEntrada: 0, tokensSaida: 0, custoUsd: 0, latenciaMs: ms, ok: false, erro: String(err?.message ?? err).slice(0, 300) })
      if (signal?.aborted) throw signal.reason ?? err
      throw err
    } finally {
      clearTimeout(tempo)
      signal?.removeEventListener('abort', parar)
    }
  }

  /**
   * Conversa com um modelo do nível pedido.
   * @returns {Promise<{content: string, tool_calls?: any[], modelo: string, provedor: string, uso: object}>}
   */
  async function conversar({ nivel = 'principal', mensagens, ferramentas, maxTokens, temperatura = 0.4, aoTexto, signal, ownerId, formatoJson = false }) {
    const lista = modelos.niveis[nivel]?.length ? modelos.niveis[nivel] : nivel !== 'principal' ? modelos.niveis.principal : []
    if (!lista.length) throw new ErroSemModelo(nivel)
    await conferirOrcamento()
    const corpo = {
      messages: mensagens,
      temperature: temperatura,
      max_tokens: Math.min(maxTokens ?? modelos.orcamento.maxTokensResposta, modelos.orcamento.maxTokensResposta * 4),
      ...(ferramentas?.length ? { tools: ferramentas, tool_choice: 'auto' } : {}),
      ...(formatoJson ? { response_format: { type: 'json_object' } } : {}),
    }
    let ultimo
    for (const alvo of lista) {
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        try {
          return await tentar(alvo, nivel, corpo, { aoTexto, signal, ownerId })
        } catch (err) {
          ultimo = err
          if (signal?.aborted || err instanceof ErroOrcamento) throw err
          // Erro do pedido (400, 401, 404): não adianta repetir no mesmo modelo.
          if (err.status && !TRANSITORIO.has(err.status)) break
          // Já mandou texto em streaming: repetir duplicaria a fala.
          if (aoTexto && err.parcial) throw err
          if (tentativa === 0) await espera(400 + Math.random() * 600)
        }
      }
    }
    throw new Error(`Nenhum modelo do nível "${nivel}" respondeu. Último erro: ${ultimo?.message ?? ultimo}`)
  }

  /** Vetores para a busca semântica. Sem modelo de embeddings, devolve null. */
  async function embeddings(textos, { ownerId, signal } = {}) {
    const lista = modelos.niveis.embeddings
    if (!lista.length) return null
    let ultimo
    for (const alvo of lista) {
      const prov = modelos.provedores[alvo.provedor]
      const t0 = Date.now()
      try {
        const res = await f(`${prov.baseUrl.replace(/\/+$/, '')}/embeddings`, {
          method: 'POST',
          headers: cabecalhos(prov),
          body: JSON.stringify({ model: alvo.modelo, input: textos }),
          signal: signal ?? AbortSignal.timeout(alvo.timeoutMs ?? 30000),
        })
        if (!res.ok) throw Object.assign(new Error(`embeddings ${res.status}`), { status: res.status })
        const j = await res.json()
        await registrar({ ownerId, provedor: alvo.provedor, modelo: alvo.modelo, nivel: 'embeddings', tokensEntrada: j.usage?.prompt_tokens ?? 0, tokensSaida: 0, custoUsd: custo(alvo.modelo, j.usage ?? {}), latenciaMs: Date.now() - t0, ok: true })
        return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
      } catch (err) {
        ultimo = err
        await registrar({ ownerId, provedor: alvo.provedor, modelo: alvo.modelo, nivel: 'embeddings', tokensEntrada: 0, tokensSaida: 0, custoUsd: 0, latenciaMs: Date.now() - t0, ok: false, erro: String(err?.message ?? err).slice(0, 300) })
      }
    }
    throw new Error(`embeddings indisponíveis: ${ultimo?.message ?? ultimo}`)
  }

  return {
    conversar,
    embeddings,
    metricas: () => Object.fromEntries(metricas),
    temNivel: (n) => Boolean(modelos.niveis[n]?.length),
    orcamento: () => modelos.orcamento,
  }
}

/** Lê um stream SSE da API de chat, montando texto e chamadas de ferramenta. */
async function lerStream(res, aoTexto, aoUso) {
  const dec = new TextDecoder()
  let buf = ''
  let content = ''
  let finish = null
  const calls = []
  let falou = false
  try {
    for await (const pedaco of res.body) {
      buf += dec.decode(pedaco, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const linha = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!linha.startsWith('data:')) continue
        const dado = linha.slice(5).trim()
        if (dado === '[DONE]') continue
        let j
        try {
          j = JSON.parse(dado)
        } catch {
          continue
        }
        if (j.usage) aoUso(j.usage)
        const ch = j.choices?.[0]
        if (!ch) continue
        if (ch.finish_reason) finish = ch.finish_reason
        const d = ch.delta ?? {}
        if (d.content) {
          content += d.content
          falou = true
          aoTexto(d.content)
        }
        for (const tc of d.tool_calls ?? []) {
          const k = tc.index ?? 0
          calls[k] ??= { id: tc.id ?? `call_${k}`, type: 'function', function: { name: '', arguments: '' } }
          if (tc.id) calls[k].id = tc.id
          if (tc.function?.name) calls[k].function.name += tc.function.name
          if (tc.function?.arguments) calls[k].function.arguments += tc.function.arguments
        }
      }
    }
  } catch (err) {
    if (falou) err.parcial = true
    throw err
  }
  const msg = { role: 'assistant', content, finish }
  if (calls.length) msg.tool_calls = calls.filter(Boolean)
  return msg
}
