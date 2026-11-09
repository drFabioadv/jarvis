#!/usr/bin/env node
/**
 * J.A.R.V.I.S. — MODO PC: a plataforma 3.0 inteira no seu computador, de graça.
 *
 *   node cloud/src/pc.mjs
 *
 * Um processo só: API + interface (PWA) + agentes + memória + fila + agendador.
 *   - Banco: PostgreSQL embutido (PGlite) num arquivo — nada para instalar.
 *   - Fila/agendador: no próprio processo, guardados no banco.
 *   - Cérebro: modelo aberto no Ollama, na sua placa de vídeo.
 *   - Celular: pelo Tailscale (grátis), enquanto o PC estiver ligado.
 * Sem Anthropic, sem servidor, sem provedor pago.
 *
 * Na primeira vez cria, em %LOCALAPPDATA%\JARVIS\pc (ou ~/.jarvis-pc):
 *   config.json   chave mestra, chaves de notificação, token interno, porta
 *   modelos.json  o modelo do Ollama de cada nível (edite à vontade)
 *   banco/        o banco de dados
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const PASTA_PC = process.env.JARVIS_DADOS || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'JARVIS', 'pc') : join(homedir(), '.jarvis-pc'))

/** O modelo de cada nível. 14B cabe inteiro numa placa de 16 GB junto com o de embeddings. */
export const MODELOS_PADRAO = {
  _leia: 'Modelos do Ollama no seu PC. Troque à vontade (ollama pull NOME e mude aqui). Um modelo só para conversa evita ficar trocando na placa de vídeo.',
  provedores: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1' } },
  niveis: {
    rapido: [{ provedor: 'ollama', modelo: 'qwen2.5:14b', timeoutMs: 120000 }],
    principal: [{ provedor: 'ollama', modelo: 'qwen2.5:14b', timeoutMs: 180000 }],
    avancado: [{ provedor: 'ollama', modelo: 'qwen2.5:14b', timeoutMs: 240000 }],
    visao: [],
    embeddings: [{ provedor: 'ollama', modelo: 'bge-m3', timeoutMs: 60000 }],
  },
  precos: {},
  orcamento: { diarioUsd: 0, maxTokensResposta: 1200, maxTokensTarefa: 60000 },
}

/** Lê (ou cria na primeira vez) a configuração do modo PC. */
export async function configPc(pasta = PASTA_PC) {
  mkdirSync(pasta, { recursive: true })
  const arq = join(pasta, 'config.json')
  let c = existsSync(arq) ? JSON.parse(readFileSync(arq, 'utf8')) : {}
  let mudou = false
  const garantir = (k, gerar) => {
    if (!c[k]) {
      c[k] = gerar()
      mudou = true
    }
  }
  garantir('chaveMestra', () => randomBytes(32).toString('base64'))
  garantir('tokenInterno', () => randomBytes(24).toString('base64url'))
  garantir('porta', () => 8090)
  garantir('fuso', () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo')
  if (!c.vapid) {
    const webpush = await import('web-push')
    c.vapid = webpush.generateVAPIDKeys()
    mudou = true
  }
  if (mudou) writeFileSync(arq, JSON.stringify(c, null, 2), { mode: 0o600 })
  const modelos = join(pasta, 'modelos.json')
  if (!existsSync(modelos)) writeFileSync(modelos, JSON.stringify(MODELOS_PADRAO, null, 2))
  return { ...c, pasta, arquivoModelos: modelos }
}

/** Monta o ambiente do modo PC (sem sobrescrever o que você definir à mão). */
export function ambientePc(c) {
  const local = `http://localhost:${c.porta}`
  const publico = c.enderecoTailscale || local
  const extras = [local, `http://127.0.0.1:${c.porta}`, c.enderecoTailscale].filter((x) => x && x !== publico)
  const raiz = fileURLToPath(new URL('../..', import.meta.url))
  return {
    NODE_ENV: 'production',
    PORT: String(c.porta),
    HOST: '127.0.0.1', // só o próprio PC; o celular chega pelo Tailscale
    PUBLIC_URL: publico,
    JARVIS_ORIGENS_EXTRAS: extras.join(','),
    DATABASE_URL: `pglite:${join(c.pasta, 'banco')}`,
    REDIS_URL: 'memoria',
    JARVIS_MASTER_KEY: c.chaveMestra,
    JARVIS_TZ: c.fuso,
    JARVIS_MODELOS: c.arquivoModelos,
    JARVIS_TOKEN_INTERNO: c.tokenInterno,
    JARVIS_STATIC_DIR: join(raiz, 'dist-cloud'),
    JARVIS_MODELOS_DIR: join(c.pasta, 'modelos-voz'),
    JARVIS_STT_NUVEM: '1',
    JARVIS_CONFIAR_PROXY: '0',
    VAPID_PUBLIC_KEY: c.vapid.publicKey,
    VAPID_PRIVATE_KEY: c.vapid.privateKey,
    VAPID_CONTATO: 'mailto:jarvis@localhost',
    LOG_LEVEL: 'warn',
  }
}

async function ollamaPronto(baseUrl, modelos) {
  try {
    const r = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) })
    const nomes = (await r.json()).models?.map((m) => m.name) ?? []
    const faltam = modelos.filter((m) => !nomes.some((n) => n === m || n === `${m}:latest`))
    return { ok: true, faltam }
  } catch {
    return { ok: false, faltam: modelos }
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('pc.mjs')) {
  const c = await configPc()
  const env = ambientePc(c)
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v
  const { carregarConfig } = await import('./config.mjs')
  const { montarServicos } = await import('./servicos.mjs')
  const { criarApp } = await import('./server.mjs')
  const { iniciarWorker } = await import('./worker.mjs')
  const { existeProprietario, gerarCodigoSetup } = await import('./auth.mjs')
  const cfg = carregarConfig()
  const servicos = montarServicos({ cfg })
  const app = await criarApp({ servicos })
  const worker = await iniciarWorker({ servicos, migrar: false })
  await app.listen({ port: cfg.PORT, host: cfg.HOST })

  const nomes = [...new Set(Object.values(cfg.modelos.niveis).flat().map((m) => m.modelo))]
  const o = await ollamaPronto(cfg.modelos.provedores.ollama?.baseUrl ?? 'http://127.0.0.1:11434/v1', nomes)
  console.log(`\n⚡ J.A.R.V.I.S. no PC — ${cfg.PUBLIC_URL}${c.enderecoTailscale ? `  (no PC também: http://localhost:${c.porta})` : ''}`)
  if (!o.ok) console.log('   ⚠ O Ollama não está rodando. Abra o Ollama (ou rode INSTALAR-JARVIS-PC.bat).')
  else if (o.faltam.length) console.log(`   ⚠ Faltam modelos no Ollama: ${o.faltam.join(', ')} — rode: ollama pull ${o.faltam.join(' && ollama pull ')}`)
  if (!(await existeProprietario())) {
    const codigo = await gerarCodigoSetup()
    writeFileSync(join(c.pasta, 'codigo-de-cadastro.txt'), `${codigo}\n(vale 1 hora; abra ${cfg.PUBLIC_URL} e crie a sua conta)\n`)
    console.log(`   Primeira vez: abra ${cfg.PUBLIC_URL} e use o código ${codigo} para criar a sua conta.`)
  }
  for (const sinal of ['SIGTERM', 'SIGINT'])
    process.on(sinal, async () => {
      await worker.parar()
      await app.close()
      process.exit(0)
    })
}
