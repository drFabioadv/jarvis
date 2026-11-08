#!/usr/bin/env node
/**
 * Agente local do JARVIS 3.0 — opcional, só para quando o PC está ligado.
 *
 *   node jarvis-agente.mjs parear https://jarvis.seudominio.com CODIGO [nome]
 *   node jarvis-agente.mjs            (conecta e fica esperando comandos)
 *
 * O agente LIGA para a nuvem (WebSocket seguro de saída): nada no seu PC fica
 * exposto à internet e a nuvem não precisa enxergar a sua rede. Ele só aceita
 * os comandos da lista abaixo, valida cada argumento e grava um log local.
 * Não existe "rodar comando qualquer": não há shell remoto.
 *
 * Config (token do dispositivo) em %APPDATA%\JARVIS-agente\config.json
 * (Windows) ou ~/.config/jarvis-agente/config.json.
 */
import { WebSocket } from 'ws'
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname, platform, cpus, totalmem, freemem, uptime } from 'node:os'
import { join, resolve, sep } from 'node:path'

const WIN = platform() === 'win32'
const PASTA = WIN ? join(process.env.APPDATA ?? homedir(), 'JARVIS-agente') : join(homedir(), '.config', 'jarvis-agente')
const CFG = join(PASTA, 'config.json')
const LOG = join(PASTA, 'agente.log')
mkdirSync(PASTA, { recursive: true })

const log = (msg) => {
  const linha = `${new Date().toISOString()} ${msg}`
  console.log(linha)
  try {
    appendFileSync(LOG, `${linha}\n`)
  } catch {}
}
const lerCfg = () => (existsSync(CFG) ? JSON.parse(readFileSync(CFG, 'utf8')) : null)

/** Pastas que o JARVIS pode listar (só leitura de nomes). Edite no config.json. */
const PASTAS_PADRAO = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'Área de Trabalho', 'Documentos', 'Imagens'].map((p) => join(homedir(), p)).filter((p) => existsSync(p))

function dentroDe(caminho, raizes) {
  const r = resolve(caminho)
  return raizes.some((raiz) => r === resolve(raiz) || r.startsWith(resolve(raiz) + sep))
}

function rodar(cmd, args) {
  return new Promise((res, rej) => execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, out) => (err ? rej(err) : res(String(out)))))
}
function abrirNoSistema(alvo) {
  const [cmd, args] = WIN ? ['explorer.exe', [alvo]] : platform() === 'darwin' ? ['open', [alvo]] : ['xdg-open', [alvo]]
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}
const ps = (script) => rodar('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script])

/** A lista de comandos aceitos. Cada um valida tudo o que recebe. */
export const COMANDOS = {
  async abrir({ tipo, alvo }, cfg) {
    if (tipo === 'url') {
      const u = new URL(String(alvo))
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('só links http/https')
      abrirNoSistema(u.toString())
      return { abriu: u.toString() }
    }
    if (tipo === 'pasta') {
      const caminho = resolve(String(alvo).replace(/^~(?=$|[\\/])/, homedir()))
      if (!dentroDe(caminho, cfg.pastas ?? PASTAS_PADRAO)) throw new Error('pasta fora das liberadas no agente')
      if (!existsSync(caminho) || !statSync(caminho).isDirectory()) throw new Error('pasta não encontrada')
      abrirNoSistema(caminho)
      return { abriu: caminho }
    }
    if (tipo === 'programa') {
      if (!WIN) throw new Error('abrir programas pelo nome só no Windows')
      const nome = String(alvo).replace(/[^\p{L}\p{N} .+\-_]/gu, '').slice(0, 80)
      if (!nome) throw new Error('nome de programa inválido')
      // Procura no menu Iniciar (Get-StartApps) e abre pelo AppID — nada de caminho arbitrário.
      const lista = JSON.parse((await ps('Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress')) || '[]')
      const n = nome.toLowerCase()
      const achado = lista.find((a) => a.Name.toLowerCase() === n) ?? lista.find((a) => a.Name.toLowerCase().includes(n))
      if (!achado) throw new Error(`não achei "${nome}" no menu Iniciar`)
      abrirNoSistema(`shell:AppsFolder\\${achado.AppID}`)
      return { abriu: achado.Name }
    }
    throw new Error('tipo inválido')
  },
  async sistema({ acao, valor }) {
    if (acao === 'info') return { computador: hostname(), sistema: platform(), processadores: cpus().length, memoriaGB: +(totalmem() / 1e9).toFixed(1), livreGB: +(freemem() / 1e9).toFixed(1), ligadoHoras: +(uptime() / 3600).toFixed(1) }
    if (!WIN) throw new Error('só no Windows')
    if (acao === 'bloquear') {
      await rodar('rundll32.exe', ['user32.dll,LockWorkStation'])
      return { ok: true }
    }
    if (acao === 'mudo') {
      await ps('(New-Object -ComObject WScript.Shell).SendKeys([char]173)')
      return { ok: true }
    }
    if (acao === 'volume') {
      const v = Math.max(0, Math.min(100, Number(valor)))
      if (Number.isNaN(v)) throw new Error('volume inválido')
      // 50 toques para zerar e depois sobe de 2 em 2 (teclas de volume do Windows).
      await ps(`$w=New-Object -ComObject WScript.Shell; 1..50|%{$w.SendKeys([char]174)}; 1..${Math.round(v / 2)}|%{$w.SendKeys([char]175)}`)
      return { volume: v }
    }
    throw new Error('ação inválida')
  },
  async listar({ pasta, busca }, cfg) {
    const raizes = cfg.pastas ?? PASTAS_PADRAO
    const caminho = resolve(String(pasta).replace(/^~(?=$|[\\/])/, homedir()))
    const alvo = existsSync(caminho) ? caminho : raizes.find((r) => r.toLowerCase().endsWith(String(pasta).toLowerCase()))
    if (!alvo || !dentroDe(alvo, raizes)) throw new Error('pasta fora das liberadas no agente')
    const termo = String(busca ?? '').toLowerCase()
    const itens = readdirSync(alvo, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.') && (!termo || d.name.toLowerCase().includes(termo)))
      .slice(0, 100)
      .map((d) => ({ nome: d.name, pasta: d.isDirectory() }))
    return { pasta: alvo, itens }
  },
}

async function parear(url, codigo, nome = hostname()) {
  const base = new URL(url)
  if (base.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(base.hostname)) throw new Error('use https:// (só localhost pode ser http)')
  const r = await fetch(new URL('/api/dispositivos/parear', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codigo, nome }) })
  const j = await r.json()
  if (!r.ok) throw new Error(j.erro ?? `falhou (${r.status})`)
  writeFileSync(CFG, JSON.stringify({ url: base.origin, token: j.token, nome: j.dispositivo.nome, pastas: PASTAS_PADRAO }, null, 2), { mode: 0o600 })
  log(`pareado como "${j.dispositivo.nome}" em ${base.origin}`)
}

function conectar(cfg) {
  const wsUrl = cfg.url.replace(/^http/, 'ws') + '/api/agente'
  let espera = 2000
  let pulso = null
  const abrir = () => {
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${cfg.token}` } })
    ws.on('open', () => {
      espera = 2000
      log('conectado à nuvem')
      pulso = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ tipo: 'pulso' })), 30000)
    })
    ws.on('message', async (raw) => {
      let m
      try {
        m = JSON.parse(String(raw))
      } catch {
        return
      }
      if (m.tipo !== 'comando') return
      const fn = Object.hasOwn(COMANDOS, m.comando) ? COMANDOS[m.comando] : null
      try {
        if (!fn) throw new Error('comando não permitido neste computador')
        const resultado = await fn(m.args ?? {}, cfg)
        log(`ok ${m.comando} ${JSON.stringify(m.args).slice(0, 120)}`)
        ws.send(JSON.stringify({ tipo: 'resultado', id: m.id, ok: true, resultado }))
      } catch (err) {
        log(`recusado ${m.comando}: ${err.message}`)
        ws.send(JSON.stringify({ tipo: 'resultado', id: m.id, ok: false, erro: err.message }))
      }
    })
    ws.on('close', (codigo) => {
      clearInterval(pulso)
      if (codigo === 4001 || codigo === 4003) {
        log('este computador foi desconectado do JARVIS (token revogado). Pareie de novo se quiser.')
        process.exit(1)
      }
      log(`conexão caiu (${codigo}); tentando de novo em ${espera / 1000}s`)
      setTimeout(abrir, espera)
      espera = Math.min(espera * 2, 60000)
    })
    ws.on('error', (err) => log(`erro: ${err.message}`))
  }
  abrir()
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('jarvis-agente.mjs')) {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'parear') {
    if (args.length < 2) {
      console.log('uso: node jarvis-agente.mjs parear https://jarvis.seudominio.com CODIGO [nome-do-pc]')
      process.exit(1)
    }
    parear(args[0], args[1], args[2]).catch((e) => {
      console.error(`Não consegui parear: ${e.message}`)
      process.exit(1)
    })
  } else {
    const cfg = lerCfg()
    if (!cfg) {
      console.log('Este computador ainda não está pareado. No JARVIS: Configurações → Computadores → Gerar código; depois:\n  node jarvis-agente.mjs parear https://seu-jarvis CODIGO')
      process.exit(1)
    }
    conectar(cfg)
  }
}
