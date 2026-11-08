/**
 * Registro de ferramentas do JARVIS 3.0 (próprio, sem MCP obrigatório).
 *
 * Cada ferramenta tem: nome, descrição, parâmetros (zod → JSON Schema para o
 * tool calling), categoria de risco e se exige confirmação do proprietário.
 *
 * Categorias: leitura · escrita (dados do próprio JARVIS) · externa (age fora:
 * agenda, e-mail) · computador (agente local) · destrutiva (apaga).
 * Não existe — e a política recusa — qualquer ferramenta financeira.
 */
import { z } from 'zod'
import { q } from '../db.mjs'
import { buscarSeguro, htmlParaTexto, naoConfiavel } from '../seguranca/rede.mjs'

export const CATEGORIAS = ['leitura', 'escrita', 'externa', 'computador', 'destrutiva']

const ISO = z.string().describe('data/hora ISO 8601 com fuso, ex.: 2026-11-10T14:00:00-03:00')
const quandoValido = (s) => {
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new Error(`data inválida: ${s}`)
  return new Date(t)
}

function def(nome, descricao, parametros, categoria, executar, extra = {}) {
  if (!CATEGORIAS.includes(categoria)) throw new Error(`categoria desconhecida: ${categoria}`)
  const schema = z.toJSONSchema(parametros)
  delete schema.$schema
  return { nome, descricao, parametros, schema, categoria, confirmar: extra.confirmar ?? (categoria === 'externa' || categoria === 'destrutiva'), disponivel: extra.disponivel ?? (() => true), resumir: extra.resumir, executar }
}

export function criarFerramentas() {
  const lista = [
    // ---------------------------------------------------------- tempo
    def('tempo.agora', 'Data e hora atuais no fuso do proprietário.', z.object({}), 'leitura', async (_a, c) => ({
      agora: new Date().toLocaleString('pt-BR', { timeZone: c.tz, dateStyle: 'full', timeStyle: 'short' }),
      iso: new Date().toISOString(),
      fuso: c.tz,
    })),

    // ---------------------------------------------------------- memória
    def('memoria.buscar', 'Busca na memória do proprietário (fatos, preferências, projetos, decisões, pessoas) por linguagem natural.', z.object({ consulta: z.string().min(2), tipos: z.array(z.string()).optional() }), 'leitura', async (a, c) =>
      (await c.memoria.buscar(c.ownerId, a.consulta, { k: 6, tipos: a.tipos })).map((m) => ({ id: m.id, tipo: m.tipo, titulo: m.titulo, conteudo: m.conteudo })),
    ),
    def(
      'memoria.salvar',
      'Guarda algo DURÁVEL que o proprietário pediu para lembrar ou afirmou sobre si. Não use para conversa passageira.',
      z.object({ tipo: z.enum(['fato', 'preferencia', 'projeto', 'conhecimento', 'decisao', 'pessoa', 'temporario']), titulo: z.string().min(2).max(120), conteudo: z.string().min(2).max(4000), importancia: z.number().int().min(1).max(5).optional() }),
      'escrita',
      async (a, c) => {
        if (/senha|cart[aã]o de cr[eé]dito|\bcvv\b|\d{3}\.\d{3}\.\d{3}-\d{2}/i.test(`${a.titulo} ${a.conteudo}`)) throw new Error('não guardo senhas, números de cartão ou documentos')
        const r = await c.memoria.salvar(c.ownerId, { ...a, origem: 'conversa' })
        return { id: r.memoria.id, atualizada: r.atualizada }
      },
    ),
    def('memoria.atualizar', 'Corrige uma memória existente (use o id da busca).', z.object({ id: z.uuid(), titulo: z.string().optional(), conteudo: z.string().optional(), tipo: z.string().optional() }), 'escrita', async (a, c) => {
      const m = await c.memoria.atualizar(c.ownerId, a.id, a)
      if (!m) throw new Error('memória não encontrada')
      return { id: m.id }
    }),
    def('memoria.excluir', 'Apaga uma memória (pede confirmação).', z.object({ id: z.uuid() }), 'destrutiva', async (a, c) => ({ ok: await c.memoria.excluir(c.ownerId, a.id) }), {
      resumir: async (a, c) => {
        const m = (await q('SELECT titulo FROM memorias WHERE id = $1 AND owner_id = $2', [a.id, c.ownerId])).rows[0]
        return `Apagar a memória "${m?.titulo ?? a.id}"`
      },
    }),

    // ---------------------------------------------------------- tarefas
    def('tarefas.listar', 'Lista as tarefas abertas (e as concluídas hoje).', z.object({ incluirConcluidas: z.boolean().optional() }), 'leitura', async (a, c) =>
      (await q(`SELECT id, texto, prazo, prioridade, feita FROM tarefas WHERE owner_id = $1 AND (NOT feita OR ($2 AND concluida > now() - interval '1 day')) ORDER BY feita, prioridade DESC, prazo NULLS LAST LIMIT 50`, [c.ownerId, Boolean(a.incluirConcluidas)])).rows,
    ),
    def('tarefas.criar', 'Cria uma tarefa (com prazo opcional).', z.object({ texto: z.string().min(2).max(300), prazo: ISO.optional(), prioridade: z.enum(['normal', 'alta']).optional() }), 'escrita', async (a, c) => {
      const igual = (await q(`SELECT id FROM tarefas WHERE owner_id = $1 AND NOT feita AND lower(texto) = lower($2)`, [c.ownerId, a.texto])).rows[0]
      if (igual) return { id: igual.id, duplicada: true }
      const r = await q(`INSERT INTO tarefas (owner_id, texto, prazo, prioridade) VALUES ($1, $2, $3, $4) RETURNING id`, [c.ownerId, a.texto, a.prazo ? quandoValido(a.prazo) : null, a.prioridade ?? 'normal'])
      return { id: r.rows[0].id }
    }),
    def('tarefas.concluir', 'Marca uma tarefa como feita (pelo id, ou pelo texto parecido).', z.object({ id: z.uuid().optional(), texto: z.string().optional() }), 'escrita', async (a, c) => {
      const r = a.id
        ? await q(`UPDATE tarefas SET feita = true, concluida = now() WHERE id = $1 AND owner_id = $2 AND NOT feita RETURNING id, texto`, [a.id, c.ownerId])
        : await q(`UPDATE tarefas SET feita = true, concluida = now() WHERE id = (SELECT id FROM tarefas WHERE owner_id = $1 AND NOT feita AND similarity(texto, $2) > 0.2 ORDER BY similarity(texto, $2) DESC LIMIT 1) RETURNING id, texto`, [c.ownerId, a.texto ?? ''])
      if (!r.rows[0]) throw new Error('tarefa não encontrada')
      return r.rows[0]
    }),
    def('tarefas.excluir', 'Apaga uma tarefa (pede confirmação).', z.object({ id: z.uuid() }), 'destrutiva', async (a, c) => ({ ok: (await q('DELETE FROM tarefas WHERE id = $1 AND owner_id = $2', [a.id, c.ownerId])).rowCount > 0 }), {
      resumir: async (a, c) => `Apagar a tarefa "${(await q('SELECT texto FROM tarefas WHERE id = $1 AND owner_id = $2', [a.id, c.ownerId])).rows[0]?.texto ?? a.id}"`,
    }),

    // ---------------------------------------------------------- lembretes e rotinas
    def('lembretes.criar', 'Agenda um lembrete; ele chega como notificação no celular/computador, mesmo com o app fechado.', z.object({ texto: z.string().min(1).max(300), quando: ISO }), 'escrita', async (a, c) => {
      const quando = quandoValido(a.quando)
      if (quando.getTime() < Date.now() - 60000) throw new Error('esse horário já passou')
      const r = await q(`INSERT INTO lembretes (owner_id, texto, quando) VALUES ($1, $2, $3) RETURNING id`, [c.ownerId, a.texto, quando])
      await c.agendar.lembrete({ id: r.rows[0].id, ownerId: c.ownerId, quando: quando.getTime() })
      return { id: r.rows[0].id, quando: quando.toISOString() }
    }),
    def('lembretes.listar', 'Lista os lembretes futuros.', z.object({}), 'leitura', async (_a, c) => (await q(`SELECT id, texto, quando FROM lembretes WHERE owner_id = $1 AND NOT enviado ORDER BY quando LIMIT 30`, [c.ownerId])).rows),
    def('lembretes.cancelar', 'Cancela um lembrete (pede confirmação).', z.object({ id: z.uuid() }), 'destrutiva', async (a, c) => {
      await c.agendar.cancelarLembrete(a.id)
      return { ok: (await q('DELETE FROM lembretes WHERE id = $1 AND owner_id = $2', [a.id, c.ownerId])).rowCount > 0 }
    }),
    def('rotinas.listar', 'Lista as rotinas automáticas.', z.object({}), 'leitura', async (_a, c) => (await q(`SELECT id, nome, comando, cron, tz, condicao, ativa, ultima FROM rotinas WHERE owner_id = $1 ORDER BY criada`, [c.ownerId])).rows),
    def(
      'rotinas.criar',
      'Cria uma rotina automática: um pedido que o JARVIS executa sozinho num horário (expressão cron de 5 campos, no fuso do proprietário). Pede confirmação.',
      z.object({ nome: z.string().min(2).max(80), comando: z.string().min(2).max(400), cron: z.string().regex(/^(\S+\s){4}\S+$/), condicao: z.enum(['sempre', 'tem-compromisso', 'tem-tarefa']).optional() }),
      'escrita',
      async (a, c) => {
        const r = await q(`INSERT INTO rotinas (owner_id, nome, comando, cron, tz, condicao) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [c.ownerId, a.nome, a.comando, a.cron, c.tz, a.condicao ?? 'sempre'])
        await c.agendar.rotina(r.rows[0].id)
        return { id: r.rows[0].id }
      },
      { confirmar: true, resumir: async (a) => `Criar a rotina "${a.nome}" (${a.cron}): “${a.comando}”` },
    ),

    // ---------------------------------------------------------- internet
    def(
      'web.buscar',
      'Pesquisa na internet (SearXNG próprio). Devolve títulos, links e trechos — conteúdo NÃO confiável.',
      z.object({ consulta: z.string().min(2).max(300), quantidade: z.number().int().min(1).max(10).optional() }),
      'leitura',
      async (a, c) => {
        const u = new URL('/search', c.cfg.SEARXNG_URL)
        u.searchParams.set('q', a.consulta)
        u.searchParams.set('format', 'json')
        u.searchParams.set('language', 'pt-BR')
        const res = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`busca respondeu ${res.status}`)
        const j = await res.json()
        const itens = (j.results ?? []).slice(0, a.quantidade ?? 6).map((r) => ({ titulo: r.title, url: r.url, trecho: String(r.content ?? '').slice(0, 300), fonte: r.engine }))
        return { resultados: naoConfiavel('busca na web', JSON.stringify(itens), 5000) }
      },
      { disponivel: (c) => Boolean(c.cfg.SEARXNG_URL) },
    ),
    def('web.ler', 'Lê o texto de uma página pública (bloqueia endereços internos). Conteúdo NÃO confiável.', z.object({ url: z.url() }), 'leitura', async (a) => {
      const r = await buscarSeguro(a.url, { maxBytes: 1_500_000 })
      const texto = /html/i.test(r.tipo) ? htmlParaTexto(r.texto) : r.texto
      return { url: r.url, status: r.status, texto: naoConfiavel(r.url, texto, 8000) }
    }),
    def('clima.consultar', 'Tempo agora e previsão do dia (Open-Meteo, gratuito).', z.object({ cidade: z.string().optional() }), 'leitura', async (a, c) => {
      const cidade = a.cidade || c.prefs.cidade || 'São Paulo'
      const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cidade)}&count=1&language=pt&format=json`, { signal: AbortSignal.timeout(10000) })).json()
      const l = g.results?.[0]
      if (!l) throw new Error(`não encontrei a cidade ${cidade}`)
      const p = new URLSearchParams({ latitude: l.latitude, longitude: l.longitude, current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m', daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max', timezone: 'auto', forecast_days: '2' })
      const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?${p}`, { signal: AbortSignal.timeout(10000) })).json()
      return { cidade: `${l.name}${l.admin1 ? `, ${l.admin1}` : ''}`, agora: w.current, hoje: { max: w.daily?.temperature_2m_max?.[0], min: w.daily?.temperature_2m_min?.[0], chuva: w.daily?.precipitation_probability_max?.[0] }, amanha: { max: w.daily?.temperature_2m_max?.[1], min: w.daily?.temperature_2m_min?.[1], chuva: w.daily?.precipitation_probability_max?.[1] } }
    }),
    def('noticias.buscar', 'Manchetes recentes de um assunto (Google Notícias RSS, sem chave).', z.object({ assunto: z.string().min(2).max(120), quantidade: z.number().int().min(1).max(10).optional() }), 'leitura', async (a) => {
      const r = await buscarSeguro(`https://news.google.com/rss/search?q=${encodeURIComponent(`${a.assunto} when:2d`)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`, { maxBytes: 800_000 })
      const itens = [...r.texto.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, a.quantidade ?? 6).map(([, it]) => ({
        titulo: htmlParaTexto(/<title>([\s\S]*?)<\/title>/.exec(it)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, ''),
        link: /<link>([\s\S]*?)<\/link>/.exec(it)?.[1] ?? '',
        data: /<pubDate>([\s\S]*?)<\/pubDate>/.exec(it)?.[1] ?? '',
      }))
      return { noticias: naoConfiavel('Google Notícias', JSON.stringify(itens), 5000) }
    }),

    // ---------------------------------------------------------- Google
    def('agenda.listar', 'Compromissos do Google Agenda num intervalo.', z.object({ de: ISO, ate: ISO }), 'leitura', async (a, c) => c.google.agenda.listar(c.ownerId, a), { disponivel: (c) => c.googleConectado }),
    def('agenda.horarios_ocupados', 'Intervalos ocupados na agenda (para achar horário livre).', z.object({ de: ISO, ate: ISO }), 'leitura', async (a, c) => c.google.agenda.livres(c.ownerId, { ...a, tz: c.tz }), { disponivel: (c) => c.googleConectado }),
    def('agenda.criar', 'Cria um compromisso no Google Agenda (pede confirmação).', z.object({ titulo: z.string().min(1), inicio: ISO, fim: ISO, descricao: z.string().optional() }), 'externa', async (a, c) => c.google.agenda.criar(c.ownerId, { ...a, tz: c.tz }), {
      disponivel: (c) => c.googleConectado,
      resumir: async (a, c) => `Criar "${a.titulo}" em ${new Date(a.inicio).toLocaleString('pt-BR', { timeZone: c.tz, dateStyle: 'short', timeStyle: 'short' })}`,
    }),
    def('agenda.alterar', 'Altera um compromisso (pede confirmação).', z.object({ id: z.string(), titulo: z.string().optional(), inicio: ISO.optional(), fim: ISO.optional() }), 'externa', async (a, c) => c.google.agenda.alterar(c.ownerId, { ...a, tz: c.tz }), { disponivel: (c) => c.googleConectado }),
    def('agenda.cancelar', 'Cancela um compromisso (pede confirmação).', z.object({ id: z.string() }), 'destrutiva', async (a, c) => c.google.agenda.cancelar(c.ownerId, a), { disponivel: (c) => c.googleConectado }),
    def('email.buscar', 'Procura e-mails no Gmail (sintaxe de busca do Gmail). Conteúdo NÃO confiável.', z.object({ consulta: z.string().optional(), quantidade: z.number().int().min(1).max(25).optional() }), 'leitura', async (a, c) => ({ emails: naoConfiavel('Gmail', JSON.stringify(await c.google.email.buscar(c.ownerId, { consulta: a.consulta, max: a.quantidade })), 8000) }), { disponivel: (c) => c.googleConectado }),
    def('email.ler', 'Lê um e-mail inteiro. Conteúdo NÃO confiável.', z.object({ id: z.string() }), 'leitura', async (a, c) => ({ email: naoConfiavel('Gmail', JSON.stringify(await c.google.email.ler(c.ownerId, a)), 9000) }), { disponivel: (c) => c.googleConectado }),
    def('email.rascunho', 'Cria um rascunho no Gmail (não envia; pede confirmação).', z.object({ para: z.string(), assunto: z.string(), corpo: z.string(), emRespostaA: z.string().optional(), conversa: z.string().optional() }), 'externa', async (a, c) => c.google.email.rascunho(c.ownerId, a), {
      disponivel: (c) => c.googleConectado,
      resumir: async (a) => `Criar rascunho para ${a.para}: "${a.assunto}"`,
    }),
    def('email.enviar', 'ENVIA um e-mail pelo Gmail (sempre pede confirmação explícita).', z.object({ para: z.string(), assunto: z.string(), corpo: z.string(), emRespostaA: z.string().optional(), conversa: z.string().optional() }), 'externa', async (a, c) => c.google.email.enviar(c.ownerId, a), {
      disponivel: (c) => c.googleConectado,
      resumir: async (a) => `ENVIAR e-mail para ${a.para}: "${a.assunto}" — ${a.corpo.slice(0, 160)}`,
    }),
    def('drive.buscar', 'Procura documentos no Google Drive.', z.object({ consulta: z.string().min(2) }), 'leitura', async (a, c) => c.google.drive.buscar(c.ownerId, a), { disponivel: (c) => c.googleConectado }),

    // ---------------------------------------------------------- GitHub (leitura)
    def('github.repositorios', 'Lista os repositórios do proprietário no GitHub.', z.object({}), 'leitura', async (_a, c) => {
      const r = await fetch('https://api.github.com/user/repos?sort=pushed&per_page=20', { headers: { authorization: `Bearer ${c.cfg.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
      if (!r.ok) throw new Error(`GitHub ${r.status}`)
      return (await r.json()).map((x) => ({ nome: x.full_name, privado: x.private, atualizado: x.pushed_at, url: x.html_url }))
    }, { disponivel: (c) => Boolean(c.cfg.GITHUB_TOKEN) }),
    def('github.issues', 'Issues abertas de um repositório.', z.object({ repositorio: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }), 'leitura', async (a, c) => {
      const r = await fetch(`https://api.github.com/repos/${a.repositorio}/issues?state=open&per_page=20`, { headers: { authorization: `Bearer ${c.cfg.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
      if (!r.ok) throw new Error(`GitHub ${r.status}`)
      return { issues: naoConfiavel('GitHub', JSON.stringify((await r.json()).map((i) => ({ numero: i.number, titulo: i.title, autor: i.user?.login }))), 5000) }
    }, { disponivel: (c) => Boolean(c.cfg.GITHUB_TOKEN) }),

    // ---------------------------------------------------------- computador (agente local)
    def(
      'pc.abrir',
      'Abre um site, programa ou pasta no computador pareado (só funciona com ele ligado).',
      z.object({ tipo: z.enum(['url', 'programa', 'pasta']), alvo: z.string().min(1).max(500), dispositivo: z.string().optional() }),
      'computador',
      async (a, c) => c.pc.executar(c.ownerId, a.dispositivo, 'abrir', { tipo: a.tipo, alvo: a.alvo }),
      { disponivel: (c) => c.pcOnline, confirmar: false },
    ),
    def(
      'pc.sistema',
      'Controle do computador pareado: volume, mudo, bloquear a tela, informações do sistema.',
      z.object({ acao: z.enum(['volume', 'mudo', 'bloquear', 'info']), valor: z.number().int().min(0).max(100).optional(), dispositivo: z.string().optional() }),
      'computador',
      async (a, c) => c.pc.executar(c.ownerId, a.dispositivo, 'sistema', { acao: a.acao, valor: a.valor }),
      { disponivel: (c) => c.pcOnline, confirmar: false },
    ),
    def('pc.listar_arquivos', 'Lista arquivos numa das pastas liberadas no agente local.', z.object({ pasta: z.string(), busca: z.string().optional(), dispositivo: z.string().optional() }), 'computador', async (a, c) => c.pc.executar(c.ownerId, a.dispositivo, 'listar', { pasta: a.pasta, busca: a.busca }), { disponivel: (c) => c.pcOnline, confirmar: false }),
  ]

  const porNome = new Map(lista.map((t) => [t.nome, t]))
  if (porNome.size !== lista.length) throw new Error('ferramentas com nome repetido')
  return {
    lista,
    obter: (n) => porNome.get(n),
    /** Ferramentas no formato do tool calling (nomes com "_" no lugar de ".", que alguns modelos exigem). */
    paraModelo: (nomes) =>
      nomes.map((n) => porNome.get(n)).filter(Boolean).map((t) => ({ type: 'function', function: { name: t.nome.replace('.', '__'), description: t.descricao, parameters: t.schema } })),
    deNomeModelo: (n) => porNome.get(String(n).replace('__', '.')),
  }
}
