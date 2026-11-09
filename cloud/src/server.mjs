/**
 * API do JARVIS 3.0 — a única porta de entrada da interface (web, PWA,
 * celular) e do agente local. Serve também o frontend já compilado.
 */
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import fstatic from '@fastify/static'
import websocket from '@fastify/websocket'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { q, migrar } from './db.mjs'
import { montarServicos, prefsDe } from './servicos.mjs'
import { registrarAuth } from './auth.mjs'
import { auditar } from './seguranca/auditoria.mjs'
import { importarPacote } from './migracao.mjs'
import { AGENTES } from './agentes/agentes.mjs'
import { carregarStt, estadoStt, transcrever } from './voz/stt.mjs'
import { iguais } from './seguranca/cripto.mjs'

const VERSAO = '3.0.0'

export async function criarApp(opts = {}) {
  const s = opts.servicos ?? montarServicos()
  const { cfg, orquestrador, memoria, filas, push, dispositivos, google, gateway } = s
  if (opts.migrar !== false) await migrar('up')

  const app = Fastify({
    logger: opts.logger ?? { level: cfg.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.senha', 'req.body.codigo'] },
    trustProxy: cfg.JARVIS_CONFIAR_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  })
  await app.register(cookie)
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } })

  // ---- cabeçalhos de segurança (XSS, clickjacking, HTTPS)
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'same-origin')
    reply.header('permissions-policy', 'camera=(self), microphone=(self), geolocation=()')
    reply.header('cross-origin-opener-policy', 'same-origin')
    if (cfg.https) reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains')
    if (!req.url.startsWith('/api/'))
      reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: data:; connect-src 'self' https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      )
    else reply.header('cache-control', 'no-store')
    return payload
  })

  // ---- limite de requisições por IP (Redis, vale para várias instâncias)
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return
    const pesada = req.url.startsWith('/api/conversa') || req.url.startsWith('/api/trabalhos')
    const limite = pesada ? 30 : 300
    const chave = `rl:${pesada ? 'p' : 'g'}:${req.ip}:${Math.floor(Date.now() / 60000)}`
    const n = await filas.conexao.incr(chave)
    if (n === 1) await filas.conexao.expire(chave, 70)
    if (n > limite) return reply.code(429).send({ erro: 'muitas requisições; aguarde um minuto' })
  })

  const { exigirSessao } = registrarAuth(app, { cfg })
  const auth = { preHandler: exigirSessao }
  const corpo = (schema, req, reply) => {
    const r = schema.safeParse(req.body ?? {})
    if (!r.success) {
      reply.code(400).send({ erro: 'dados inválidos', detalhes: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
      return null
    }
    return r.data
  }

  // ---------------------------------------------------------------- saúde
  app.get('/api/saude', async (_req, reply) => {
    const r = { jarvis: 'cloud', versao: VERSAO, banco: false, redis: false, ia: gateway.temNivel('principal'), push: push.ativo, google: google.configurado, busca: Boolean(cfg.SEARXNG_URL), sttNuvem: sttNuvem && !estadoStt().falha }
    try {
      await q('SELECT 1')
      r.banco = true
    } catch {}
    try {
      r.redis = (await filas.conexao.ping()) === 'PONG'
    } catch {}
    return reply.code(r.banco && r.redis ? 200 : 503).send(r)
  })

  // ---------------------------------------------------------------- audição (Whisper no servidor, opcional)
  const sttNuvem = process.env.JARVIS_STT_NUVEM === '1'
  if (sttNuvem) void carregarStt()
  app.addContentTypeParser('audio/pcm-f32-16k', { parseAs: 'buffer', bodyLimit: 16000 * 4 * 21 }, (_req, b, done) => done(null, b))
  app.post('/api/stt', auth, async (req, reply) => {
    if (!sttNuvem) return reply.code(404).send({ erro: 'audição na nuvem desligada (JARVIS_STT_NUVEM=1)' })
    try {
      return { text: await transcrever(req.body) }
    } catch (err) {
      return reply.code(503).send({ erro: err.message })
    }
  })

  // ---------------------------------------------------------------- conversa (streaming SSE)
  const Conversa = z.object({ texto: z.string().min(1).max(8000), conversaId: z.uuid().optional(), canal: z.enum(['web', 'voz']).optional() })
  app.post('/api/conversa', auth, async (req, reply) => {
    const d = corpo(Conversa, req, reply)
    if (!d) return
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const ctrl = new AbortController()
    req.raw.on('close', () => {
      if (!reply.raw.writableEnded) ctrl.abort(new Error('cliente saiu'))
    })
    const enviar = (e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    const pulso = setInterval(() => reply.raw.write(': pulso\n\n'), 15000)
    try {
      await orquestrador.executar({ ownerId: req.ownerId, conversaId: d.conversaId, texto: d.texto, canal: d.canal ?? 'web', aoEvento: enviar, signal: ctrl.signal })
    } catch (err) {
      enviar({ tipo: 'erro', mensagem: String(err?.message ?? err).slice(0, 300) })
    } finally {
      clearInterval(pulso)
      reply.raw.end()
    }
    return reply
  })

  // ---------------------------------------------------------------- canal interno (modo PC)
  // O JARVIS do PC (bandeja, voz, comandos locais) manda para cá o que não
  // resolve sozinho. Só aceita do próprio computador e com o token interno.
  const tokenInterno = process.env.JARVIS_TOKEN_INTERNO
  if (tokenInterno) {
    let conversaInterna = null
    app.post('/api/interno/conversa', async (req, reply) => {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      if (!local || !iguais(String(req.headers['x-jarvis-interno'] ?? ''), tokenInterno)) return reply.code(403).send({ erro: 'proibido' })
      const dono = (await q('SELECT id FROM owners LIMIT 1')).rows[0]
      if (!dono) return reply.code(409).send({ erro: 'crie a sua conta primeiro (abra o JARVIS no navegador)' })
      const d = corpo(z.object({ texto: z.string().min(1).max(8000), nova: z.boolean().optional() }), req, reply)
      if (!d) return
      if (d.nova) conversaInterna = null
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
      const ctrl = new AbortController()
      req.raw.on('close', () => {
        if (!reply.raw.writableEnded) ctrl.abort(new Error('cancelado'))
      })
      const enviar = (e) => {
        if (e.tipo === 'inicio') conversaInterna = e.conversaId
        reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
      }
      try {
        // Conversa contínua: a mesma por até 30 min sem uso.
        const c = conversaInterna && (await q(`SELECT 1 FROM conversas WHERE id = $1 AND atualizada > now() - interval '30 minutes'`, [conversaInterna])).rowCount ? conversaInterna : undefined
        await orquestrador.executar({ ownerId: dono.id, conversaId: c, texto: d.texto, canal: 'voz', aoEvento: enviar, signal: ctrl.signal })
      } catch (err) {
        enviar({ tipo: 'erro', mensagem: String(err?.message ?? err).slice(0, 300) })
      } finally {
        reply.raw.end()
      }
      return reply
    })
  }

  app.get('/api/conversas', auth, async (req) => (await q(`SELECT id, titulo, resumo, criada, atualizada FROM conversas WHERE owner_id = $1 ORDER BY atualizada DESC LIMIT 100`, [req.ownerId])).rows)
  app.get('/api/conversas/:id', auth, async (req, reply) => {
    const c = (await q('SELECT id, titulo, resumo FROM conversas WHERE id = $1 AND owner_id = $2', [req.params.id, req.ownerId])).rows[0]
    if (!c) return reply.code(404).send({ erro: 'não encontrada' })
    c.mensagens = (await q(`SELECT papel, conteudo, meta, criada FROM mensagens WHERE conversa_id = $1 AND papel IN ('usuario','jarvis') ORDER BY id LIMIT 500`, [c.id])).rows
    return c
  })
  app.delete('/api/conversas/:id', auth, async (req) => ({ ok: (await q('DELETE FROM conversas WHERE id = $1 AND owner_id = $2', [req.params.id, req.ownerId])).rowCount > 0 }))

  // ---------------------------------------------------------------- ações pendentes (confirmação)
  app.get('/api/acoes', auth, async (req) => (await q(`SELECT id, ferramenta, resumo, criada, expira FROM acoes_pendentes WHERE owner_id = $1 AND estado = 'aguardando' AND expira > now() ORDER BY criada DESC`, [req.ownerId])).rows)
  app.post('/api/acoes/:id', auth, async (req, reply) => {
    try {
      return await orquestrador.decidirAcao(req.ownerId, req.params.id, req.body?.confirmar === true)
    } catch (err) {
      return reply.code(404).send({ erro: err.message })
    }
  })

  // ---------------------------------------------------------------- memória
  const Mem = z.object({ tipo: z.enum(['fato', 'preferencia', 'projeto', 'conhecimento', 'decisao', 'pessoa', 'temporario']), titulo: z.string().min(1).max(120), conteudo: z.string().min(1).max(4000), importancia: z.number().int().min(1).max(5).optional() })
  app.get('/api/memorias', auth, async (req) => (req.query.q ? memoria.buscar(req.ownerId, String(req.query.q), { k: 20 }) : memoria.listar(req.ownerId, { tipo: req.query.tipo })))
  app.get('/api/memorias/relacoes', auth, async (req) => memoria.relacoes(req.ownerId))
  app.post('/api/memorias', auth, async (req, reply) => {
    const d = corpo(Mem, req, reply)
    if (!d) return
    return memoria.salvar(req.ownerId, { ...d, origem: 'painel' })
  })
  app.patch('/api/memorias/:id', auth, async (req, reply) => {
    const d = corpo(Mem.partial(), req, reply)
    if (!d) return
    const m = await memoria.atualizar(req.ownerId, req.params.id, d)
    return m ?? reply.code(404).send({ erro: 'não encontrada' })
  })
  app.delete('/api/memorias/:id', auth, async (req) => {
    const ok = await memoria.excluir(req.ownerId, req.params.id)
    await auditar(req.ownerId, 'memoria_excluida', {}, req.ip)
    return { ok }
  })
  app.post('/api/memorias/relacionar', auth, async (req) => ({ ok: await memoria.relacionar(req.ownerId, String(req.body?.a), String(req.body?.b), String(req.body?.tipo ?? 'relacionada')) }))

  // ---------------------------------------------------------------- tarefas, lembretes, rotinas
  app.get('/api/tarefas', auth, async (req) => (await q(`SELECT id, texto, prazo, prioridade, feita, criada, concluida FROM tarefas WHERE owner_id = $1 AND (NOT feita OR concluida > now() - interval '7 days') ORDER BY feita, prioridade DESC, prazo NULLS LAST, criada`, [req.ownerId])).rows)
  const Tarefa = z.object({ texto: z.string().min(1).max(300), prazo: z.iso.datetime({ offset: true }).nullable().optional(), prioridade: z.enum(['normal', 'alta']).optional(), feita: z.boolean().optional() })
  app.post('/api/tarefas', auth, async (req, reply) => {
    const d = corpo(Tarefa, req, reply)
    if (!d) return
    return (await q(`INSERT INTO tarefas (owner_id, texto, prazo, prioridade) VALUES ($1, $2, $3, $4) RETURNING *`, [req.ownerId, d.texto, d.prazo ?? null, d.prioridade ?? 'normal'])).rows[0]
  })
  app.patch('/api/tarefas/:id', auth, async (req, reply) => {
    const d = corpo(Tarefa.partial(), req, reply)
    if (!d) return
    const r = await q(
      `UPDATE tarefas SET texto = COALESCE($3, texto), prazo = CASE WHEN $4::boolean THEN $5::timestamptz ELSE prazo END, prioridade = COALESCE($6, prioridade),
         feita = COALESCE($7, feita), concluida = CASE WHEN $7 IS TRUE THEN now() WHEN $7 IS FALSE THEN NULL ELSE concluida END
       WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [req.params.id, req.ownerId, d.texto ?? null, 'prazo' in d, d.prazo ?? null, d.prioridade ?? null, d.feita ?? null],
    )
    return r.rows[0] ?? reply.code(404).send({ erro: 'não encontrada' })
  })
  app.delete('/api/tarefas/:id', auth, async (req) => ({ ok: (await q('DELETE FROM tarefas WHERE id = $1 AND owner_id = $2', [req.params.id, req.ownerId])).rowCount > 0 }))

  app.get('/api/lembretes', auth, async (req) => (await q(`SELECT id, texto, quando, enviado FROM lembretes WHERE owner_id = $1 AND (NOT enviado OR quando > now() - interval '1 day') ORDER BY quando`, [req.ownerId])).rows)
  app.post('/api/lembretes', auth, async (req, reply) => {
    const d = corpo(z.object({ texto: z.string().min(1).max(300), quando: z.iso.datetime({ offset: true }) }), req, reply)
    if (!d) return
    const r = (await q(`INSERT INTO lembretes (owner_id, texto, quando) VALUES ($1, $2, $3) RETURNING *`, [req.ownerId, d.texto, d.quando])).rows[0]
    await filas.lembrete({ id: r.id, quando: new Date(r.quando).getTime() })
    return r
  })
  app.delete('/api/lembretes/:id', auth, async (req) => {
    await filas.cancelarLembrete(req.params.id)
    return { ok: (await q('DELETE FROM lembretes WHERE id = $1 AND owner_id = $2', [req.params.id, req.ownerId])).rowCount > 0 }
  })

  const Rotina = z.object({ nome: z.string().min(1).max(80), descricao: z.string().max(300).optional(), comando: z.string().min(2).max(400), cron: z.string().regex(/^(\S+\s){4}\S+$/, 'cron de 5 campos'), tz: z.string().optional(), condicao: z.enum(['sempre', 'tem-tarefa']).optional(), ativa: z.boolean().optional(), notificar: z.boolean().optional() })
  app.get('/api/rotinas', auth, async (req) => (await q(`SELECT * FROM rotinas WHERE owner_id = $1 ORDER BY criada`, [req.ownerId])).rows)
  app.post('/api/rotinas', auth, async (req, reply) => {
    const d = corpo(Rotina, req, reply)
    if (!d) return
    const tz = d.tz ?? (await prefsDe(req.ownerId)).tz ?? cfg.JARVIS_TZ
    const r = (await q(`INSERT INTO rotinas (owner_id, nome, descricao, comando, cron, tz, condicao, ativa, notificar) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.ownerId, d.nome, d.descricao ?? '', d.comando, d.cron, tz, d.condicao ?? 'sempre', d.ativa ?? true, d.notificar ?? true])).rows[0]
    try {
      await filas.rotina(r.id)
    } catch (err) {
      await q('DELETE FROM rotinas WHERE id = $1', [r.id])
      return reply.code(400).send({ erro: `horário inválido: ${err.message}` })
    }
    return r
  })
  app.patch('/api/rotinas/:id', auth, async (req, reply) => {
    const d = corpo(Rotina.partial(), req, reply)
    if (!d) return
    const r = (await q(`UPDATE rotinas SET nome = COALESCE($3, nome), descricao = COALESCE($4, descricao), comando = COALESCE($5, comando), cron = COALESCE($6, cron), tz = COALESCE($7, tz), condicao = COALESCE($8, condicao), ativa = COALESCE($9, ativa), notificar = COALESCE($10, notificar) WHERE id = $1 AND owner_id = $2 RETURNING *`, [req.params.id, req.ownerId, d.nome, d.descricao, d.comando, d.cron, d.tz, d.condicao, d.ativa, d.notificar])).rows[0]
    if (!r) return reply.code(404).send({ erro: 'não encontrada' })
    await filas.rotina(r.id)
    return r
  })
  app.delete('/api/rotinas/:id', auth, async (req) => {
    await filas.removerRotina(req.params.id)
    return { ok: (await q('DELETE FROM rotinas WHERE id = $1 AND owner_id = $2', [req.params.id, req.ownerId])).rowCount > 0 }
  })
  app.post('/api/rotinas/:id/rodar', auth, async (req, reply) => {
    const r = (await q('SELECT * FROM rotinas WHERE id = $1 AND owner_id = $2', [req.params.id, req.ownerId])).rows[0]
    if (!r) return reply.code(404).send({ erro: 'não encontrada' })
    return { trabalhoId: await filas.enfileirar(req.ownerId, { texto: r.comando, titulo: r.nome, prioridade: 3 }) }
  })

  // ---------------------------------------------------------------- tarefas de fundo
  app.get('/api/trabalhos', auth, async (req) => (await q(`SELECT id, tipo, titulo, estado, prioridade, resultado, erro, tentativas, criado, iniciado, terminado FROM trabalhos WHERE owner_id = $1 ORDER BY criado DESC LIMIT 100`, [req.ownerId])).rows)
  app.post('/api/trabalhos', auth, async (req, reply) => {
    const d = corpo(z.object({ texto: z.string().min(2).max(4000), agente: z.enum(Object.keys(AGENTES)).optional(), titulo: z.string().max(120).optional(), prioridade: z.number().int().min(1).max(10).optional() }), req, reply)
    if (!d) return
    return { id: await filas.enfileirar(req.ownerId, d) }
  })
  app.delete('/api/trabalhos/:id', auth, async (req) => ({ ok: await filas.cancelar(req.ownerId, req.params.id) }))

  // ---------------------------------------------------------------- notificações
  app.get('/api/push/chave', auth, async () => ({ ativo: push.ativo, chave: push.chavePublica }))
  app.post('/api/push/inscrever', auth, async (req, reply) => {
    try {
      await push.inscrever(req.ownerId, req.body?.inscricao, req.headers['user-agent'])
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ erro: err.message })
    }
  })
  app.post('/api/push/teste', auth, async (req) => push.enviar(req.ownerId, { titulo: 'J.A.R.V.I.S.', corpo: 'Notificações funcionando, senhor.' }))
  app.delete('/api/push/inscrever', auth, async (req) => {
    await push.cancelar(req.ownerId, String(req.body?.endpoint ?? ''))
    return { ok: true }
  })

  // ---------------------------------------------------------------- computadores pareados
  app.get('/api/dispositivos', auth, async (req) => dispositivos.listar(req.ownerId))
  app.post('/api/dispositivos/codigo', auth, async (req) => {
    await auditar(req.ownerId, 'codigo_pareamento_gerado', {}, req.ip)
    return { codigo: await dispositivos.gerarCodigo(req.ownerId), validoMinutos: 10 }
  })
  app.post('/api/dispositivos/parear', async (req, reply) => {
    const n = await filas.conexao.incr(`par:${req.ip}`)
    if (n === 1) await filas.conexao.expire(req.ip ? `par:${req.ip}` : 'par:x', 900)
    if (n > 10) return reply.code(429).send({ erro: 'muitas tentativas' })
    try {
      return await dispositivos.parear(req.body?.codigo, req.body?.nome, req.ip)
    } catch (err) {
      return reply.code(401).send({ erro: err.message })
    }
  })
  app.delete('/api/dispositivos/:id', auth, async (req) => {
    await auditar(req.ownerId, 'dispositivo_revogado', {}, req.ip)
    return { ok: await dispositivos.revogar(req.ownerId, req.params.id) }
  })
  app.patch('/api/dispositivos/:id', auth, async (req) => ({ permissoes: await dispositivos.definirPermissoes(req.ownerId, req.params.id, Array.isArray(req.body?.permissoes) ? req.body.permissoes : []) }))
  app.get('/api/agente', { websocket: true }, async (socket, req) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const d = await dispositivos.autenticar(token)
    if (!d) return socket.close(4003, 'token inválido')
    dispositivos.aceitar(socket, d)
    socket.send(JSON.stringify({ tipo: 'ola', nome: d.nome, permissoes: d.permissoes }))
  })

  // ---------------------------------------------------------------- integrações
  app.get('/api/integracoes', auth, async (req) => ({ google: await google.estado(req.ownerId), github: { configurado: Boolean(cfg.GITHUB_TOKEN) }, busca: { configurado: Boolean(cfg.SEARXNG_URL) }, push: { configurado: push.ativo } }))
  app.get('/api/integracoes/google/iniciar', auth, async (req, reply) => {
    try {
      return reply.redirect(await google.iniciar(req.ownerId))
    } catch (err) {
      return reply.code(400).send({ erro: err.message })
    }
  })
  app.get('/api/integracoes/google/retorno', auth, async (req, reply) => {
    try {
      const r = await google.concluir(req.ownerId, { code: String(req.query.code ?? ''), state: String(req.query.state ?? '') })
      await auditar(req.ownerId, 'integracao_conectada', { provedor: 'google', conta: r.conta }, req.ip)
      return reply.redirect('/?integracao=google-ok')
    } catch (err) {
      return reply.redirect(`/?integracao=erro&msg=${encodeURIComponent(err.message.slice(0, 120))}`)
    }
  })
  app.delete('/api/integracoes/google', auth, async (req) => {
    await google.desconectar(req.ownerId)
    await auditar(req.ownerId, 'integracao_revogada', { provedor: 'google' }, req.ip)
    return { ok: true }
  })

  // ---------------------------------------------------------------- preferências
  const Prefs = z.object({ tratamento: z.string().max(40).optional(), cidade: z.string().max(80).optional(), tz: z.string().max(60).optional(), temas: z.array(z.string().max(40)).max(10).optional(), nome: z.string().min(1).max(80).optional() })
  app.get('/api/config', auth, async (req) => prefsDe(req.ownerId))
  app.patch('/api/config', auth, async (req, reply) => {
    const d = corpo(Prefs, req, reply)
    if (!d) return
    if (d.tz) {
      try {
        new Intl.DateTimeFormat('pt-BR', { timeZone: d.tz })
      } catch {
        return reply.code(400).send({ erro: 'fuso horário inválido' })
      }
    }
    const { nome, ...resto } = d
    if (nome) await q('UPDATE owners SET nome = $2 WHERE id = $1', [req.ownerId, nome])
    await q(`INSERT INTO config_owner (owner_id, dados) VALUES ($1, $2) ON CONFLICT (owner_id) DO UPDATE SET dados = config_owner.dados || EXCLUDED.dados`, [req.ownerId, resto])
    return prefsDe(req.ownerId)
  })

  // ---------------------------------------------------------------- consumo de IA
  app.get('/api/uso', auth, async () => ({
    hoje: (await q(`SELECT modelo, nivel, count(*)::int AS chamadas, sum(tokens_entrada)::int AS entrada, sum(tokens_saida)::int AS saida, sum(custo_usd)::float AS custo, avg(latencia_ms)::int AS latencia, sum(CASE WHEN ok THEN 0 ELSE 1 END)::int AS falhas FROM uso_modelos WHERE em > date_trunc('day', now()) GROUP BY modelo, nivel ORDER BY chamadas DESC`)).rows,
    dias: (await q(`SELECT date_trunc('day', em)::date AS dia, sum(custo_usd)::float AS custo, count(*)::int AS chamadas FROM uso_modelos WHERE em > now() - interval '30 days' GROUP BY 1 ORDER BY 1`)).rows,
    orcamento: gateway.orcamento(),
    metricas: gateway.metricas(),
  }))

  // ---------------------------------------------------------------- migração e exportação
  app.post('/api/migracao/importar', auth, async (req, reply) => {
    try {
      const r = await importarPacote({ ownerId: req.ownerId, pacote: req.body?.pacote, simular: req.body?.simular !== false, memoria })
      if (!r.simulado) await auditar(req.ownerId, 'migracao_importada', r.contagem, req.ip)
      return r
    } catch (err) {
      return reply.code(400).send({ erro: err.message })
    }
  })
  app.get('/api/exportar', auth, async (req, reply) => {
    const o = req.ownerId
    const dados = {
      formato: 'jarvis-3-exportacao',
      versao: 1,
      gerado: new Date().toISOString(),
      memorias: (await q('SELECT tipo, titulo, conteudo, importancia, origem, expira_em, criada FROM memorias WHERE owner_id = $1', [o])).rows,
      tarefas: (await q('SELECT texto, prazo, prioridade, feita, criada, concluida FROM tarefas WHERE owner_id = $1', [o])).rows,
      lembretes: (await q('SELECT texto, quando, enviado FROM lembretes WHERE owner_id = $1', [o])).rows,
      rotinas: (await q('SELECT nome, descricao, comando, cron, tz, condicao, ativa FROM rotinas WHERE owner_id = $1', [o])).rows,
      conversas: (await q(`SELECT c.titulo, c.criada, json_agg(json_build_object('papel', m.papel, 'conteudo', m.conteudo, 'criada', m.criada) ORDER BY m.id) AS mensagens FROM conversas c JOIN mensagens m ON m.conversa_id = c.id WHERE c.owner_id = $1 AND m.papel IN ('usuario','jarvis') GROUP BY c.id`, [o])).rows,
      preferencias: await prefsDe(o),
    }
    await auditar(o, 'dados_exportados', {}, req.ip)
    reply.header('content-disposition', `attachment; filename="jarvis-exportacao-${new Date().toISOString().slice(0, 10)}.json"`)
    return dados
  })

  // ---------------------------------------------------------------- frontend (PWA)
  const pasta = cfg.JARVIS_STATIC_DIR
  if (pasta && existsSync(pasta)) {
    await app.register(fstatic, {
      root: pasta,
      wildcard: false,
      setHeaders: (res, caminho) => {
        if (/\/(sw\.js|index\.html|manifest\.webmanifest)$/.test(caminho)) res.header('cache-control', 'no-cache')
        else if (/\/assets\//.test(caminho)) res.header('cache-control', 'public, max-age=31536000, immutable')
      },
    })
    app.get('/*', async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ erro: 'rota não encontrada' })
      const arq = req.url.split('?')[0].replace(/^\/+/, '')
      if (arq && /\.[a-z0-9]+$/i.test(arq) && existsSync(`${pasta}/${arq}`)) return reply.sendFile(arq)
      return reply.sendFile('index.html')
    })
  }

  app.addHook('onClose', async () => {
    await filas.fechar()
    await dispositivos.fechar()
  })
  await dispositivos.ouvirPedidos()
  return app
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await criarApp()
  const { PORT, HOST } = (await import('./config.mjs')).carregarConfig()
  await app.listen({ port: PORT, host: HOST })
  for (const sinal of ['SIGTERM', 'SIGINT'])
    process.on(sinal, async () => {
      await app.close()
      process.exit(0)
    })
}
