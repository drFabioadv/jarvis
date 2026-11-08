/**
 * O Segundo Cérebro (grafo) no modo nuvem: as notas vêm da memória no
 * PostgreSQL (/api/memorias) e as edições voltam para lá.
 */
import { useCerebro, type Nota } from '../cerebro'
import { api } from './cloud'

type Mem = { id: string; tipo: string; titulo: string; conteudo: string }
// Tipos da memória da nuvem ↔ áreas do grafo.
const AREA: Record<string, string> = { fato: 'meta', preferencia: 'meta', projeto: 'projetos', conhecimento: 'aprendizado', decisao: 'metas', pessoa: 'relacoes', temporario: 'meta' }
const TIPO: Record<string, string> = { meta: 'fato', metas: 'decisao', trabalho: 'fato', projetos: 'projeto', financas: 'fato', aprendizado: 'conhecimento', saude: 'fato', relacoes: 'pessoa' }

async function recarregar(flash: string | null = null) {
  const [mems, rel] = await Promise.all([api<Mem[]>('/api/memorias'), api<{ a: string; b: string }[]>('/api/memorias/relacoes')])
  const notas: Nota[] = mems.map((m) => ({ id: m.id, area: AREA[m.tipo] ?? 'meta', title: m.titulo, body: m.conteudo }))
  useCerebro.getState().set({ notas, rel: rel.map((r) => [r.a, r.b] as [string, string]), flash })
}

export async function enviar(msg: Record<string, unknown>) {
  try {
    if (msg.type === 'cerebro') return await recarregar()
    if (msg.type === 'nota') {
      const n = msg.nota as Partial<Nota>
      const corpo = { tipo: TIPO[n.area ?? 'meta'] ?? 'fato', titulo: n.title, conteudo: n.body || n.title }
      const r = n.id ? await api<{ id: string }>(`/api/memorias/${n.id}`, { method: 'PATCH', body: corpo }) : (await api<{ memoria: { id: string } }>('/api/memorias', { method: 'POST', body: corpo })).memoria
      return await recarregar(r.id)
    }
    if (msg.type === 'nota-excluir') {
      await api(`/api/memorias/${msg.id}`, { method: 'DELETE' })
      return await recarregar()
    }
  } catch (err) {
    console.warn('[cérebro] nuvem:', err)
  }
}
