/**
 * Organização pessoal do JARVIS: tarefas, rotinas (automações) e o histórico
 * de atividades.
 *
 * TAREFAS: lista simples com prazo opcional ("adiciona tarefa revisar o
 * edital pra sexta"). ROTINAS: comandos que o JARVIS roda sozinho num
 * horário ("todo dia às 7h30, bom dia"; "a cada 60 minutos, tem e-mail
 * importante?"), com condição, pausa e histórico. Rodam no cérebro (bridge),
 * então funcionam com a janela minimizada ou escondida na bandeja.
 * HISTÓRICO: o que foi pedido e o que ele fez, para "o que eu te pedi hoje?"
 * e para o painel.
 *
 * Tudo em arquivos JSON na pasta do JARVIS (fora do GitHub).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let root = process.cwd()
const arq = (n) => join(root, n)

function ler(nome, padrao) {
  try {
    if (existsSync(arq(nome))) return JSON.parse(readFileSync(arq(nome), 'utf8'))
  } catch (err) {
    console.warn(`[jarvis] ${nome} ilegível: ${err?.message ?? err}`)
  }
  return padrao
}
function gravar(nome, dados) {
  try {
    writeFileSync(arq(nome), JSON.stringify(dados, null, 1))
  } catch (err) {
    console.warn(`[jarvis] não consegui gravar ${nome}: ${err?.message ?? err}`)
  }
}

const id = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Semelhança simples entre textos (palavras em comum), 0..1. */
export function parecido(a, b) {
  const A = new Set(norm(a).split(' ').filter((w) => w.length > 2))
  const B = new Set(norm(b).split(' ').filter((w) => w.length > 2))
  if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0
  let n = 0
  for (const w of A) if (B.has(w) || [...B].some((x) => x.startsWith(w) || w.startsWith(x))) n++
  return n / Math.min(A.size, B.size)
}

// ------------------------------------------------------------------ tarefas

let tarefas = []

export function listarTarefas({ todas = false } = {}) {
  return todas ? tarefas : tarefas.filter((t) => !t.feita)
}

export function adicionarTarefa({ texto, prazo = null, prioridade = 'normal' }) {
  texto = String(texto ?? '').trim().slice(0, 200)
  if (!texto) throw new Error('tarefa vazia')
  // Evita duplicar a mesma tarefa aberta.
  const igual = tarefas.find((t) => !t.feita && parecido(t.texto, texto) >= 0.9 && norm(t.texto).length - norm(texto).length < 8)
  if (igual) {
    if (prazo) igual.prazo = prazo
    gravar('tarefas.json', tarefas)
    return { tarefa: igual, duplicada: true }
  }
  const t = { id: id('t'), texto, prazo, prioridade, feita: false, criada: Date.now() }
  tarefas.push(t)
  gravar('tarefas.json', tarefas)
  return { tarefa: t, duplicada: false }
}

/** Acha a tarefa aberta que mais parece com `busca` (ou pelo id). */
export function acharTarefa(busca) {
  const abertas = tarefas.filter((t) => !t.feita)
  const porId = abertas.find((t) => t.id === busca)
  if (porId) return porId
  let melhor = null
  let nota = 0
  for (const t of abertas) {
    const p = parecido(busca, t.texto)
    if (p > nota) {
      nota = p
      melhor = t
    }
  }
  return nota >= 0.5 ? melhor : null
}

export function concluirTarefa(busca) {
  const t = acharTarefa(busca)
  if (!t) return null
  t.feita = true
  t.concluida = Date.now()
  // Só as 200 concluídas mais recentes ficam guardadas.
  const feitas = tarefas.filter((x) => x.feita).sort((a, b) => b.concluida - a.concluida)
  if (feitas.length > 200) {
    const fora = new Set(feitas.slice(200).map((x) => x.id))
    tarefas = tarefas.filter((x) => !fora.has(x.id))
  }
  gravar('tarefas.json', tarefas)
  return t
}

export function removerTarefa(idTarefa) {
  const antes = tarefas.length
  tarefas = tarefas.filter((t) => t.id !== idTarefa)
  gravar('tarefas.json', tarefas)
  return tarefas.length !== antes
}

export function atualizarTarefa(idTarefa, campos) {
  const t = tarefas.find((x) => x.id === idTarefa)
  if (!t) return null
  if (typeof campos.texto === 'string' && campos.texto.trim()) t.texto = campos.texto.trim().slice(0, 200)
  if ('prazo' in campos) t.prazo = campos.prazo || null
  if (campos.prioridade) t.prioridade = campos.prioridade === 'alta' ? 'alta' : 'normal'
  if (typeof campos.feita === 'boolean') {
    t.feita = campos.feita
    t.concluida = campos.feita ? Date.now() : undefined
  }
  gravar('tarefas.json', tarefas)
  return t
}

// ------------------------------------------------------------------ rotinas

let rotinas = []
let executar = null
let aoMudar = () => {}

const FREQ = new Set(['diaria', 'dias-uteis', 'semanal', 'intervalo'])
const COND = new Set(['sempre', 'tem-compromisso', 'tem-email-acao', 'tem-tarefa'])

export function listarRotinas() {
  return rotinas
}

export function salvarRotina(r) {
  const velha = r.id ? rotinas.find((x) => x.id === r.id) : null
  const nova = {
    id: velha?.id ?? id('r'),
    nome: String(r.nome ?? '').trim().slice(0, 60) || 'Rotina',
    descricao: String(r.descricao ?? '').trim().slice(0, 200),
    comando: String(r.comando ?? '').trim().slice(0, 200),
    frequencia: FREQ.has(r.frequencia) ? r.frequencia : 'diaria',
    horario: /^\d{1,2}:\d{2}$/.test(r.horario ?? '') ? r.horario.padStart(5, '0') : '08:00',
    dias: Array.isArray(r.dias) ? r.dias.map(Number).filter((d) => d >= 0 && d <= 6) : [1, 2, 3, 4, 5],
    intervaloMin: Math.max(15, Math.min(1440, Number(r.intervaloMin) || 60)),
    condicao: COND.has(r.condicao) ? r.condicao : 'sempre',
    falar: r.falar !== false,
    ativa: r.ativa !== false,
    historico: velha?.historico ?? [],
    ultima: velha?.ultima ?? 0,
  }
  if (!nova.comando) throw new Error('a rotina precisa de um comando')
  if (velha) Object.assign(velha, nova)
  else rotinas.push(nova)
  gravar('rotinas.json', rotinas)
  return nova
}

export function excluirRotina(idRotina) {
  rotinas = rotinas.filter((r) => r.id !== idRotina)
  gravar('rotinas.json', rotinas)
}

export function pausarRotina(idRotina, ativa) {
  const r = rotinas.find((x) => x.id === idRotina)
  if (!r) return null
  r.ativa = ativa
  gravar('rotinas.json', rotinas)
  return r
}

/** A rotina deve rodar agora? (`agora` em ms, horário local) */
export function venceu(r, agora = Date.now()) {
  if (!r.ativa) return false
  const d = new Date(agora)
  if (r.frequencia === 'intervalo') return agora - (r.ultima || 0) >= r.intervaloMin * 60000
  const [h, m] = r.horario.split(':').map(Number)
  const alvo = new Date(d)
  alvo.setHours(h, m, 0, 0)
  if (agora < alvo.getTime()) return false
  // Já rodou depois do horário de hoje?
  if ((r.ultima || 0) >= alvo.getTime()) return false
  // Passou muito da hora (PC desligado)? Só recupera até 2 horas de atraso.
  if (agora - alvo.getTime() > 2 * 3600000) return false
  const dia = d.getDay()
  if (r.frequencia === 'dias-uteis') return dia >= 1 && dia <= 5
  if (r.frequencia === 'semanal') return r.dias.includes(dia)
  return true
}

async function rodar(r, motivo = 'agenda') {
  r.ultima = Date.now()
  let ok = true
  let resumo = ''
  try {
    const res = await executar(r)
    ok = res.ok !== false
    resumo = res.resumo ?? ''
  } catch (err) {
    ok = false
    resumo = String(err?.message ?? err)
  }
  r.historico = [{ at: Date.now(), ok, resumo: resumo.slice(0, 200), motivo }, ...(r.historico ?? [])].slice(0, 20)
  gravar('rotinas.json', rotinas)
  registrar('rotina', `${r.nome}: ${ok ? resumo || 'executada' : `falhou (${resumo})`}`)
  aoMudar()
  return { ok, resumo }
}

export function rodarAgora(idRotina) {
  const r = rotinas.find((x) => x.id === idRotina)
  return r ? rodar(r, 'manual') : Promise.resolve({ ok: false, resumo: 'rotina não encontrada' })
}

// ------------------------------------------------------------------ histórico

let historico = []

/** Registra uma atividade (pedido, ação, rotina...). Nunca guarda segredos. */
export function registrar(tipo, texto) {
  const limpo = String(texto ?? '')
    .replace(/\b(?:[a-z]{4} ){3}[a-z]{4}\b/gi, '••••')
    .replace(/https?:\/\/\S*(ical|private|token|key)\S*/gi, '[link privado]')
    .slice(0, 240)
  historico.unshift({ at: Date.now(), tipo, texto: limpo })
  historico = historico.slice(0, 300)
  gravar('historico.json', historico)
}

export function listarHistorico(n = 50) {
  return historico.slice(0, n)
}

// ------------------------------------------------------------------ início

export function iniciarOrganizador(projectRoot, opts = {}) {
  root = projectRoot
  tarefas = ler('tarefas.json', [])
  rotinas = ler('rotinas.json', [])
  historico = ler('historico.json', [])
  executar = opts.executar ?? (async () => ({ ok: false, resumo: 'sem executor' }))
  aoMudar = opts.aoMudar ?? (() => {})
  if (opts.semRelogio) return
  setInterval(() => {
    for (const r of rotinas) if (venceu(r)) void rodar(r)
  }, 30000).unref?.()
}

export { COND, FREQ }
