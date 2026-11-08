/**
 * Worker do JARVIS 3.0: executa as tarefas de fundo, os lembretes, as rotinas
 * e a manutenção — sem interface aberta, 24 horas por dia.
 *
 * Recuperação: o BullMQ guarda tudo no Redis (com AOF ligado no compose) e
 * retoma trabalhos interrompidos; ao subir, o worker também recria os
 * agendamentos a partir do banco (rotinas e lembretes futuros).
 */
import { Worker } from 'bullmq'
import { q } from './db.mjs'
import { montarServicos } from './servicos.mjs'
import { consolidarConversa } from './memoria.mjs'
import { FILA_AGENDA, FILA_TAREFAS, conexaoRedis } from './filas.mjs'
import { LIMITES } from './agentes/agentes.mjs'
import { auditar } from './seguranca/auditoria.mjs'
import { migrar } from './db.mjs'

export async function iniciarWorker(opts = {}) {
  // Só fecha no fim os serviços que ele mesmo criou.
  const proprios = !opts.servicos
  const s = opts.servicos ?? montarServicos(opts.cfgFabrica ? { cfg: opts.cfgFabrica } : undefined)
  const { orquestrador, push, filas, memoria, gateway } = s
  if (opts.migrar !== false) await migrar('up')

  let conT, conA
  // ---- pedidos para os agentes
  const wTarefas = new Worker(
    FILA_TAREFAS,
    async (job) => {
      const t = (await q('SELECT * FROM trabalhos WHERE id = $1', [job.data.trabalhoId])).rows[0]
      if (!t || t.cancelar || t.estado === 'cancelado') return { ignorado: true }
      if (t.profundidade > LIMITES.maxProfundidade) throw new Error('profundidade máxima')
      await q(`UPDATE trabalhos SET estado = 'executando', iniciado = now(), tentativas = tentativas + 1 WHERE id = $1`, [t.id])
      const ctrl = new AbortController()
      // Cancelamento durante a execução: confere o pedido no banco a cada 2 s.
      const vigia = setInterval(async () => {
        const c = (await q('SELECT cancelar FROM trabalhos WHERE id = $1', [t.id]).catch(() => ({ rows: [] }))).rows[0]
        if (c?.cancelar) ctrl.abort(new Error('cancelado pelo proprietário'))
      }, 2000)
      try {
        const r = await orquestrador.executar({ ownerId: t.owner_id, texto: t.dados.texto, canal: 'tarefa', agenteFixo: t.dados.agente, signal: ctrl.signal, prazoMs: LIMITES.maxMsTarefaFundo })
        if (ctrl.signal.aborted) throw ctrl.signal.reason
        await q(`UPDATE trabalhos SET estado = 'concluido', terminado = now(), resultado = $2 WHERE id = $1`, [t.id, { texto: r.texto, conversaId: r.conversaId, pendentes: r.pendentes }])
        if (t.dados.notificar !== false) await push.enviar(t.owner_id, { titulo: `✓ ${t.titulo}`, corpo: r.texto, url: `/?conversa=${r.conversaId}`, tag: `trabalho-${t.id}` })
        return { ok: true }
      } catch (err) {
        const cancelado = ctrl.signal.aborted
        await q(`UPDATE trabalhos SET estado = $2, erro = $3, terminado = now() WHERE id = $1`, [t.id, cancelado ? 'cancelado' : job.attemptsMade + 1 >= (job.opts.attempts ?? 1) ? 'falhou' : 'na_fila', String(err?.message ?? err).slice(0, 500)])
        if (cancelado) return { cancelado: true }
        throw err
      } finally {
        clearInterval(vigia)
      }
    },
    { connection: (conT = conexaoRedis(s.cfg.REDIS_URL)), concurrency: 2, lockDuration: 60000, stalledInterval: 30000, maxStalledCount: 2 },
  )

  // ---- lembretes, rotinas e manutenção
  const wAgenda = new Worker(
    FILA_AGENDA,
    async (job) => {
      if (job.name === 'lembrete') {
        const l = (await q(`UPDATE lembretes SET enviado = true WHERE id = $1 AND NOT enviado RETURNING *`, [job.data.lembreteId])).rows[0]
        if (!l) return { ignorado: true }
        await push.enviar(l.owner_id, { titulo: '⏰ Lembrete', corpo: l.texto, url: '/', tag: `lembrete-${l.id}` })
        await auditar(l.owner_id, 'lembrete_enviado', {})
        return { ok: true }
      }
      if (job.name === 'rotina') {
        const r = (await q('SELECT * FROM rotinas WHERE id = $1', [job.data.rotinaId])).rows[0]
        if (!r || !r.ativa) {
          await filas.removerRotina(job.data.rotinaId)
          return { ignorado: true }
        }
        if (r.condicao === 'tem-tarefa' && !(await q('SELECT 1 FROM tarefas WHERE owner_id = $1 AND NOT feita LIMIT 1', [r.owner_id])).rowCount) {
          await q('UPDATE rotinas SET ultima = now() WHERE id = $1', [r.id])
          return { pulada: 'sem tarefas' }
        }
        const res = await orquestrador.executar({ ownerId: r.owner_id, texto: r.comando, canal: 'rotina', prazoMs: LIMITES.maxMsTarefaFundo })
        await q('UPDATE rotinas SET ultima = now() WHERE id = $1', [r.id])
        await q(`INSERT INTO trabalhos (id, owner_id, tipo, titulo, estado, dados, resultado, iniciado, terminado) VALUES ($1, $2, 'rotina', $3, 'concluido', $4, $5, now(), now()) ON CONFLICT (id) DO NOTHING`, [`rotina-${r.id}-${job.id}`, r.owner_id, r.nome, { rotinaId: r.id }, { texto: res.texto }])
        if (r.notificar) await push.enviar(r.owner_id, { titulo: r.nome, corpo: res.texto, url: `/?conversa=${res.conversaId}`, tag: `rotina-${r.id}` })
        return { ok: true }
      }
      if (job.name === 'manutencao') {
        const expiradas = await memoria.limparExpiradas()
        await q(`DELETE FROM tentativas_login WHERE em < now() - interval '1 day'`)
        await q(`DELETE FROM sessoes WHERE expira < now() - interval '30 days' OR (revogada AND criada < now() - interval '30 days')`)
        await q(`UPDATE acoes_pendentes SET estado = 'expirada' WHERE estado = 'aguardando' AND expira < now()`)
        let consolidadas = 0
        if (gateway.temNivel('rapido') || gateway.temNivel('principal')) {
          const convs = (await q(`SELECT c.id, c.owner_id FROM conversas c WHERE c.atualizada > now() - interval '2 days' AND EXISTS (SELECT 1 FROM mensagens m WHERE m.conversa_id = c.id AND m.id > c.consolidada_ate)`)).rows
          for (const c of convs) {
            try {
              consolidadas += (await consolidarConversa({ gateway, memoria, ownerId: c.owner_id, conversaId: c.id })).salvas
            } catch (err) {
              console.warn('[worker] consolidação falhou:', err.message)
            }
          }
        }
        return { expiradas, consolidadas }
      }
      throw new Error(`trabalho desconhecido: ${job.name}`)
    },
    { connection: (conA = conexaoRedis(s.cfg.REDIS_URL)), concurrency: 4, lockDuration: 60000 },
  )

  for (const w of [wTarefas, wAgenda]) w.on('failed', (job, err) => console.warn(`[worker] ${job?.name} falhou (tentativa ${job?.attemptsMade}): ${err.message}`))
  const sinc = await filas.sincronizar()
  console.log(`[worker] pronto — ${sinc.rotinas} rotina(s) e ${sinc.lembretes} lembrete(s) restaurados`)

  async function parar() {
    await Promise.allSettled([wTarefas.close(), wAgenda.close()])
    conT?.disconnect()
    conA?.disconnect()
    if (proprios) {
      await filas.fechar()
      await s.dispositivos.fechar()
    }
  }
  return { parar, wTarefas, wAgenda, servicos: s }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const w = await iniciarWorker()
  for (const sinal of ['SIGTERM', 'SIGINT'])
    process.on(sinal, async () => {
      console.log('[worker] encerrando com calma...')
      await w.parar()
      process.exit(0)
    })
}
