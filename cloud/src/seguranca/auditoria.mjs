/** Registro de auditoria: quem fez o quê, quando e de onde. Nunca grava segredos. */
import { q } from '../db.mjs'

const SEGREDO = /(senha|password|token|secret|segredo|codigo|code|cookie|authorization|chave|key)/i

function limpar(obj, prof = 0) {
  if (prof > 3 || obj == null) return obj
  if (Array.isArray(obj)) return obj.slice(0, 20).map((x) => limpar(x, prof + 1))
  if (typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, SEGREDO.test(k) ? '[omitido]' : limpar(v, prof + 1)]))
  if (typeof obj === 'string') return obj.slice(0, 300)
  return obj
}

export async function auditar(ownerId, acao, detalhes = {}, ip = '') {
  try {
    await q('INSERT INTO auditoria (owner_id, acao, detalhes, ip) VALUES ($1, $2, $3, $4)', [ownerId ?? null, acao, limpar(detalhes), String(ip).slice(0, 64)])
  } catch (err) {
    console.error('[auditoria] falhou:', err.message)
  }
}
export { limpar as limparSegredos }
