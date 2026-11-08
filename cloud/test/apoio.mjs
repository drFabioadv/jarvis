// Apoio aos testes: banco e Redis de verdade (Docker), e um "provedor de IA"
// falso compatível com a API da OpenAI, para roteiros determinísticos.
import http from 'node:http'
import pg from 'pg'
import IORedis from 'ioredis'
import { randomBytes } from 'node:crypto'

export const BASE_PG = process.env.TESTE_PG ?? 'postgres://jarvis:teste123@127.0.0.1:55432'
export const REDIS = process.env.TESTE_REDIS ?? 'redis://127.0.0.1:56379/3'
export const OLLAMA = process.env.TESTE_OLLAMA ?? 'http://127.0.0.1:11434/v1'

export async function bancoNovo() {
  const nome = `jarvis_t_${Date.now()}_${randomBytes(3).toString('hex')}`
  const admin = new pg.Client({ connectionString: `${BASE_PG}/jarvis` })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${nome}`)
  await admin.end()
  return {
    url: `${BASE_PG}/${nome}`,
    async apagar() {
      const a = new pg.Client({ connectionString: `${BASE_PG}/jarvis` })
      await a.connect()
      await a.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`)
      await a.end()
    },
  }
}

export async function limparRedis() {
  const r = new IORedis(REDIS)
  await r.flushdb()
  r.disconnect()
}

export const ollamaNoAr = async () => {
  try {
    const r = await fetch(`${OLLAMA}/models`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

/**
 * Provedor falso: `roteiro(corpo)` devolve { texto } ou { ferramenta, args },
 * ou { status } para simular erro. Suporta streaming SSE e embeddings.
 */
export async function provedorFalso(roteiro) {
  const pedidos = []
  const srv = http.createServer(async (req, res) => {
    let b = ''
    for await (const c of req) b += c
    const corpo = b ? JSON.parse(b) : {}
    pedidos.push({ url: req.url, corpo, auth: req.headers.authorization })
    if (req.url.endsWith('/embeddings')) {
      const inp = Array.isArray(corpo.input) ? corpo.input : [corpo.input]
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: inp.map((t, i) => ({ index: i, embedding: vetorDe(t) })), usage: { prompt_tokens: 5 } }))
    }
    const r = await roteiro(corpo, pedidos.length)
    if (r.status) {
      res.writeHead(r.status, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'simulado' } }))
    }
    if (r.demora) await new Promise((x) => setTimeout(x, r.demora))
    const msg = r.ferramenta
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: r.ferramenta.replace('.', '__'), arguments: JSON.stringify(r.args ?? {}) } }] }
      : { role: 'assistant', content: r.texto ?? '' }
    const uso = { prompt_tokens: 100, completion_tokens: 20 }
    if (corpo.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (msg.tool_calls) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: msg.tool_calls[0].function.name, arguments: msg.tool_calls[0].function.arguments } }] } }] })}\n\n`)
      else for (const p of (msg.content.match(/.{1,6}/gs) ?? [])) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: uso })}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: uso }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, pedidos, fechar: () => new Promise((r) => srv.close(r)) }
}

/** "Embedding" falso e estável: palavras em comum → vetores próximos. */
function vetorDe(t) {
  const v = new Array(64).fill(0)
  for (const w of String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\W+/).filter((x) => x.length > 2)) {
    let h = 0
    for (const ch of w.slice(0, 5)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    v[h % 64] += 1
  }
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}

export function envBase(dbUrl, extra = {}) {
  return {
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:8080',
    DATABASE_URL: dbUrl,
    REDIS_URL: REDIS,
    JARVIS_MASTER_KEY: randomBytes(32).toString('base64'),
    LOG_LEVEL: 'silent',
    ...extra,
  }
}

/** Lê os eventos de uma resposta SSE. */
export function eventosSSE(corpo) {
  return String(corpo)
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)))
}
