/**
 * Atualizador do JARVIS — baixa a versão mais nova do GitHub e aplica por cima.
 *
 *   node scripts/update.mjs --check   diz se há atualização (não muda nada)
 *   node scripts/update.mjs --apply   baixa e instala a atualização
 *
 * O que NÃO é tocado: node_modules, logs, a sua configuração
 * (jarvis-config.json) e as chaves (elevenlabs*.txt). Se a lista de pacotes
 * mudou, roda o `npm install` sozinho. A interface é recompilada na próxima
 * vez que o JARVIS ligar.
 *
 * Saída: uma linha JSON. Código 0 = ok, 1 = erro.
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = (() => {
  try {
    return readFileSync(join(ROOT, 'atualizacao.txt'), 'utf8').split(/\r?\n/)[0].trim()
  } catch {
    return ''
  }
})() || 'drFabioadv/jarvis'
const BRANCH = 'main'
const VERSION_FILE = join(ROOT, 'versao.txt')
const KEEP = new Set(['node_modules', 'logs', 'dist', '.git', 'jarvis-config.json', 'elevenlabs.txt', 'elevenlabs-voz.txt', 'versao.txt', 'atualizacao.txt', 'atalho-token.txt', 'indice-computador.json', 'lembretes.json', 'segundo-cerebro.json', 'integracoes.json', 'triagem-emails.json', 'digest-ultimo.txt', 'tarefas.json', 'rotinas.json', 'historico.json', 'dist-cloud'])

mkdirSync(join(ROOT, 'logs'), { recursive: true })
const log = (m) => {
  try {
    appendFileSync(join(ROOT, 'logs', 'atualizacao.log'), `${new Date().toLocaleString('pt-BR')} ${m}\n`)
  } catch {
    /* sem log */
  }
}
const out = (o, code = 0) => {
  console.log(JSON.stringify(o))
  process.exit(code)
}

const local = () => {
  try {
    return readFileSync(VERSION_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

async function remote() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'jarvis-atualizador' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`)
  const j = await res.json()
  return { sha: j.sha, message: String(j.commit?.message ?? '').split('\n')[0], date: j.commit?.committer?.date }
}

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = relative(base, full)
    if (KEEP.has(rel.split(/[\\/]/)[0])) continue
    if (statSync(full).isDirectory()) walk(full, base, acc)
    else acc.push(rel)
  }
  return acc
}

async function apply() {
  const r = await remote()
  if (r.sha === local()) return out({ ok: true, updated: false, sha: r.sha })
  log(`atualizando para ${r.sha.slice(0, 7)} — ${r.message}`)

  const tmp = mkdtempSync(join(tmpdir(), 'jarvis-up-'))
  const zip = join(tmp, 'jarvis.zip')
  const res = await fetch(`https://codeload.github.com/${REPO}/zip/${r.sha}`, {
    headers: { 'user-agent': 'jarvis-atualizador' },
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(`download falhou (${res.status})`)
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()))

  // O Windows 10/11 já traz o tar, que abre .zip.
  const x = spawnSync('tar', ['-xf', zip, '-C', tmp], { encoding: 'utf8' })
  if (x.status !== 0) throw new Error(`não consegui extrair: ${x.stderr || x.error}`)
  const top = readdirSync(tmp).find((n) => n !== 'jarvis.zip' && statSync(join(tmp, n)).isDirectory())
  if (!top) throw new Error('pacote vazio')
  const src = join(tmp, top)

  const oldLock = existsSync(join(ROOT, 'package-lock.json')) ? readFileSync(join(ROOT, 'package-lock.json'), 'utf8') : ''
  const files = walk(src)
  for (const rel of files) {
    const to = join(ROOT, rel)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(join(src, rel), to)
  }
  // Configuração nova só se ainda não existir a sua.
  if (!existsSync(join(ROOT, 'jarvis-config.json')) && existsSync(join(src, 'jarvis-config.json'))) {
    cpSync(join(src, 'jarvis-config.json'), join(ROOT, 'jarvis-config.json'))
  }
  const newLock = existsSync(join(ROOT, 'package-lock.json')) ? readFileSync(join(ROOT, 'package-lock.json'), 'utf8') : ''
  if (newLock !== oldLock) {
    log('lista de pacotes mudou: npm install')
    const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    if (npm.status !== 0) log(`npm install falhou: ${npm.stderr?.slice(-400)}`)
  }
  // Força a recompilação da interface na próxima partida.
  // Cérebro do PC (cloud/): se instalado, atualiza os pacotes dele e a interface.
  if (existsSync(join(ROOT, 'cloud', 'node_modules'))) {
    log('atualizando o cérebro do PC')
    const n2 = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: join(ROOT, 'cloud'), encoding: 'utf8', shell: process.platform === 'win32' })
    if (n2.status !== 0) log(`npm install (cloud) falhou: ${n2.stderr?.slice(-400)}`)
    const vb = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', 'cloud'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
    if (vb.status !== 0) log(`build da interface do PC falhou: ${vb.stderr?.slice(-400)}`)
  }
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true })
  writeFileSync(VERSION_FILE, r.sha)
  rmSync(tmp, { recursive: true, force: true })
  log(`atualizado: ${files.length} arquivos`)
  out({ ok: true, updated: true, sha: r.sha, message: r.message, files: files.length })
}

const mode = process.argv.includes('--apply') ? 'apply' : 'check'
try {
  if (mode === 'check') {
    const r = await remote()
    out({ ok: true, update: r.sha !== local(), sha: r.sha, local: local(), message: r.message })
  } else {
    await apply()
  }
} catch (err) {
  log(`erro: ${err?.message ?? err}`)
  out({ ok: false, error: String(err?.message ?? err) }, 1)
}
