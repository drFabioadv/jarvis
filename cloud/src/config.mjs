/**
 * Configuração do JARVIS 3.0, lida das variáveis de ambiente e validada.
 * Nada de segredo tem valor padrão: sem a variável, o recurso fica desligado
 * (ou, se for essencial, o serviço não sobe e diz o que falta).
 */
import { readFileSync, existsSync } from 'node:fs'
import { z } from 'zod'

const bool = (padrao) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? padrao : /^(1|true|sim|yes)$/i.test(v)))

const Env = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  /** URL pública (https://jarvis.seudominio.com) — usada em cookies, OAuth, passkeys. */
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  /** 32 bytes em base64 — cifra segredos no banco (TOTP, tokens OAuth). */
  JARVIS_MASTER_KEY: z.string().min(1),
  JARVIS_TZ: z.string().default('America/Sao_Paulo'),
  JARVIS_EXIGIR_MFA: bool(true),
  JARVIS_SESSAO_DIAS: z.coerce.number().default(30),
  JARVIS_SESSAO_INATIVA_DIAS: z.coerce.number().default(7),
  /** Arquivo com provedores e modelos (veja modelos.exemplo.json). */
  JARVIS_MODELOS: z.string().optional(),
  // Atalho para um provedor só, compatível com a API da OpenAI.
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODELO_RAPIDO: z.string().optional(),
  LLM_MODELO_PRINCIPAL: z.string().optional(),
  LLM_MODELO_AVANCADO: z.string().optional(),
  LLM_MODELO_VISAO: z.string().optional(),
  LLM_MODELO_EMBEDDINGS: z.string().optional(),
  LLM_ORCAMENTO_DIARIO_USD: z.coerce.number().default(1),
  SEARXNG_URL: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_CONTATO: z.string().default('mailto:admin@localhost'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  JARVIS_STATIC_DIR: z.string().optional(),
  JARVIS_CONFIAR_PROXY: bool(true),
  LOG_LEVEL: z.string().default('info'),
})

let cache = null

export function carregarConfig(env = process.env) {
  if (cache && env === process.env) return cache
  const r = Env.safeParse(env)
  if (!r.success) {
    const faltam = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Configuração inválida — ${faltam}. Veja cloud/.env.exemplo.`)
  }
  const c = r.data
  const chave = Buffer.from(c.JARVIS_MASTER_KEY, 'base64')
  if (chave.length !== 32) throw new Error('JARVIS_MASTER_KEY precisa ter 32 bytes em base64 (gere com: openssl rand -base64 32).')
  c.chaveMestra = chave
  c.https = c.PUBLIC_URL.startsWith('https://')
  c.rpId = new URL(c.PUBLIC_URL).hostname
  c.modelos = lerModelos(c)
  if (env === process.env) cache = c
  return c
}

/**
 * Provedores e modelos. Pode vir de um arquivo JSON (vários provedores,
 * fallback por nível) ou das variáveis LLM_* (um provedor só).
 */
export function lerModelos(c) {
  if (c.JARVIS_MODELOS && existsSync(c.JARVIS_MODELOS)) {
    const j = JSON.parse(readFileSync(c.JARVIS_MODELOS, 'utf8'))
    return normalizarModelos(j)
  }
  if (!c.LLM_BASE_URL) return normalizarModelos({ provedores: {}, niveis: {} })
  const p = { principal: { baseUrl: c.LLM_BASE_URL, chaveEnv: 'LLM_API_KEY' } }
  const m = (id) => (id ? [{ provedor: 'principal', modelo: id }] : [])
  const principal = c.LLM_MODELO_PRINCIPAL
  return normalizarModelos({
    provedores: p,
    niveis: {
      rapido: m(c.LLM_MODELO_RAPIDO ?? principal),
      principal: m(principal),
      avancado: m(c.LLM_MODELO_AVANCADO ?? principal),
      visao: m(c.LLM_MODELO_VISAO),
      embeddings: m(c.LLM_MODELO_EMBEDDINGS),
    },
    orcamento: { diarioUsd: c.LLM_ORCAMENTO_DIARIO_USD },
  })
}

const Nivel = z.array(z.object({ provedor: z.string(), modelo: z.string(), timeoutMs: z.number().optional() }))
const Modelos = z.object({
  provedores: z.record(z.string(), z.object({ baseUrl: z.string().url(), chaveEnv: z.string().optional(), cabecalhos: z.record(z.string(), z.string()).optional() })),
  niveis: z.object({
    rapido: Nivel.default([]),
    principal: Nivel.default([]),
    avancado: Nivel.default([]),
    visao: Nivel.default([]),
    embeddings: Nivel.default([]),
  }),
  /** Preço por 1 milhão de tokens, em dólar: { "modelo": { "entrada": 0.1, "saida": 0.3 } } */
  precos: z.record(z.string(), z.object({ entrada: z.number(), saida: z.number() })).default({}),
  orcamento: z.object({ diarioUsd: z.number().default(1), maxTokensResposta: z.number().default(1200), maxTokensTarefa: z.number().default(40000) }).default({}),
})

export function normalizarModelos(j) {
  const r = Modelos.safeParse(j)
  if (!r.success) throw new Error(`Arquivo de modelos inválido: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  for (const [nivel, lista] of Object.entries(r.data.niveis))
    for (const e of lista) if (!r.data.provedores[e.provedor]) throw new Error(`Nível ${nivel} usa o provedor "${e.provedor}", que não está em "provedores".`)
  return r.data
}
