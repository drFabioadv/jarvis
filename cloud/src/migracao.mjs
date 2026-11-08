/**
 * Migração do JARVIS 2.0 (arquivos locais) para a nuvem.
 *
 * No PC, `node cloud/src/cli/exportar-local.mjs` junta segundo-cerebro.json,
 * tarefas.json, rotinas.json e lembretes.json num pacote. Credenciais
 * (integracoes.json, senhas de app, tokens) NUNCA entram no pacote.
 * Na nuvem, o pacote é validado; primeiro em simulação (mostra o que vai
 * entrar), depois de verdade. Memórias duplicadas são mescladas.
 */
import { z } from 'zod'
import { q } from './db.mjs'

const AREA_PARA_TIPO = { metas: 'decisao', trabalho: 'fato', projetos: 'projeto', financas: 'fato', aprendizado: 'conhecimento', saude: 'fato', relacoes: 'pessoa', meta: 'fato' }
const DIAS_CRON = { 'dias-uteis': '1-5', diaria: '*' }

const Pacote = z.object({
  formato: z.literal('jarvis-2-pacote'),
  versao: z.literal(1),
  notas: z.array(z.object({ area: z.string(), title: z.string().min(1).max(120), body: z.string().max(4000) })).max(2000).default([]),
  tarefas: z.array(z.object({ texto: z.string().min(1).max(300), prazo: z.number().nullable().optional(), prioridade: z.string().optional(), feita: z.boolean().optional() })).max(2000).default([]),
  rotinas: z.array(z.object({ nome: z.string().min(1).max(80), comando: z.string().min(1).max(400), frequencia: z.string(), horario: z.string().optional(), dias: z.array(z.number()).optional(), intervaloMin: z.number().optional(), ativa: z.boolean().optional() })).max(200).default([]),
  lembretes: z.array(z.object({ quando: z.number(), texto: z.string().max(300) })).max(1000).default([]),
})

export function validarPacote(p) {
  const r = Pacote.safeParse(p)
  if (!r.success) throw new Error(`pacote inválido: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const texto = JSON.stringify(r.data)
  if (/senhaApp|refresh_token|access_token|ical\/[^"]*private|BEGIN PRIVATE KEY/i.test(texto)) throw new Error('o pacote parece conter credenciais; exporte de novo sem elas')
  return r.data
}

export function cronDaRotina(r) {
  const [h, m] = String(r.horario ?? '08:00').split(':').map(Number)
  if (r.frequencia === 'intervalo') {
    const min = Math.max(15, Number(r.intervaloMin) || 60)
    return min < 60 ? `*/${min} * * * *` : `0 */${Math.min(23, Math.round(min / 60))} * * *`
  }
  const dias = r.frequencia === 'semanal' ? (r.dias ?? []).join(',') || '*' : DIAS_CRON[r.frequencia] ?? '*'
  return `${m || 0} ${h || 0} * * ${dias}`
}

export async function importarPacote({ ownerId, pacote, simular = true, memoria, tz = 'America/Sao_Paulo' }) {
  const p = validarPacote(pacote)
  const agora = Date.now()
  const contagem = { memorias: p.notas.length, tarefas: p.tarefas.filter((t) => !t.feita).length, rotinas: p.rotinas.length, lembretes: p.lembretes.filter((l) => l.quando > agora).length }
  if (simular) return { simulado: true, contagem, exemplo: p.notas.slice(0, 5).map((n) => n.title) }
  for (const n of p.notas) await memoria.salvar(ownerId, { tipo: AREA_PARA_TIPO[n.area] ?? 'fato', titulo: n.title, conteudo: n.body || n.title, importancia: 4, origem: 'migracao' })
  for (const t of p.tarefas.filter((x) => !x.feita)) await q(`INSERT INTO tarefas (owner_id, texto, prazo, prioridade) VALUES ($1, $2, $3, $4)`, [ownerId, t.texto, t.prazo ? new Date(t.prazo) : null, t.prioridade === 'alta' ? 'alta' : 'normal'])
  // Rotinas e lembretes entram, mas as rotinas chegam PAUSADAS (você revisa e liga).
  for (const r of p.rotinas) await q(`INSERT INTO rotinas (owner_id, nome, comando, cron, tz, ativa) VALUES ($1, $2, $3, $4, $5, false)`, [ownerId, r.nome, r.comando, cronDaRotina(r), tz])
  const novos = []
  for (const l of p.lembretes.filter((x) => x.quando > agora)) novos.push((await q(`INSERT INTO lembretes (owner_id, texto, quando) VALUES ($1, $2, $3) RETURNING id, quando`, [ownerId, l.texto || 'Lembrete', new Date(l.quando)])).rows[0])
  return { simulado: false, contagem, lembretesCriados: novos }
}
