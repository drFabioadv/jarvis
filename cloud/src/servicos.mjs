/** Monta os serviços compartilhados entre a API e o worker. */
import { carregarConfig } from './config.mjs'
import { abrirBanco, q } from './db.mjs'
import { criarGateway } from './llm/gateway.mjs'
import { criarMemoria } from './memoria.mjs'
import { criarFerramentas } from './ferramentas/registro.mjs'
import { criarOrquestrador } from './agentes/orquestrador.mjs'
import { criarFilas } from './filas.mjs'
import { criarPush } from './push.mjs'
import { criarDispositivos } from './dispositivos.mjs'
import { criarGoogle } from './integracoes/google.mjs'

export async function prefsDe(ownerId) {
  const o = (await q('SELECT nome FROM owners WHERE id = $1', [ownerId])).rows[0]
  const c = (await q('SELECT dados FROM config_owner WHERE owner_id = $1', [ownerId])).rows[0]?.dados ?? {}
  return { nome: o?.nome ?? '', tratamento: c.tratamento ?? 'senhor', cidade: c.cidade ?? '', tz: c.tz ?? null, temas: c.temas ?? [] }
}

export function montarServicos({ cfg = carregarConfig(), fetch: f } = {}) {
  abrirBanco(cfg.DATABASE_URL)
  const gateway = criarGateway({
    modelos: cfg.modelos,
    fetch: f,
    registrar: async (u) => {
      await q(`INSERT INTO uso_modelos (owner_id, provedor, modelo, nivel, tokens_entrada, tokens_saida, custo_usd, latencia_ms, ok, erro) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [u.ownerId ?? null, u.provedor, u.modelo, u.nivel, u.tokensEntrada, u.tokensSaida, u.custoUsd, u.latenciaMs, u.ok, u.erro ?? null]).catch(() => {})
    },
    gastoHoje: async () => Number((await q(`SELECT coalesce(sum(custo_usd), 0) AS s FROM uso_modelos WHERE em > date_trunc('day', now())`)).rows[0].s),
  })
  const memoria = criarMemoria({ gateway })
  const ferramentas = criarFerramentas()
  const filas = criarFilas(cfg.REDIS_URL)
  const push = criarPush(cfg)
  const dispositivos = criarDispositivos({ redisUrl: cfg.REDIS_URL })
  const google = criarGoogle({ cfg })

  async function ctxFerramentas(ownerId) {
    const prefs = await prefsDe(ownerId)
    const [googleConectado, online] = await Promise.all([google.configurado ? google.conectado(ownerId) : false, dispositivos.onlineDe(ownerId).catch(() => [])])
    return {
      ownerId,
      cfg,
      prefs,
      tz: prefs.tz || cfg.JARVIS_TZ,
      memoria,
      google,
      googleConectado,
      pcOnline: online.length > 0,
      pc: dispositivos,
      agendar: { lembrete: filas.lembrete, cancelarLembrete: filas.cancelarLembrete, rotina: filas.rotina },
    }
  }

  const orquestrador = criarOrquestrador({ gateway, memoria, ferramentas, ctxFerramentas })
  return { cfg, gateway, memoria, ferramentas, filas, push, dispositivos, google, orquestrador, ctxFerramentas }
}
