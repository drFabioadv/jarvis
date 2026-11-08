/**
 * O Segundo Cérebro do JARVIS — notas curtas sobre a vida do usuário.
 *
 * Ficam em segundo-cerebro.json, na pasta do JARVIS (fora do GitHub: são
 * dados pessoais, só existem no seu PC). Todas as notas entram no prompt do
 * Claude e da IA local em toda conversa, para ele responder sempre te
 * conhecendo. A tela mostra as notas como um grafo neural, onde você edita,
 * cria e apaga.
 *
 * Memória viva: quando você conta algo novo e duradouro, o Claude termina a
 * resposta com [[SAVE:area|titulo|texto]]; esta parte grava a nota e tira a
 * linha do que ele fala e mostra.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const AREAS = {
  metas: 'Metas',
  trabalho: 'Carreira',
  projetos: 'Projetos',
  financas: 'Finanças',
  aprendizado: 'Aprendizado',
  saude: 'Saúde',
  relacoes: 'Relações',
  meta: 'Você',
}

let root = process.cwd()
let data = null
/** Ainda é o cérebro de fábrica (nada gravado no disco)? */
let padrao = false

const file = () => join(root, 'segundo-cerebro.json')

export function iniciarCerebro(projectRoot) {
  root = projectRoot
  carregar()
}

/**
 * Importação: um segundo-cerebro.json baixado (pasta Downloads) entra no lugar
 * do cérebro de fábrica, uma vez. Assim dá para montar as notas fora e só
 * baixar o arquivo.
 */
function importarDownloads() {
  const f = join(homedir(), 'Downloads', 'segundo-cerebro.json')
  try {
    if (!existsSync(f)) return false
    const d = JSON.parse(readFileSync(f, 'utf8'))
    if (!Array.isArray(d?.notas) || !d.notas.length) return false
    data = { notas: d.notas, rel: Array.isArray(d.rel) ? d.rel : [] }
    padrao = false
    gravar()
    console.log(`[jarvis] segundo cérebro importado de Downloads (${d.notas.length} notas)`)
    return true
  } catch (err) {
    console.warn(`[jarvis] não consegui importar o segundo cérebro: ${err?.message ?? err}`)
    return false
  }
}

function carregar() {
  if (data && padrao) importarDownloads()
  if (data) return data
  try {
    if (existsSync(file())) data = JSON.parse(readFileSync(file(), 'utf8'))
  } catch (err) {
    console.warn(`[jarvis] segundo cérebro ilegível, começando vazio: ${err?.message ?? err}`)
  }
  if ((!data || !Array.isArray(data.notas)) && importarDownloads()) return data
  if (!data || !Array.isArray(data.notas)) {
    padrao = true
    data = {
      notas: [{ id: 'n-jarvis', area: 'meta', title: 'JARVIS', body: 'Assistente pessoal de voz do usuário, no PC dele.' }],
      rel: [],
    }
  }
  if (!Array.isArray(data.rel)) data.rel = []
  return data
}

function gravar() {
  padrao = false
  try {
    writeFileSync(file(), JSON.stringify(data, null, 2))
  } catch (err) {
    console.warn(`[jarvis] não consegui gravar o segundo cérebro: ${err?.message ?? err}`)
  }
}

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

export function cerebro() {
  const d = carregar()
  return { notas: d.notas, rel: d.rel, areas: AREAS }
}

/** Liga uma nota nova às da mesma área e ao hub de metas. */
function ligar(id, area) {
  const d = carregar()
  const tem = (a, b) => d.rel.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
  const mesma = d.notas.filter((n) => n.id !== id && n.area === area).slice(0, 3)
  const hub = d.notas.find((n) => n.id !== id && n.area === 'metas')
  for (const n of [...mesma, ...(hub ? [hub] : [])]) if (!tem(id, n.id)) d.rel.push([id, n.id])
}

/**
 * Cria ou atualiza. Com `id`, atualiza aquela nota; sem `id`, atualiza a de
 * mesmo título (sem acento/maiúscula) ou cria uma nova.
 */
export function salvarNota({ id, area, title, body }) {
  const d = carregar()
  area = AREAS[area] ? area : 'meta'
  title = String(title ?? '').trim().slice(0, 40) || 'Nota'
  body = String(body ?? '').trim().slice(0, 1200)
  let n = id ? d.notas.find((x) => x.id === id) : d.notas.find((x) => norm(x.title) === norm(title))
  if (n) {
    Object.assign(n, { area, title, body, at: Date.now() })
  } else {
    n = { id: `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, area, title, body, at: Date.now() }
    d.notas.push(n)
    ligar(n.id, area)
  }
  gravar()
  return n
}

export function excluirNota(id) {
  const d = carregar()
  d.notas = d.notas.filter((n) => n.id !== id)
  d.rel = d.rel.filter(([a, b]) => a !== id && b !== id)
  gravar()
}

/** O cérebro inteiro em texto, agrupado por área, para o prompt. */
export function cerebroPrompt() {
  const d = carregar()
  const grupos = Object.entries(AREAS)
    .map(([k, label]) => {
      const ns = d.notas.filter((n) => n.area === k)
      return ns.length ? `${label}:\n${ns.map((n) => `- ${n.title}: ${n.body}`).join('\n')}` : ''
    })
    .filter(Boolean)
    .join('\n')
  return `

SEGUNDO CÉREBRO — o que você sabe sobre a vida do usuário (use para personalizar as respostas; não recite isso sem ele pedir):
${grupos || '(ainda vazio)'}

MEMÓRIA VIVA: se o usuário revelar algo NOVO e DURADOURO sobre a vida dele (meta, trabalho, projeto, estudo, saúde, pessoa próxima, preferência), TERMINE a resposta com uma linha no formato EXATO [[SAVE:area|titulo|texto]], com area entre metas, trabalho, projetos, financas, aprendizado, saude, relacoes, meta (meta = sobre ele em geral), título de 1 ou 2 palavras e texto curto. Se já existir nota com esse título, ela é atualizada; senão nasce uma nova. Inclua só quando houver algo realmente novo. Nunca salve senhas, números de documentos ou de contas. Essa linha não é falada: não comente que está salvando.
`
}

const SAVE_RE = /\[\[SAVE:([a-z_]+)\|([^|\]]+)\|([\s\S]+?)\]\]/g

/** Tira as linhas [[SAVE]] de um texto pronto, gravando cada uma. */
export function extrairSaves(text, onSave) {
  return String(text ?? '')
    .replace(SAVE_RE, (_, area, title, body) => {
      onSave?.(salvarNota({ area, title, body }))
      return ''
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/**
 * Filtro de fluxo: deixa o texto passar pedaço a pedaço, mas segura qualquer
 * coisa que comece com "[[" até saber se é um [[SAVE:...]] — esse nunca
 * chega à fala.
 */
export function filtroSave(emit, onSave) {
  let buf = ''
  const push = (delta) => {
    buf += delta
    for (;;) {
      const i = buf.indexOf('[[')
      if (i < 0) {
        // Um "[" solto no fim pode ser o começo de "[[".
        const keep = buf.endsWith('[') ? 1 : 0
        if (buf.length > keep) emit(buf.slice(0, buf.length - keep))
        buf = buf.slice(buf.length - keep)
        return
      }
      if (i > 0) {
        emit(buf.slice(0, i))
        buf = buf.slice(i)
      }
      const j = buf.indexOf(']]')
      if (j < 0) {
        // Não é um SAVE (ou é longo demais para ser um): solta.
        if (!/^\[\[(S(A(V(E(:.*)?)?)?)?)?$/s.test(buf) || buf.length > 1400) {
          emit(buf.slice(0, 2))
          buf = buf.slice(2)
          continue
        }
        return
      }
      const bloco = buf.slice(0, j + 2)
      buf = buf.slice(j + 2)
      const limpo = extrairSaves(bloco, onSave)
      if (limpo) emit(limpo)
    }
  }
  const flush = () => {
    if (buf) emit(buf)
    buf = ''
  }
  return { push, flush }
}
