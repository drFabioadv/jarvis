// MODO PC: tudo no próprio computador — PGlite (sem servidor de banco),
// fila/agendador em processo (sem Redis), modelo local. Sem Anthropic.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { carregarConfig } from '../src/config.mjs'
import { montarServicos } from '../src/servicos.mjs'
import { criarApp } from '../src/server.mjs'
import { iniciarWorker } from '../src/worker.mjs'
import { gerarCodigoSetup } from '../src/auth.mjs'
import { codigoTotp } from '../src/seguranca/cripto.mjs'
import { q, fecharBanco } from '../src/db.mjs'
import { configPc, ambientePc } from '../src/pc.mjs'
import { ultimaExecucao, proximaExecucao } from '../src/local/fila-local.mjs'
import { provedorFalso, eventosSSE } from './apoio.mjs'

let app, s, w, falso, cookie, ownerId, pc
const H = (x = {}) => ({ 'x-jarvis': '1', cookie, ...x })
const espera = async (fn, ms = 15000) => {
  const fim = Date.now() + ms
  while (Date.now() < fim) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

before(async () => {
  falso = await provedorFalso(async (corpo) => {
    const ult = corpo.messages[corpo.messages.length - 1]
    const pedido = [...corpo.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    if (ult.role === 'tool') return { texto: 'Pronto, senhor.' }
    if (/anota a tarefa/i.test(pedido) && corpo.tools) return { ferramenta: 'tarefas.criar', args: { texto: 'Comprar toner' } }
    return { texto: `Resposta local para: ${pedido.slice(0, 40)}` }
  })
  pc = await configPc(mkdtempSync(join(tmpdir(), 'jarvis-pc-')))
  const env = { ...ambientePc(pc), LOG_LEVEL: 'silent', JARVIS_STT_NUVEM: '0', LLM_BASE_URL: falso.url, LLM_MODELO_PRINCIPAL: 'local', LLM_MODELO_EMBEDDINGS: 'emb', JARVIS_MODELOS: '' }
  process.env.JARVIS_ORIGENS_EXTRAS = env.JARVIS_ORIGENS_EXTRAS
  process.env.JARVIS_TOKEN_INTERNO = env.JARVIS_TOKEN_INTERNO
  s = montarServicos({ cfg: carregarConfig(env) })
  app = await criarApp({ servicos: s, logger: false })
  w = await iniciarWorker({ servicos: s, migrar: false })
})

after(async () => {
  await w?.parar()
  await app?.close()
  await falso?.fechar()
  await fecharBanco()
})

test('1. sobe com banco embutido e fila em memória (sem Postgres, Redis ou Docker)', async () => {
  const r = (await app.inject({ method: 'GET', url: '/api/saude' })).json()
  assert.equal(r.banco, true)
  assert.equal(r.redis, true)
  assert.equal(r.push, true, 'chaves de notificação geradas sozinhas')
  assert.match(process.env.DATABASE_URL ?? ambientePc(pc).DATABASE_URL, /^pglite:/)
  assert.equal(s.filas.local, true)
})

test('2. conta, autenticador e conversa com o modelo local', async () => {
  const codigo = await gerarCodigoSetup()
  const r = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-jarvis': '1' }, payload: { codigo, email: 'eu@pc.local', nome: 'Fabio', senha: 'senha-bem-longa-123' } })
  cookie = r.headers['set-cookie'].split(';')[0]
  ownerId = (await q('SELECT id FROM owners')).rows[0].id
  const t = (await app.inject({ method: 'POST', url: '/api/auth/totp/iniciar', headers: H() })).json()
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/totp/confirmar', headers: H(), payload: { codigo: codigoTotp(t.segredo) } })).statusCode, 200)
  const c = await app.inject({ method: 'POST', url: '/api/conversa', headers: H(), payload: { texto: 'Jarvis, anota a tarefa comprar toner' } })
  const fim = eventosSSE(c.body).find((e) => e.tipo === 'fim')
  assert.equal(fim.texto, 'Pronto, senhor.')
  assert.equal((await q(`SELECT texto FROM tarefas`)).rows[0].texto, 'Comprar toner')
  // memória com vetor no PGlite
  const m = (await app.inject({ method: 'POST', url: '/api/memorias', headers: H(), payload: { tipo: 'projeto', titulo: 'Radar de licitações', conteudo: 'editais de limpeza no Pará' } })).json()
  assert.ok(m.memoria.id)
  const b = (await app.inject({ method: 'GET', url: `/api/memorias?q=${encodeURIComponent('editais limpeza')}`, headers: H() })).json()
  assert.equal(b[0].titulo, 'Radar de licitações')
})

test('3. tarefa de fundo, lembrete e rotina rodam sem Redis', async () => {
  const id = await s.filas.enfileirar(ownerId, { texto: 'resuma meu dia', notificar: false })
  assert.ok(await espera(async () => (await q('SELECT estado FROM trabalhos WHERE id = $1', [id])).rows[0].estado === 'concluido'), 'tarefa concluída')
  const l = (await q(`INSERT INTO lembretes (owner_id, texto, quando) VALUES ($1, 'beber água', now() - interval '1 second') RETURNING id`, [ownerId])).rows[0]
  assert.ok(await espera(async () => (await q('SELECT enviado FROM lembretes WHERE id = $1', [l.id])).rows[0].enviado, 20000), 'lembrete entregue')
  // rotina que "devia" ter rodado há 1 minuto
  const agora = new Date()
  const cron = `${(agora.getUTCMinutes() + 59) % 60} * * * *`
  const r = (await q(`INSERT INTO rotinas (owner_id, nome, comando, cron, tz, criada) VALUES ($1, 'Teste', 'diga oi', $2, 'UTC', now() - interval '2 hours') RETURNING id`, [ownerId, cron])).rows[0]
  assert.ok(await espera(async () => Boolean((await q('SELECT ultima FROM rotinas WHERE id = $1', [r.id])).rows[0].ultima), 40000), 'rotina executada')
  assert.equal((await q(`SELECT count(*)::int AS n FROM mensagens WHERE conteudo = 'diga oi'`)).rows[0].n, 1, 'rodou uma vez só')
})

test('4. cron no fuso de Belém e de São Paulo', () => {
  const base = new Date('2026-11-09T12:00:00Z') // segunda, 9h em Belém
  assert.equal(ultimaExecucao('30 7 * * 1-5', 'America/Belem', base).toISOString(), '2026-11-09T10:30:00.000Z')
  assert.equal(proximaExecucao('30 7 * * 1-5', 'America/Sao_Paulo', base).toISOString(), '2026-11-10T10:30:00.000Z')
})

test('5. PC desligou no meio de uma tarefa: ela volta para a fila', async () => {
  const id = 'interrompida-1'
  await q(`INSERT INTO trabalhos (id, owner_id, tipo, titulo, estado, dados) VALUES ($1, $2, 'agente', 'x', 'executando', $3)`, [id, ownerId, { texto: 'continue', agente: 'assistente', notificar: false }])
  await w.parar()
  w = await iniciarWorker({ servicos: s, migrar: false })
  assert.ok(await espera(async () => (await q('SELECT estado FROM trabalhos WHERE id = $1', [id])).rows[0].estado === 'concluido'), 'retomada depois de reiniciar')
})

test('6. canal interno (JARVIS da bandeja → cérebro do PC): só local e com token', async () => {
  const sem = await app.inject({ method: 'POST', url: '/api/interno/conversa', headers: { 'x-jarvis': '1' }, payload: { texto: 'oi' } })
  assert.equal(sem.statusCode, 403)
  const ok = await app.inject({ method: 'POST', url: '/api/interno/conversa', headers: { 'x-jarvis': '1', 'x-jarvis-interno': pc.tokenInterno }, payload: { texto: 'que horas são' }, remoteAddress: '127.0.0.1' })
  assert.equal(eventosSSE(ok.body).find((e) => e.tipo === 'fim').texto, 'Resposta local para: que horas são')
})

test('7. computador pareado funciona com o pub/sub em memória', async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { codigo } = (await app.inject({ method: 'POST', url: '/api/dispositivos/codigo', headers: H() })).json()
  const par = (await app.inject({ method: 'POST', url: '/api/dispositivos/parear', payload: { codigo, nome: 'Notebook' } })).json()
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/api/agente`, { headers: { authorization: `Bearer ${par.token}` } })
  await new Promise((r) => ws.once('message', r))
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.tipo === 'comando') ws.send(JSON.stringify({ tipo: 'resultado', id: m.id, ok: true, resultado: { ok: m.comando } }))
  })
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(await s.dispositivos.executar(ownerId, null, 'sistema', { acao: 'info' }), { ok: 'sistema' })
  ws.close()
})
