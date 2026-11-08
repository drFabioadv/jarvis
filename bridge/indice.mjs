/**
 * O índice do computador — o que o JARVIS sabe sobre o seu PC.
 *
 * Ao ligar (e a cada 30 minutos) ele lista, sem sair do seu computador:
 *   - os aplicativos instalados (os mesmos do Menu Iniciar / Painel de
 *     Controle, inclusive os da Microsoft Store), pelo Get-StartApps;
 *   - os atalhos da Área de Trabalho e do Menu Iniciar;
 *   - as pastas e arquivos das suas pastas pessoais (Área de Trabalho,
 *     Documentos, Downloads, Imagens, Vídeos, Músicas e OneDrive).
 *
 * Só nomes e caminhos — o conteúdo dos arquivos não é lido. Fica guardado em
 * indice-computador.json, na pasta do JARVIS, e nunca é enviado para fora.
 * Com ele, "abre o LoL" e "procura a pasta Jarvis nos documentos" respondem na
 * hora, sem gastar o Claude.
 */

import { spawn } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { readdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const norm = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

let indice = { at: 0, apps: [], arquivos: [], pronto: false }
let construindo = null
let arquivoIndice = ''

/** As pastas pessoais, com o nome que se fala. */
export function pastasPessoais() {
  const h = homedir()
  const p = [
    ['area de trabalho', join(h, 'Desktop')],
    ['area de trabalho', join(h, 'OneDrive', 'Desktop')],
    ['area de trabalho', join(h, 'OneDrive', 'Área de Trabalho')],
    ['documentos', join(h, 'Documents')],
    ['documentos', join(h, 'OneDrive', 'Documents')],
    ['documentos', join(h, 'OneDrive', 'Documentos')],
    ['downloads', join(h, 'Downloads')],
    ['imagens', join(h, 'Pictures')],
    ['imagens', join(h, 'OneDrive', 'Pictures')],
    ['videos', join(h, 'Videos')],
    ['musicas', join(h, 'Music')],
    ['onedrive', join(h, 'OneDrive')],
  ]
  return p.filter(([, path]) => existsSync(path))
}

function startApps() {
  return new Promise((resolve) => {
    if (platform() !== 'win32') return resolve([])
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | ConvertTo-Json -Compress'],
      { windowsHide: true },
    )
    let out = ''
    ps.stdout.on('data', (d) => (out += d))
    ps.on('error', () => resolve([]))
    ps.on('close', () => {
      try {
        const j = JSON.parse(out)
        const list = Array.isArray(j) ? j : [j]
        resolve(
          list
            .filter((a) => a?.Name && a?.AppID)
            .filter((a) => !/desinstal|uninstall|remov|readme|leia-me|help|ajuda|documentation|website/i.test(a.Name))
            .map((a) => ({ nome: a.Name, n: norm(a.Name), abrir: `shell:AppsFolder\\${a.AppID}` })),
        )
      } catch {
        resolve([])
      }
    })
    setTimeout(() => {
      try {
        ps.kill()
      } catch {
        /* já foi */
      }
    }, 20000)
  })
}

async function atalhos() {
  const h = homedir()
  const pastas = [
    join(h, 'Desktop'),
    join(h, 'OneDrive', 'Desktop'),
    join(h, 'OneDrive', 'Área de Trabalho'),
    join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),
    join(process.env.APPDATA || join(h, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ]
  const list = []
  const walk = async (dir, depth) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 3) await walk(full, depth + 1)
      } else if (/\.(lnk|url|appref-ms)$/i.test(e.name)) {
        const nome = e.name.replace(/\.(lnk|url|appref-ms)$/i, '')
        if (/desinstal|uninstall|remov|readme|leia-me|help|ajuda|website/i.test(nome)) continue
        list.push({ nome, n: norm(nome), abrir: full })
      }
    }
  }
  for (const p of pastas) if (existsSync(p)) await walk(p, 0)
  return list
}

const PULAR = /^(node_modules|appdata|\.git|\.cache|\$recycle\.bin|\..*|windows|program files.*|programdata|cache|caches|temp|tmp|__pycache__|venv|\.venv|site-packages|dist|build)$/i

async function arquivosPessoais(limite = 150000) {
  const lista = []
  const vistos = new Set()
  for (const [local, raiz] of pastasPessoais()) {
    if (vistos.has(raiz)) continue
    vistos.add(raiz)
    const fila = [{ p: raiz, d: 0 }]
    while (fila.length && lista.length < limite) {
      const { p, d } = fila.shift()
      let entries
      try {
        entries = await readdir(p, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const full = join(p, e.name)
        const dir = e.isDirectory()
        lista.push({ nome: e.name, n: norm(e.name), path: full, dir, local, d })
        if (dir && d < 8 && !PULAR.test(e.name)) fila.push({ p: full, d: d + 1 })
      }
    }
  }
  return lista
}

/** Monta (ou remonta) o índice. Seguro chamar várias vezes. */
export function atualizarIndice(root) {
  if (construindo) return construindo
  arquivoIndice = join(root, 'indice-computador.json')
  construindo = (async () => {
    const t0 = Date.now()
    const [apps, links, arquivos] = await Promise.all([startApps(), atalhos(), arquivosPessoais()])
    // Atalhos primeiro (são o que você vê na Área de Trabalho), depois os apps.
    const nomes = new Set()
    const todos = []
    for (const a of [...links, ...apps]) {
      if (nomes.has(a.n)) continue
      nomes.add(a.n)
      todos.push(a)
    }
    indice = { at: Date.now(), apps: todos, arquivos, pronto: true }
    try {
      await writeFile(
        arquivoIndice,
        JSON.stringify({ atualizado: new Date().toISOString(), apps: todos.map((a) => a.nome), totalArquivos: arquivos.length }, null, 1),
      )
    } catch {
      /* sem gravar, segue em memória */
    }
    console.log(`[jarvis] índice do computador: ${todos.length} aplicativos, ${arquivos.length} pastas e arquivos (${Math.round((Date.now() - t0) / 1000)} s)`)
    construindo = null
    return indice
  })()
  return construindo
}

/** Começa o índice e o renova a cada 30 minutos. */
export function iniciarIndice(root) {
  void atualizarIndice(root)
  setInterval(() => void atualizarIndice(root), 30 * 60 * 1000).unref?.()
}

export function indiceAtual() {
  return indice
}

/** Lê do disco a lista de apps (para o texto do Claude), se já existir. */
export async function nomesDosApps(root) {
  if (indice.pronto) return indice.apps.map((a) => a.nome)
  try {
    return JSON.parse(await readFile(join(root, 'indice-computador.json'), 'utf8')).apps ?? []
  } catch {
    return []
  }
}

/** O aplicativo que melhor combina com os nomes pedidos. */
export function acharApp(alvos) {
  let melhor = null
  for (const alvo of alvos) {
    const q = norm(alvo)
    const words = q.split(' ').filter(Boolean)
    for (const a of indice.apps) {
      let score = 0
      if (a.n === q) score = 100
      else if (a.n.startsWith(q)) score = 80
      else if (words.every((w) => a.n.split(' ').some((x) => x.startsWith(w)))) score = 60 - a.n.length / 10
      if (score && (!melhor || score > melhor.score)) melhor = { ...a, score }
    }
    if (melhor && melhor.score >= 60) break
  }
  return melhor
}

/** Pastas e arquivos que combinam com a busca, opcionalmente só num local. */
export function acharArquivos(query, { onlyDirs = false, local = '', limit = 8 } = {}) {
  const words = norm(query).split(' ').filter((w) => w.length > 0)
  if (!words.length || !indice.pronto) return null
  const exato = words.join(' ')
  const hits = []
  for (const a of indice.arquivos) {
    if (onlyDirs && !a.dir) continue
    if (local && a.local !== local) continue
    if (!words.every((w) => a.n.includes(w))) continue
    const base = a.n.replace(/\s(pdf|docx?|xlsx?|pptx?|txt|jpe?g|png|mp4|zip|rar)$/, '')
    const score = (base === exato ? 20 : 0) + (a.dir ? 3 : 0) - a.d + (a.n.startsWith(words[0]) ? 2 : 0)
    hits.push({ ...a, score })
  }
  hits.sort((x, y) => y.score - x.score)
  return hits.slice(0, limit)
}
