/**
 * JARVIS em modo app — o que a bandeja do Windows (JARVIS-bandeja.ps1) roda
 * escondido, sem janela preta.
 *
 * Diferente do `npm start`, que sobe o servidor de desenvolvimento, este serve
 * a versão já compilada (dist/), que é bem mais leve para ficar ligada o dia
 * todo. Se o código-fonte mudou depois da última compilação, compila de novo.
 *
 * Os dois processos (cérebro e interface) são reiniciados sozinhos se caírem.
 * A saída vai para logs/jarvis.log, para dar para investigar um problema.
 *
 *   node scripts/app.mjs            modo normal (só pesquisa e responde)
 *   node scripts/app.mjs --writes   modo ação
 */

import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

export const FACE_PORT = 4173

// ---------------------------------------------------------------- log
mkdirSync('logs', { recursive: true })
const LOG = join('logs', 'jarvis.log')
try {
  // Mantém o log pequeno: guarda só a execução anterior.
  if (existsSync(LOG) && statSync(LOG).size > 2 * 1024 * 1024) {
    renameSync(LOG, join('logs', 'jarvis-anterior.log'))
  }
} catch {
  /* sem problema */
}
const out = createWriteStream(LOG, { flags: 'a' })
const log = (tag, text) => {
  const stamp = new Date().toLocaleString('pt-BR')
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim()) out.write(`${stamp} [${tag}] ${line}\n`)
  }
}

// ---------------------------------------------------------------- preparo
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
  } catch (err) {
    log('app', `não copiou o runtime de gestos: ${err.message}`)
  }
}

/** Data de modificação mais recente de qualquer arquivo dentro de `dir`. */
function newest(dir) {
  let max = 0
  if (!existsSync(dir)) return 0
  const st = statSync(dir)
  if (!st.isDirectory()) return st.mtimeMs
  for (const name of readdirSync(dir)) {
    if (name === 'mediapipe') continue
    max = Math.max(max, newest(join(dir, name)))
  }
  return max
}

function buildIfNeeded() {
  const built = existsSync('dist/index.html') ? statSync('dist/index.html').mtimeMs : 0
  const source = Math.max(newest('src'), newest('index.html'), newest('public'))
  if (built && built >= source) return
  log('app', 'compilando a interface...')
  const vite = join('node_modules', 'vite', 'bin', 'vite.js')
  const r = spawnSync(process.execPath, [vite, 'build'], { encoding: 'utf8' })
  log('build', r.stdout ?? '')
  if (r.status !== 0) log('build', r.stderr ?? 'falhou')
}

/** Chave e voz da ElevenLabs, se o usuário colocou nos arquivos .txt. */
function firstLine(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/)[0].trim()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- processos
const writes = process.argv.includes('--writes')
const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
if (writes) env.JARVIS_ALLOW_WRITES = '1'
const key = firstLine('elevenlabs.txt')
if (key) env.ELEVENLABS_API_KEY = key
const voiceId = firstLine('elevenlabs-voz.txt')
if (voiceId) env.JARVIS_VOICE_ID = voiceId

// Economia do Claude: o que o cérebro local não resolve vai para o modelo mais
// leve e rápido, com poucas etapas e sem a câmera (menos texto por pedido).
// Dá para trocar em jarvis-config.json: "modeloClaude": "sonnet" ou "opus".
let userCfg = {}
try {
  userCfg = JSON.parse(readFileSync('jarvis-config.json', 'utf8'))
} catch {
  /* sem config: usa o padrão */
}
env.JARVIS_MODEL ??= userCfg.modeloClaude || 'haiku'
env.JARVIS_EFFORT ??= userCfg.esforcoClaude || 'low'
env.JARVIS_MAX_TURNS ??= String(userCfg.etapasMaximas || 8)
// O controle do Chrome pedia autorizações confusas; abrir sites e programas
// é feito direto pelo Windows (explorer.exe). Para religar: "desligar": "camera".
env.JARVIS_DISABLE ??= userCfg.desligar ?? 'camera,browser'

// Senha do atalho do iPhone: criada uma vez e guardada em atalho-token.txt.
let token = firstLine('atalho-token.txt')
if (!token) {
  token = randomBytes(18).toString('base64url')
  writeFileSync('atalho-token.txt', `${token}\n`)
}
env.JARVIS_ATALHO_TOKEN = token

// As pastas do usuário onde o JARVIS pode procurar arquivos ("procura nos meus
// arquivos a pasta tal"). Pastas de senhas e credenciais continuam bloqueadas.
const home = homedir()
const pastas = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive']
  .map((p) => join(home, p))
  .filter((p) => existsSync(p))
if (pastas.length && !env.JARVIS_FILE_ROOTS) env.JARVIS_FILE_ROOTS = pastas.join(',')

const children = new Set()
let stopping = false

function keep(name, args) {
  const start = () => {
    if (stopping) return
    const child = spawn(process.execPath, args, { env, windowsHide: true })
    children.add(child)
    child.stdout.on('data', (d) => log(name, d))
    child.stderr.on('data', (d) => log(name, d))
    child.on('exit', (code) => {
      children.delete(child)
      if (stopping) return
      log(name, `encerrou (código ${code}); reiniciando em 3 segundos`)
      setTimeout(start, 3000)
    })
  }
  start()
}

function shutdown() {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill()
    } catch {
      /* já foi */
    }
  }
  setTimeout(() => process.exit(0), 400)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Quando a bandeja fecha, a entrada padrão fecha junto: é o sinal para sair.
process.stdin.on('end', shutdown)
process.stdin.on('error', shutdown)
process.stdin.resume()

log('app', `iniciando${writes ? ' (modo ação)' : ''}`)
vendorWasm()
buildIfNeeded()
keep('cerebro', ['bridge/server.mjs'])
keep('interface', [
  join('node_modules', 'vite', 'bin', 'vite.js'),
  'preview',
  '--port',
  String(FACE_PORT),
  '--strictPort',
  '--host',
  '127.0.0.1',
])
