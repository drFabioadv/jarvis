// Integração: API + PostgreSQL/pgvector + Redis/BullMQ + modelo aberto real
// (Ollama/Qwen) + provedor falso para roteiros de ferramentas. Nada aqui usa
// Claude, Anthropic ou login de terceiros.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { carregarConfig } from '../src/config.mjs'
import { montarServicos } from '../src/servicos.mjs'
import { criarApp } from '../src/server.mjs'
import { iniciarWorker } from '../src/worker.mjs'
import { gerarCodigoSetup } from '../src/auth.mjs'
import { codigoTotp } from '../src/seguranca/cripto.mjs'
import { q, fecharBanco } from '../src/db.mjs'
import { bancoNovo, limparRedis, provedorFalso, envBase, eventosSSE, ollamaNoAr, OLLAMA } from './apoio.mjs'

let db, app, real, fake, falso, cookie, ownerId, totp, worker
const H = (extra = {}) => ({ 'x-jarvis': '1', cookie, ...extra })
const EMAIL = 'dono@exemplo.com'
const SENHA = 'senha-forte-de-teste-123'
const temOllama = await ollamaNoAr()

before(async () => {
  db = await bancoNovo()
  await limparRedis()
  // Roteiro do provedor falso: ferramentas determinísticas.
  falso = await provedorFalso(async (corpo) => {
    const ult = corpo.messages[corpo.messages.length - 1]
    const pedido = [...corpo.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    if (ult.role === 'tool') return { texto: `Feito. Resultado: ${ult.content.slice(0, 80)}` }
    if (/crie a tarefa/i.test(pedido) && corpo.tools) return { ferramenta: 'tarefas.criar', args: { texto: 'Renovar a CNH', prioridade: 'alta' } }
    if (/apague a memória/i.test(pedido) && corpo.tools) {
      const id = /([0-9a-f-]{36})/.exec(pedido)?.[1]
      return { ferramenta: 'memoria.excluir', args: { id } }
    }
    if (/pesquisa proibida/i.test(pedido) && corpo.tools) return { ferramenta: 'tarefas.criar', args: { texto: 'não deveria' } }
    return { texto: 'Às ordens, senhor.' }
  })
  const env = envBase(db.url, temOllama ? { LLM_BASE_URL: OLLAMA, LLM_MODELO_PRINCIPAL: 'qwen2.5:0.5b', LLM_MODELO_EMBEDDINGS: 'all-minilm' } : { LLM_BASE_URL: falso.url, LLM_MODELO_PRINCIPAL: 'falso' })
  real = montarServicos({ cfg: carregarConfig(env) })
  fake = montarServicos({ cfg: carregarConfig({ ...env, LLM_BASE_URL: falso.url, LLM_MODELO_PRINCIPAL: 'falso', LLM_MODELO_EMBEDDINGS: 'falso-emb' }) })
  app = await criarApp({ servicos: real, logger: false })
})

after(async () => {
  await worker?.parar().catch(() => {})
  await app?.close()
  await fake?.filas.fechar().catch(() => {})
  await fake?.dispositivos.fechar().catch(() => {})
  await falso?.fechar()
  await fecharBanco()
  await db?.apagar()
})

test('1. sobe sem Claude: saúde da API, banco e Redis', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/saude' })
  assert.equal(r.statusCode, 200)
  const j = r.json()
  assert.equal(j.jarvis, 'cloud')
  assert.equal(j.banco, true)
  assert.equal(j.redis, true)
  assert.equal(j.ia, true)
  assert.equal(r.headers['x-frame-options'], 'DENY')
})

test('2. proprietário único: cadastro só com código de uso único', async () => {
  const sem = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-jarvis': '1' }, payload: { codigo: 'chute-qualquer-123', email: EMAIL, nome: 'Fabio', senha: SENHA } })
  assert.equal(sem.statusCode, 401)
  const codigo = await gerarCodigoSetup()
  const ok = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-jarvis': '1' }, payload: { codigo, email: EMAIL, nome: 'Fabio', senha: SENHA } })
  assert.equal(ok.statusCode, 200)
  cookie = ok.headers['set-cookie'].split(';')[0]
  assert.match(ok.headers['set-cookie'], /HttpOnly/i)
  assert.match(ok.headers['set-cookie'], /SameSite=Strict/i)
  ownerId = (await q('SELECT id FROM owners')).rows[0].id
  const de2 = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-jarvis': '1' }, payload: { codigo, email: 'outro@x.com', nome: 'Intruso', senha: SENHA } })
  assert.equal(de2.statusCode, 403, 'cadastro fechado depois do primeiro')
  await assert.rejects(gerarCodigoSetup(), /já existe/)
})

test('3. CSRF e segundo fator obrigatório', async () => {
  const semCab = await app.inject({ method: 'POST', url: '/api/tarefas', headers: { cookie }, payload: { texto: 'x' } })
  assert.equal(semCab.statusCode, 403)
  const fora = await app.inject({ method: 'POST', url: '/api/tarefas', headers: H({ origin: 'https://site-malicioso.com' }), payload: { texto: 'x' } })
  assert.equal(fora.statusCode, 403)
  const semMfa = await app.inject({ method: 'GET', url: '/api/tarefas', headers: H() })
  assert.equal(semMfa.statusCode, 403)
  assert.equal(semMfa.json().mfaPendente, true)
  const ini = (await app.inject({ method: 'POST', url: '/api/auth/totp/iniciar', headers: H() })).json()
  assert.match(ini.uri, /^otpauth:\/\/totp\/JARVIS:/)
  totp = ini.segredo
  const errado = await app.inject({ method: 'POST', url: '/api/auth/totp/confirmar', headers: H(), payload: { codigo: '000000' } })
  assert.equal(errado.statusCode, 400)
  const conf = await app.inject({ method: 'POST', url: '/api/auth/totp/confirmar', headers: H(), payload: { codigo: codigoTotp(totp) } })
  assert.equal(conf.statusCode, 200)
  assert.equal(conf.json().codigosRecuperacao.length, 10)
  assert.equal((await app.inject({ method: 'GET', url: '/api/tarefas', headers: H() })).statusCode, 200)
  const segredoNoBanco = (await q('SELECT totp_cifrado FROM owners')).rows[0].totp_cifrado
  assert.ok(!segredoNoBanco.includes(totp), 'TOTP cifrado em repouso')
})

test('4. login com TOTP, força bruta e sessões revogáveis', async () => {
  const p1 = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-jarvis': '1' }, payload: { email: EMAIL, senha: SENHA } })
  assert.deepEqual(p1.json(), { segundoFator: true })
  assert.equal(p1.headers['set-cookie'], undefined, 'sem sessão antes do segundo fator')
  const p2 = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-jarvis': '1' }, payload: { email: EMAIL, senha: SENHA, codigo: codigoTotp(totp) } })
  assert.equal(p2.statusCode, 200)
  const cookie2 = p2.headers['set-cookie'].split(';')[0]
  const sess = (await app.inject({ method: 'GET', url: '/api/auth/sessoes', headers: H() })).json()
  assert.equal(sess.length, 2)
  const outra = sess.find((s) => !s.atual)
  await app.inject({ method: 'DELETE', url: `/api/auth/sessoes/${outra.id}`, headers: H() })
  assert.equal((await app.inject({ method: 'GET', url: '/api/tarefas', headers: { cookie: cookie2 } })).statusCode, 401, 'sessão revogada não entra')
  for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-jarvis': '1' }, payload: { email: EMAIL, senha: 'errada-errada' } })
  const bloq = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-jarvis': '1' }, payload: { email: EMAIL, senha: SENHA, codigo: codigoTotp(totp) } })
  assert.equal(bloq.statusCode, 429, 'conta bloqueada após 5 erros')
  const acessos = (await app.inject({ method: 'GET', url: '/api/auth/acessos', headers: H() })).json()
  assert.ok(acessos.some((a) => a.acao === 'login_falhou'))
  assert.ok(!JSON.stringify(acessos).includes(SENHA), 'auditoria sem senha')
})

test('5. conversa por modelo aberto, com streaming e histórico no banco', { skip: !temOllama && 'Ollama indisponível' }, async () => {
  const r = await app.inject({ method: 'POST', url: '/api/conversa', headers: H(), payload: { texto: 'Responda só com uma palavra: qual a capital do Brasil?' } })
  const ev = eventosSSE(r.body)
  assert.ok(ev.some((e) => e.tipo === 'inicio'))
  const fim = ev.find((e) => e.tipo === 'fim')
  assert.ok(fim?.texto?.length > 0, 'respondeu')
  assert.ok(ev.filter((e) => e.tipo === 'texto').length > 0, 'veio em pedaços (streaming)')
  const hist = (await app.inject({ method: 'GET', url: `/api/conversas/${fim.conversaId}`, headers: H() })).json()
  assert.equal(hist.mensagens.length, 2)
  const uso = (await q(`SELECT modelo, ok FROM uso_modelos WHERE nivel = 'principal' ORDER BY id DESC LIMIT 1`)).rows[0]
  assert.equal(uso.modelo, 'qwen2.5:0.5b')
  assert.equal(uso.ok, true)
})

test('6. memória no PostgreSQL: busca semântica (pgvector), duplicatas e exclusão', async () => {
  const a = (await app.inject({ method: 'POST', url: '/api/memorias', headers: H(), payload: { tipo: 'projeto', titulo: 'Radar de licitações', conteudo: 'Site que acompanha editais de limpeza no Pará usando o PNCP', importancia: 4 } })).json()
  await app.inject({ method: 'POST', url: '/api/memorias', headers: H(), payload: { tipo: 'preferencia', titulo: 'Cronograma', conteudo: 'Prefere cronogramas de estudo dia a dia' } })
  await app.inject({ method: 'POST', url: '/api/memorias', headers: H(), payload: { tipo: 'pessoa', titulo: 'Iana', conteudo: 'Namorada do proprietário' } })
  const dup = (await app.inject({ method: 'POST', url: '/api/memorias', headers: H(), payload: { tipo: 'projeto', titulo: 'Radar de licitações', conteudo: 'Site que acompanha editais públicos de limpeza no Pará (PNCP)' } })).json()
  assert.equal(dup.atualizada, true, 'mesmo título atualiza em vez de duplicar')
  assert.equal((await q('SELECT count(*)::int AS n FROM memorias')).rows[0].n, 3)
  if (temOllama) assert.ok((await q('SELECT embedding FROM memorias WHERE id = $1', [a.memoria.id])).rows[0].embedding, 'vetor salvo no pgvector')
  const busca = (await app.inject({ method: 'GET', url: `/api/memorias?q=${encodeURIComponent('editais públicos')}`, headers: H() })).json()
  assert.equal(busca[0].titulo, 'Radar de licitações')
  const del = await app.inject({ method: 'DELETE', url: `/api/memorias/${a.memoria.id}`, headers: H() })
  assert.equal(del.json().ok, true)
})

test('7. ferramentas: tool calling cria tarefa; ação destrutiva exige confirmação; agente sem permissão é barrado', async () => {
  const r = await fake.orquestrador.executar({ ownerId, texto: 'Jarvis, crie a tarefa de renovar a CNH' })
  assert.deepEqual(r.ferramentas, ['tarefas.criar'])
  const t = (await q(`SELECT texto, prioridade FROM tarefas WHERE owner_id = $1`, [ownerId])).rows
  assert.deepEqual(t, [{ texto: 'Renovar a CNH', prioridade: 'alta' }])
  const m = (await fake.memoria.salvar(ownerId, { tipo: 'fato', titulo: 'Teste apagar', conteudo: 'vai ser apagada' })).memoria
  const r2 = await fake.orquestrador.executar({ ownerId, texto: `apague a memória ${m.id}`, agenteFixo: 'memoria' })
  assert.equal(r2.pendentes.length, 1, 'virou ação pendente')
  assert.ok((await q('SELECT 1 FROM memorias WHERE id = $1', [m.id])).rowCount, 'ainda não apagou')
  const pend = (await app.inject({ method: 'GET', url: '/api/acoes', headers: H() })).json()
  assert.match(pend[0].resumo, /Apagar a memória "Teste apagar"/)
  const conf = (await app.inject({ method: 'POST', url: `/api/acoes/${pend[0].id}`, headers: H(), payload: { confirmar: true } })).json()
  assert.equal(conf.estado, 'confirmada')
  assert.equal((await q('SELECT 1 FROM memorias WHERE id = $1', [m.id])).rowCount, 0, 'apagou só depois do OK')
  const r3 = await fake.orquestrador.executar({ ownerId, texto: 'pesquisa proibida: crie uma tarefa', agenteFixo: 'pesquisa' })
  assert.equal(r3.ferramentas.length, 0)
  assert.equal((await q(`SELECT count(*)::int AS n FROM tarefas WHERE texto = 'não deveria'`)).rows[0].n, 0, 'agente de pesquisa não cria tarefas')
  assert.ok((await q(`SELECT 1 FROM auditoria WHERE acao = 'ferramenta_negada'`)).rowCount)
})

test('8. fila: tarefa de fundo, cancelamento, lembrete e recuperação após reinício', async () => {
  worker = await iniciarWorker({ servicos: fake, migrar: false })
  const id = await fake.filas.enfileirar(ownerId, { texto: 'Diga às ordens', titulo: 'Teste de fundo', notificar: false })
  for (let i = 0; i < 50; i++) {
    const e = (await q('SELECT estado FROM trabalhos WHERE id = $1', [id])).rows[0].estado
    if (e === 'concluido') break
    await new Promise((r) => setTimeout(r, 200))
  }
  assert.equal((await q('SELECT estado FROM trabalhos WHERE id = $1', [id])).rows[0].estado, 'concluido')
  // Cancelamento antes de rodar (fila pausada)
  await worker.wTarefas.pause()
  const id2 = await fake.filas.enfileirar(ownerId, { texto: 'não rode', notificar: false })
  const c = await app.inject({ method: 'DELETE', url: `/api/trabalhos/${id2}`, headers: H() })
  assert.equal(c.json().ok, true)
  assert.equal((await q('SELECT estado FROM trabalhos WHERE id = $1', [id2])).rows[0].estado, 'cancelado')
  worker.wTarefas.resume()
  // Lembrete para daqui a 2 s; o worker "cai" e outro sobe — o lembrete sai mesmo assim.
  const quando = new Date(Date.now() + 2000).toISOString()
  const l = (await app.inject({ method: 'POST', url: '/api/lembretes', headers: H(), payload: { texto: 'beber água', quando } })).json()
  await worker.parar()
  worker = await iniciarWorker({ migrar: false, servicosFabrica: true, servicos: undefined, cfgFabrica: fake.cfg })
  for (let i = 0; i < 40; i++) {
    if ((await q('SELECT enviado FROM lembretes WHERE id = $1', [l.id])).rows[0].enviado) break
    await new Promise((r) => setTimeout(r, 200))
  }
  assert.equal((await q('SELECT enviado FROM lembretes WHERE id = $1', [l.id])).rows[0].enviado, true, 'lembrete entregue depois do reinício')
})

test('9. rotinas com cron no fuso do proprietário', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/rotinas', headers: H(), payload: { nome: 'Bom dia', comando: 'bom dia', cron: '30 7 * * 1-5', tz: 'America/Sao_Paulo' } })
  assert.equal(r.statusCode, 200)
  const sched = await fake.filas.agenda.getJobScheduler(`rotina-${r.json().id}`)
  assert.equal(sched.pattern, '30 7 * * 1-5')
  assert.equal(sched.tz, 'America/Sao_Paulo')
  const ruim = await app.inject({ method: 'POST', url: '/api/rotinas', headers: H(), payload: { nome: 'x', comando: 'y y', cron: '99 99 * * *' } })
  assert.equal(ruim.statusCode, 400, 'cron inválido recusado')
  const rod = (await app.inject({ method: 'POST', url: `/api/rotinas/${r.json().id}/rodar`, headers: H() })).json()
  assert.ok(rod.trabalhoId)
})

test('10. agente local pareado: conexão de saída, comando permitido, revogação', async () => {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const porta = app.server.address().port
  const { codigo } = (await app.inject({ method: 'POST', url: '/api/dispositivos/codigo', headers: H() })).json()
  const ruim = await app.inject({ method: 'POST', url: '/api/dispositivos/parear', payload: { codigo: 'ERRADO12', nome: 'PC' } })
  assert.equal(ruim.statusCode, 401)
  const par = (await app.inject({ method: 'POST', url: '/api/dispositivos/parear', payload: { codigo, nome: 'Notebook' } })).json()
  assert.ok(par.token)
  assert.equal((await app.inject({ method: 'POST', url: '/api/dispositivos/parear', payload: { codigo, nome: 'De novo' } })).statusCode, 401, 'código de uso único')
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/api/agente`, { headers: { authorization: `Bearer ${par.token}` } })
  await new Promise((res, rej) => {
    ws.once('message', res)
    ws.once('error', rej)
  })
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.tipo === 'comando') ws.send(JSON.stringify({ tipo: 'resultado', id: m.id, ok: true, resultado: { abriu: m.args.alvo } }))
  })
  await new Promise((r) => setTimeout(r, 300))
  const lista = (await app.inject({ method: 'GET', url: '/api/dispositivos', headers: H() })).json()
  assert.equal(lista[0].online, true)
  // O worker (outro processo, na vida real) pede pelo Redis:
  const res = await fake.dispositivos.executar(ownerId, null, 'abrir', { tipo: 'url', alvo: 'https://youtube.com' })
  assert.deepEqual(res, { abriu: 'https://youtube.com' })
  await assert.rejects(fake.dispositivos.executar(ownerId, null, 'apagar_tudo', {}), /não permitido/)
  await app.inject({ method: 'PATCH', url: `/api/dispositivos/${lista[0].id}`, headers: H(), payload: { permissoes: ['sistema'] } })
  await assert.rejects(fake.dispositivos.executar(ownerId, null, 'abrir', { tipo: 'url', alvo: 'x' }), /permissão/)
  const fechou = new Promise((r) => ws.once('close', (c) => r(c)))
  await app.inject({ method: 'DELETE', url: `/api/dispositivos/${lista[0].id}`, headers: H() })
  assert.equal(await fechou, 4001)
  const ws2 = new WebSocket(`ws://127.0.0.1:${porta}/api/agente`, { headers: { authorization: `Bearer ${par.token}` } })
  assert.equal(await new Promise((r) => ws2.once('close', (c) => r(c))), 4003, 'token revogado não conecta')
})

test('11. migração do JARVIS 2.0: simulação, importação e exportação sem credenciais', async () => {
  const pacote = { formato: 'jarvis-2-pacote', versao: 1, notas: [{ area: 'metas', title: 'Concursos', body: 'Passar no TRT-8 e na ALEPA' }], tarefas: [{ texto: 'Estudar direito administrativo', prazo: null, feita: false }], rotinas: [{ nome: 'Bom dia', comando: 'bom dia', frequencia: 'dias-uteis', horario: '07:30' }], lembretes: [] }
  const sim = (await app.inject({ method: 'POST', url: '/api/migracao/importar', headers: H(), payload: { pacote } })).json()
  assert.equal(sim.simulado, true)
  assert.equal((await q(`SELECT count(*)::int AS n FROM memorias WHERE titulo = 'Concursos'`)).rows[0].n, 0, 'simulação não grava')
  const imp = (await app.inject({ method: 'POST', url: '/api/migracao/importar', headers: H(), payload: { pacote, simular: false } })).json()
  assert.equal(imp.contagem.memorias, 1)
  assert.equal((await q(`SELECT ativa, cron FROM rotinas WHERE nome = 'Bom dia' AND NOT ativa`)).rows[0].cron, '30 7 * * 1-5', 'rotina chega pausada')
  const exp = await app.inject({ method: 'GET', url: '/api/exportar', headers: H() })
  assert.equal(exp.statusCode, 200)
  assert.ok(exp.json().memorias.some((m) => m.titulo === 'Concursos'))
  assert.doesNotMatch(exp.body, /senha_hash|totp|token|scrypt/i, 'exportação sem credenciais')
})

test('12. respostas da API não vazam credenciais', async () => {
  for (const url of ['/api/auth/estado', '/api/config', '/api/integracoes', '/api/uso', '/api/dispositivos']) {
    const r = await app.inject({ method: 'GET', url, headers: H() })
    assert.doesNotMatch(r.body, /scrypt\$|totp_cifrado|token_hash|JARVIS_MASTER|LLM_API_KEY|"v1\.[\w-]+\.[\w-]+\./, url)
  }
})
