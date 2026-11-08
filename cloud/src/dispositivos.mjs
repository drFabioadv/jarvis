/**
 * Computadores pareados (agente local).
 *
 * O PC é quem liga para a nuvem (conexão de SAÍDA, por WebSocket seguro):
 * a nuvem nunca acessa a sua rede de casa. O pareamento usa um código de uso
 * único (10 min) gerado no painel; o agente troca o código por um token de
 * dispositivo (só o hash fica no banco) e pode ser revogado a qualquer hora.
 *
 * Funciona entre processos: a API segura as conexões; o worker pede comandos
 * pelo Redis (pub/sub) e recebe a resposta pelo mesmo caminho.
 */
import { randomUUID } from 'node:crypto'
import { q } from './db.mjs'
import { sha256, tokenAleatorio } from './seguranca/cripto.mjs'
import { auditar } from './seguranca/auditoria.mjs'
import { conexaoRedis } from './filas.mjs'

const CANAL_PEDIDO = 'jarvis:pc:pedido'
const canalResposta = (id) => `jarvis:pc:resposta:${id}`
const chaveOnline = (dispId) => `jarvis:pc:online:${dispId}`

/** Comandos que o agente local aceita — e a permissão de cada um. */
export const COMANDOS_PC = { abrir: 'abrir', sistema: 'sistema', listar: 'arquivos_leitura' }

export function criarDispositivos({ redisUrl }) {
  const pub = conexaoRedis(redisUrl)
  let sub = null
  const sockets = new Map() // dispositivoId -> { ws, pendentes }

  async function gerarCodigo(ownerId) {
    const codigo = tokenAleatorio(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase().padEnd(8, 'X')
    await q(`INSERT INTO codigos_pareamento (hash, owner_id, expira) VALUES ($1, $2, now() + interval '10 minutes')`, [sha256(codigo), ownerId])
    return codigo
  }

  async function parear(codigo, nome, ip) {
    const c = (await q(`DELETE FROM codigos_pareamento WHERE hash = $1 AND expira > now() RETURNING owner_id`, [sha256(String(codigo ?? '').toUpperCase())])).rows[0]
    if (!c) throw new Error('código inválido ou expirado')
    const token = tokenAleatorio(32)
    const d = (await q(`INSERT INTO dispositivos (owner_id, nome, token_hash) VALUES ($1, $2, $3) RETURNING id, nome, permissoes`, [c.owner_id, String(nome ?? 'Computador').slice(0, 60), sha256(token)])).rows[0]
    await auditar(c.owner_id, 'dispositivo_pareado', { nome: d.nome }, ip)
    return { token, dispositivo: d }
  }

  async function autenticar(token) {
    if (!token) return null
    const d = (await q(`UPDATE dispositivos SET ultimo_contato = now() WHERE token_hash = $1 AND NOT revogado RETURNING id, owner_id, nome, permissoes`, [sha256(token)])).rows[0]
    return d ?? null
  }

  async function listar(ownerId) {
    const ds = (await q(`SELECT id, nome, permissoes, pareado, ultimo_contato, revogado FROM dispositivos WHERE owner_id = $1 ORDER BY pareado DESC`, [ownerId])).rows
    for (const d of ds) d.online = Boolean(await pub.exists(chaveOnline(d.id)))
    return ds
  }

  async function revogar(ownerId, id) {
    const r = await q(`UPDATE dispositivos SET revogado = true WHERE id = $1 AND owner_id = $2`, [id, ownerId])
    const s = sockets.get(id)
    if (s) s.ws.close(4001, 'revogado')
    await pub.del(chaveOnline(id))
    return r.rowCount > 0
  }

  async function definirPermissoes(ownerId, id, permissoes) {
    const validas = permissoes.filter((p) => Object.values(COMANDOS_PC).includes(p))
    await q(`UPDATE dispositivos SET permissoes = $3 WHERE id = $1 AND owner_id = $2`, [id, ownerId, validas])
    return validas
  }

  async function onlineDe(ownerId) {
    const ds = (await q(`SELECT id, nome, permissoes FROM dispositivos WHERE owner_id = $1 AND NOT revogado`, [ownerId])).rows
    const on = []
    for (const d of ds) if (await pub.exists(chaveOnline(d.id))) on.push(d)
    return on
  }

  /** Executa um comando no PC (de qualquer processo). */
  async function executar(ownerId, dispositivoNome, comando, args, timeoutMs = 20000) {
    if (!COMANDOS_PC[comando]) throw new Error('comando não permitido')
    const on = await onlineDe(ownerId)
    const alvo = dispositivoNome ? on.find((d) => d.nome.toLowerCase() === String(dispositivoNome).toLowerCase()) : on[0]
    if (!alvo) throw new Error('nenhum computador pareado está ligado agora')
    if (!alvo.permissoes.includes(COMANDOS_PC[comando])) throw new Error(`o computador ${alvo.nome} não tem permissão para "${comando}"`)
    const id = randomUUID()
    const ouvinte = conexaoRedis(redisUrl)
    try {
      const resposta = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('o computador não respondeu a tempo')), timeoutMs)
        ouvinte.on('message', (_c, msg) => {
          clearTimeout(t)
          const r = JSON.parse(msg)
          if (r.ok) resolve(r.resultado)
          else reject(new Error(r.erro ?? 'falhou no computador'))
        })
      })
      await ouvinte.subscribe(canalResposta(id))
      await pub.publish(CANAL_PEDIDO, JSON.stringify({ id, dispositivoId: alvo.id, comando, args }))
      const r = await resposta
      await auditar(ownerId, 'pc_comando', { dispositivo: alvo.nome, comando })
      return r
    } finally {
      ouvinte.disconnect()
    }
  }

  /** Só na API: recebe a conexão do agente local. */
  function aceitar(ws, d) {
    const anterior = sockets.get(d.id)
    if (anterior) anterior.ws.close(4000, 'nova conexão')
    sockets.set(d.id, { ws, d })
    const marcar = () => pub.set(chaveOnline(d.id), '1', 'EX', 75)
    void marcar()
    ws.on('message', async (raw) => {
      let m
      try {
        m = JSON.parse(String(raw))
      } catch {
        return
      }
      if (m.tipo === 'pulso') {
        await marcar()
        await q('UPDATE dispositivos SET ultimo_contato = now() WHERE id = $1', [d.id])
      } else if (m.tipo === 'resultado' && typeof m.id === 'string') {
        await pub.publish(canalResposta(m.id), JSON.stringify({ ok: Boolean(m.ok), resultado: m.resultado, erro: m.erro }))
      }
    })
    ws.on('close', async () => {
      if (sockets.get(d.id)?.ws === ws) {
        sockets.delete(d.id)
        await pub.del(chaveOnline(d.id))
      }
    })
  }

  /** Só na API: entrega ao socket certo os pedidos que chegam pelo Redis. */
  async function ouvirPedidos() {
    sub = conexaoRedis(redisUrl)
    sub.on('message', (_c, msg) => {
      const p = JSON.parse(msg)
      const s = sockets.get(p.dispositivoId)
      if (s && s.ws.readyState === 1) s.ws.send(JSON.stringify({ tipo: 'comando', id: p.id, comando: p.comando, args: p.args }))
    })
    await sub.subscribe(CANAL_PEDIDO)
  }

  async function fechar() {
    for (const s of sockets.values()) s.ws.close(1001, 'servidor reiniciando')
    pub.disconnect()
    sub?.disconnect()
  }

  return { gerarCodigo, parear, autenticar, listar, revogar, definirPermissoes, onlineDe, executar, aceitar, ouvirPedidos, fechar }
}
