/**
 * Filas de fundo (Redis + BullMQ) — o JARVIS trabalha sem nenhum navegador
 * aberto e sobrevive a reinícios.
 *
 *   jarvis-tarefas   pedidos para os agentes (pesquisas longas, resumos...),
 *                    com prioridade, retentativas e cancelamento.
 *   jarvis-agenda    lembretes (atrasados até a hora), rotinas (cron no fuso
 *                    do proprietário, horário de verão incluído) e manutenção
 *                    (consolidação da memória, limpeza).
 *
 * O estado de cada trabalho também fica no Postgres (tabela trabalhos), para
 * o histórico e para o painel.
 */
import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { q } from './db.mjs'

export const FILA_TAREFAS = 'jarvis-tarefas'
export const FILA_AGENDA = 'jarvis-agenda'

export function conexaoRedis(url) {
  return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true })
}

export function criarFilas(redisUrl) {
  const conexao = conexaoRedis(redisUrl)
  const tarefas = new Queue(FILA_TAREFAS, { connection: conexao, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { count: 500 }, removeOnFail: { count: 500 } } })
  const agenda = new Queue(FILA_AGENDA, { connection: conexao, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: { count: 1000 }, removeOnFail: { count: 500 } } })

  /** Põe um pedido para um agente na fila. Prioridade: 1 (urgente) a 10. */
  async function enfileirar(ownerId, { texto, agente = 'assistente', titulo, prioridade = 5, profundidade = 0, notificar = true }) {
    if (profundidade > 1) throw new Error('tarefas não podem criar tarefas (recursão bloqueada)')
    const id = randomUUID()
    await q(`INSERT INTO trabalhos (id, owner_id, tipo, titulo, prioridade, dados, profundidade) VALUES ($1, $2, 'agente', $3, $4, $5, $6)`, [id, ownerId, (titulo ?? texto).slice(0, 120), prioridade, { texto, agente, notificar }, profundidade])
    await tarefas.add('agente', { trabalhoId: id, ownerId }, { jobId: id, priority: Math.max(1, Math.min(10, prioridade)) })
    return id
  }

  async function cancelar(ownerId, id) {
    const r = await q(`UPDATE trabalhos SET cancelar = true, estado = CASE WHEN estado = 'na_fila' THEN 'cancelado' ELSE estado END, terminado = CASE WHEN estado = 'na_fila' THEN now() ELSE terminado END WHERE id = $1 AND owner_id = $2 RETURNING estado`, [id, ownerId])
    if (!r.rows[0]) return false
    const job = await tarefas.getJob(id)
    if (job && (await job.isWaiting().catch(() => false))) await job.remove().catch(() => {})
    return true
  }

  async function lembrete({ id, quando }) {
    const antigo = await agenda.getJob(`lembrete-${id}`)
    if (antigo) await antigo.remove().catch(() => {})
    await agenda.add('lembrete', { lembreteId: id }, { jobId: `lembrete-${id}`, delay: Math.max(0, quando - Date.now()) })
  }

  async function cancelarLembrete(id) {
    const j = await agenda.getJob(`lembrete-${id}`)
    if (j) await j.remove().catch(() => {})
  }

  /** Cria/atualiza o agendamento de uma rotina a partir do banco. */
  async function rotina(id) {
    const r = (await q('SELECT * FROM rotinas WHERE id = $1', [id])).rows[0]
    if (!r || !r.ativa) {
      await agenda.removeJobScheduler(`rotina-${id}`).catch(() => {})
      return
    }
    await agenda.upsertJobScheduler(`rotina-${id}`, { pattern: r.cron, tz: r.tz }, { name: 'rotina', data: { rotinaId: id } })
  }

  async function removerRotina(id) {
    await agenda.removeJobScheduler(`rotina-${id}`).catch(() => {})
  }

  /**
   * Depois de um reinício: recria agendamentos das rotinas ativas e os
   * lembretes futuros que não estejam na fila (idempotente pelo jobId).
   */
  async function sincronizar() {
    const rot = (await q('SELECT id FROM rotinas WHERE ativa')).rows
    for (const r of rot) await rotina(r.id)
    const lem = (await q(`SELECT id, quando FROM lembretes WHERE NOT enviado`)).rows
    for (const l of lem) if (!(await agenda.getJob(`lembrete-${l.id}`))) await agenda.add('lembrete', { lembreteId: l.id }, { jobId: `lembrete-${l.id}`, delay: Math.max(0, new Date(l.quando).getTime() - Date.now()) })
    // Manutenção diária às 3h no fuso do servidor: consolida memória e limpa expiradas.
    await agenda.upsertJobScheduler('manutencao', { pattern: '0 3 * * *', tz: process.env.JARVIS_TZ || 'America/Sao_Paulo' }, { name: 'manutencao', data: {} })
    return { rotinas: rot.length, lembretes: lem.length }
  }

  async function fechar() {
    await tarefas.close()
    await agenda.close()
    await conexao.quit().catch(() => {})
  }

  return { tarefas, agenda, enfileirar, cancelar, lembrete, cancelarLembrete, rotina, removerRotina, sincronizar, fechar, conexao }
}
