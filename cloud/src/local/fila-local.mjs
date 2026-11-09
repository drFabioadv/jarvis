/**
 * Fila e agendador do modo PC — sem Redis/BullMQ. O estado inteiro mora no
 * banco (trabalhos, lembretes, rotinas), então um reinício do PC não perde
 * nada: ao voltar, o que estava na fila roda, e lembretes vencidos há pouco
 * são entregues.
 *
 * - Tarefas de fundo: até 2 ao mesmo tempo, por prioridade, 3 tentativas
 *   com espera crescente, cancelamento.
 * - Lembretes: conferidos a cada 10 s.
 * - Rotinas: cron no fuso de cada rotina (horário de verão incluído, via
 *   cron-parser); se o PC estava desligado na hora, roda se o atraso for de
 *   até 2 horas.
 * - Manutenção: todo dia às 3h (ou na primeira vez que o PC ligar depois).
 */
import { randomUUID } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import { q } from '../db.mjs'
import { RedisMemoria } from './redis-memoria.mjs'

export function proximaExecucao(cron, tz, de = new Date()) {
  return CronExpressionParser.parse(cron, { currentDate: de, tz }).next().toDate()
}
export function ultimaExecucao(cron, tz, ate = new Date()) {
  return CronExpressionParser.parse(cron, { currentDate: ate, tz }).prev().toDate()
}

export function criarFilasLocais({ tz = 'America/Sao_Paulo' } = {}) {
  const conexao = new RedisMemoria()
  const rodando = new Set()
  const esperaAte = new Map()
  let timers = []
  let manutencaoFeita = ''

  async function enfileirar(ownerId, { texto, agente = 'assistente', titulo, prioridade = 5, profundidade = 0, notificar = true }) {
    if (profundidade > 1) throw new Error('tarefas não podem criar tarefas (recursão bloqueada)')
    const id = randomUUID()
    await q(`INSERT INTO trabalhos (id, owner_id, tipo, titulo, prioridade, dados, profundidade) VALUES ($1, $2, 'agente', $3, $4, $5, $6)`, [id, ownerId, (titulo ?? texto).slice(0, 120), prioridade, { texto, agente, notificar }, profundidade])
    setImmediate(() => void ciclo?.())
    return id
  }

  async function cancelar(ownerId, id) {
    const r = await q(`UPDATE trabalhos SET cancelar = true, estado = CASE WHEN estado = 'na_fila' THEN 'cancelado' ELSE estado END, terminado = CASE WHEN estado = 'na_fila' THEN now() ELSE terminado END WHERE id = $1 AND owner_id = $2 RETURNING estado`, [id, ownerId])
    return Boolean(r.rows[0])
  }

  // No modo PC o banco já é a agenda: estes só existem para a API ser a mesma.
  const nada = async () => {}
  let ciclo = null

  /**
   * Liga o processamento. `tarefa(job)` e `agenda(job)` são os mesmos
   * processadores do worker do servidor (recebem um "job" parecido com o do BullMQ).
   */
  function pararProcessamento() {
    for (const t of timers) clearInterval(t)
    timers = []
  }

  function processar({ tarefa, agenda, concorrencia = 2 }) {
    pararProcessamento()
    // O PC desligou no meio de uma tarefa? Ela volta para a fila.
    void q(`UPDATE trabalhos SET estado = 'na_fila' WHERE estado = 'executando'`).catch(() => {})
    ciclo = async () => {
      if (rodando.size >= concorrencia) return
      const livres = concorrencia - rodando.size
      const prontos = (
        await q(`SELECT id, owner_id, tentativas FROM trabalhos WHERE estado = 'na_fila' AND NOT cancelar AND tipo = 'agente' ORDER BY prioridade, criado LIMIT ${livres + rodando.size}`)
      ).rows.filter((t) => !rodando.has(t.id) && (esperaAte.get(t.id) ?? 0) <= Date.now())
      for (const t of prontos.slice(0, livres)) {
        rodando.add(t.id)
        const job = { name: 'agente', id: t.id, data: { trabalhoId: t.id, ownerId: t.owner_id }, attemptsMade: t.tentativas, opts: { attempts: 3 } }
        void tarefa(job)
          .catch((err) => {
            esperaAte.set(t.id, Date.now() + 5000 * 2 ** t.tentativas)
            console.warn(`[fila] tarefa ${t.id} falhou (tentativa ${t.tentativas + 1}): ${err.message}`)
          })
          .finally(() => {
            rodando.delete(t.id)
            setImmediate(() => void ciclo())
          })
      }
    }
    const lembretes = async () => {
      const ls = (await q(`SELECT id FROM lembretes WHERE NOT enviado AND quando <= now() AND quando > now() - interval '12 hours' ORDER BY quando LIMIT 20`)).rows
      for (const l of ls) await agenda({ name: 'lembrete', id: `lembrete-${l.id}`, data: { lembreteId: l.id } }).catch((e) => console.warn('[fila] lembrete:', e.message))
    }
    const rotinas = async () => {
      const rs = (await q(`SELECT id, cron, tz, ultima, criada FROM rotinas WHERE ativa`)).rows
      const agora = new Date()
      for (const r of rs) {
        let devida
        try {
          devida = ultimaExecucao(r.cron, r.tz, agora)
        } catch {
          continue
        }
        const desde = new Date(r.ultima ?? r.criada)
        if (devida > desde && agora - devida < 2 * 3600000)
          await agenda({ name: 'rotina', id: `rotina-${r.id}-${devida.getTime()}`, data: { rotinaId: r.id } }).catch((e) => console.warn('[fila] rotina:', e.message))
      }
    }
    const manutencao = async () => {
      const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: tz })
      const hora = Number(new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }))
      if (manutencaoFeita === hoje || hora < 3) return
      manutencaoFeita = hoje
      await agenda({ name: 'manutencao', id: `manutencao-${hoje}`, data: {} }).catch((e) => console.warn('[fila] manutenção:', e.message))
    }
    const seguro = (fn) => () => void fn().catch((e) => console.warn('[fila]', e.message))
    timers = [setInterval(seguro(ciclo), 1500), setInterval(seguro(lembretes), 10000), setInterval(seguro(rotinas), 30000), setInterval(seguro(manutencao), 10 * 60000)]
    // Logo ao ligar: o que ficou na fila e lembretes vencidos durante o desligamento.
    timers.push(setTimeout(seguro(async () => (await ciclo(), await lembretes(), await rotinas())), 500))
    manutencaoFeita = new Date().toLocaleDateString('pt-BR', { timeZone: tz })
  }

  async function sincronizar() {
    const rot = (await q('SELECT count(*)::int AS n FROM rotinas WHERE ativa')).rows[0].n
    const lem = (await q('SELECT count(*)::int AS n FROM lembretes WHERE NOT enviado')).rows[0].n
    return { rotinas: rot, lembretes: lem }
  }

  async function fechar() {
    pararProcessamento()
    // Espera as tarefas em andamento terminarem (até 10 s).
    for (let i = 0; i < 100 && rodando.size; i++) await new Promise((r) => setTimeout(r, 100))
    conexao.disconnect()
  }

  return { local: true, conexao, enfileirar, cancelar, lembrete: nada, cancelarLembrete: nada, rotina: nada, removerRotina: nada, sincronizar, processar, pararProcessamento, fechar }
}
