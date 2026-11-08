/**
 * Notificações Web Push (padrão VAPID): chegam no celular e no computador
 * mesmo com o JARVIS fechado. Gere as chaves com: npx web-push generate-vapid-keys
 */
import * as webpush from 'web-push'
import { q } from './db.mjs'

export function criarPush(cfg) {
  const ativo = Boolean(cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY)
  if (ativo) webpush.setVapidDetails(cfg.VAPID_CONTATO, cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY)

  async function inscrever(ownerId, inscricao, dispositivo = '') {
    if (!inscricao?.endpoint || !/^https:\/\//.test(inscricao.endpoint) || !inscricao.keys?.p256dh || !inscricao.keys?.auth) throw new Error('inscrição inválida')
    await q(`INSERT INTO push_inscricoes (owner_id, endpoint, chaves, dispositivo) VALUES ($1, $2, $3, $4) ON CONFLICT (endpoint) DO UPDATE SET owner_id = EXCLUDED.owner_id, chaves = EXCLUDED.chaves`, [ownerId, inscricao.endpoint, inscricao.keys, String(dispositivo).slice(0, 120)])
  }

  async function cancelar(ownerId, endpoint) {
    await q('DELETE FROM push_inscricoes WHERE owner_id = $1 AND endpoint = $2', [ownerId, endpoint])
  }

  /** Manda para todos os aparelhos do proprietário. Remove inscrições mortas. */
  async function enviar(ownerId, { titulo, corpo, url = '/', tag }) {
    if (!ativo) return { enviados: 0, motivo: 'push não configurado (VAPID)' }
    const subs = (await q('SELECT id, endpoint, chaves FROM push_inscricoes WHERE owner_id = $1', [ownerId])).rows
    let enviados = 0
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.chaves }, JSON.stringify({ titulo, corpo: String(corpo ?? '').slice(0, 500), url, tag }), { TTL: 3600, urgency: 'high' })
        enviados++
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await q('DELETE FROM push_inscricoes WHERE id = $1', [s.id])
        else console.warn('[push] falhou:', err.statusCode ?? err.message)
      }
    }
    return { enviados }
  }

  return { ativo, chavePublica: cfg.VAPID_PUBLIC_KEY ?? null, inscrever, cancelar, enviar }
}
