/**
 * Agenda e e-mails do JARVIS — a "antena".
 *
 * AGENDA: as agendas do Google pelo "endereço secreto em formato iCal" (um
 * link privado só de leitura). Este módulo baixa, interpreta o .ics (fusos,
 * dia inteiro, eventos que se repetem, exceções) e junta tudo numa linha do
 * tempo só, de hoje até daqui a 7 dias.
 *
 * E-MAILS: contas Gmail por IMAP com senha de app. Só LÊ: abre a caixa em
 * modo somente leitura (EXAMINE) e usa BODY.PEEK, então nada é marcado como
 * lido. Cada e-mail novo é triado UMA vez (ação / info / ruído) numa única
 * chamada ao Claude por lote; o resultado fica em cache e nunca é refeito.
 *
 * Links e senhas ficam em integracoes.json, na pasta do JARVIS, só no seu PC
 * (fora do GitHub). Nunca vão para o log nem para o Claude.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'
import tls from 'node:tls'

let root = process.cwd()
let perguntar = null
let avisar = () => {}

const CFG = () => join(root, 'integracoes.json')
const CACHE = () => join(root, 'triagem-emails.json')

const AGENDA_HOSTS = /(^|\.)google\.com$|(^|\.)googleusercontent\.com$/
const IMAP_HOSTS = new Set(['imap.gmail.com', 'outlook.office365.com', 'imap-mail.outlook.com'])
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const DIAS_JANELA = 7

export const MODELOS = { haiku: 'Econômico · Haiku', sonnet: 'Equilibrado · Sonnet', opus: 'Máximo · Opus' }

// ---------------------------------------------------------------- config

const PADRAO = {
  agendas: [
    { id: 'a1', nome: 'Pessoal', cor: '#22d3ee', url: '' },
    { id: 'a2', nome: 'Trabalho', cor: '#8b5cf6', url: '' },
    { id: 'a3', nome: 'Faculdade', cor: '#10b981', url: '' },
  ],
  emails: [
    { id: 'e1', apelido: 'Pessoal', cor: '#38bdf8', usuario: '', senhaApp: '', host: 'imap.gmail.com' },
    { id: 'e2', apelido: 'Trabalho', cor: '#f472b6', usuario: '', senhaApp: '', host: 'imap.gmail.com' },
  ],
  quantidade: 20,
  intervaloEmailsMin: 15,
  modelo: 'haiku',
  digestAuto: true,
}

export function lerConfig() {
  try {
    if (existsSync(CFG())) return { ...PADRAO, ...JSON.parse(readFileSync(CFG(), 'utf8')) }
  } catch {}
  return structuredClone(PADRAO)
}

function gravarConfig(c) {
  writeFileSync(CFG(), JSON.stringify(c, null, 2))
}

/** A config para a tela: links e senhas viram só "salvo / não salvo". */
export function configPublica() {
  const c = lerConfig()
  return {
    ...c,
    agendas: c.agendas.map(({ url, ...a }) => ({ ...a, url: '', salvo: Boolean(url) })),
    emails: c.emails.map(({ senhaApp, ...e }) => ({ ...e, senhaApp: '', salvo: Boolean(senhaApp) })),
    modelos: MODELOS,
  }
}

/** Salva o que veio da tela. Link/senha em branco = manter o que já estava. */
export function salvarConfig(nova) {
  const velha = lerConfig()
  const keep = (lista, id, campo) => lista.find((x) => x.id === id)?.[campo] ?? ''
  const c = {
    ...velha,
    agendas: (nova.agendas ?? []).slice(0, 12).map((a, i) => ({
      id: String(a.id || `a${Date.now()}${i}`),
      nome: String(a.nome || `Agenda ${i + 1}`).slice(0, 30),
      cor: /^#[0-9a-f]{3,8}$/i.test(a.cor) ? a.cor : '#22d3ee',
      url: String(a.url || '').trim() || (a.apagarUrl ? '' : keep(velha.agendas, a.id, 'url')),
    })),
    emails: (nova.emails ?? []).slice(0, 8).map((e, i) => ({
      id: String(e.id || `e${Date.now()}${i}`),
      apelido: String(e.apelido || `Conta ${i + 1}`).slice(0, 30),
      cor: /^#[0-9a-f]{3,8}$/i.test(e.cor) ? e.cor : '#38bdf8',
      usuario: String(e.usuario || '').trim(),
      senhaApp: String(e.senhaApp || '').replace(/\s+/g, '') || (e.apagarSenha ? '' : keep(velha.emails, e.id, 'senhaApp')),
      host: IMAP_HOSTS.has(e.host) ? e.host : 'imap.gmail.com',
    })),
    modelo: MODELOS[nova.modelo] ? nova.modelo : velha.modelo,
    digestAuto: nova.digestAuto ?? velha.digestAuto,
  }
  gravarConfig(c)
  return c
}

// ---------------------------------------------------------------- HTTP

function baixar(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url.replace(/^webcal:/i, 'https:'))
    } catch {
      return reject(new Error('link inválido'))
    }
    if (u.protocol !== 'https:' || !AGENDA_HOSTS.test(u.hostname)) return reject(new Error('só links do Google Agenda são aceitos'))
    const req = https.get(u, { headers: { 'user-agent': UA, accept: 'text/calendar,*/*' }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) return reject(new Error('redirecionamentos demais'))
        return resolve(baixar(new URL(res.headers.location, u).toString(), redirects - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(res.statusCode === 404 ? 'link não encontrado (foi redefinido?)' : `o Google respondeu ${res.statusCode}`))
      }
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > 15e6) req.destroy(new Error('agenda grande demais'))
        else chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('o Google demorou demais')))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- ICS

/** Diferença (ms) entre a hora de parede do fuso e UTC, num instante. */
function offsetDoFuso(ms, tz) {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, x.value]),
    )
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms
  } catch {
    return null
  }
}

/** "20261110T143000" no fuso `tz` → instante (ms). */
function paredeParaUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const off = offsetDoFuso(guess, tz)
  if (off === null) return new Date(y, mo - 1, d, h, mi, s).getTime()
  const t = guess - off
  const off2 = offsetDoFuso(t, tz)
  return off2 === off ? t : guess - off2
}

/** Uma data do ICS → { ms, diaTodo }. */
function lerData(valor, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(valor).trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (h === undefined || params.VALUE === 'DATE') return { ms: new Date(+y, +mo - 1, +d).getTime(), diaTodo: true }
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)), diaTodo: false }
  if (params.TZID) return { ms: paredeParaUtc(+y, +mo, +d, +h, +mi, +(s ?? 0), params.TZID.replace(/^"|"$/g, '')), diaTodo: false }
  return { ms: new Date(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)).getTime(), diaTodo: false }
}

function texto(v) {
  return String(v ?? '')
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim()
}

/** Interpreta um .ics e devolve os VEVENTs. */
export function parseIcs(ics) {
  const linhas = String(ics).replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const eventos = []
  let ev = null
  let dentroDeOutro = 0
  for (const linha of linhas) {
    if (linha === 'BEGIN:VEVENT') {
      ev = { exdate: [] }
      continue
    }
    if (linha === 'END:VEVENT') {
      if (ev?.inicio) eventos.push(ev)
      ev = null
      continue
    }
    if (!ev) continue
    if (/^BEGIN:/.test(linha)) dentroDeOutro++
    if (/^END:/.test(linha)) {
      dentroDeOutro = Math.max(0, dentroDeOutro - 1)
      continue
    }
    if (dentroDeOutro) continue // VALARM etc.
    const i = linha.indexOf(':')
    if (i < 0) continue
    const [nome, ...ps] = linha.slice(0, i).split(';')
    const valor = linha.slice(i + 1)
    const params = Object.fromEntries(ps.map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), v ?? '']))
    switch (nome.toUpperCase()) {
      case 'SUMMARY': ev.titulo = texto(valor); break
      case 'LOCATION': ev.local = texto(valor); break
      case 'UID': ev.uid = valor; break
      case 'STATUS': ev.status = valor.toUpperCase(); break
      case 'DTSTART': { const d = lerData(valor, params); if (d) { ev.inicio = d.ms; ev.diaTodo = d.diaTodo; ev.tz = params.TZID } break }
      case 'DTEND': { const d = lerData(valor, params); if (d) ev.fim = d.ms; break }
      case 'DURATION': ev.duracao = valor; break
      case 'RRULE': ev.rrule = Object.fromEntries(valor.split(';').map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), v])); break
      case 'EXDATE': for (const v of valor.split(',')) { const d = lerData(v, params); if (d) ev.exdate.push(d.ms) } break
      case 'RECURRENCE-ID': { const d = lerData(valor, params); if (d) ev.recId = d.ms; break }
    }
  }
  return eventos
}

function duracaoMs(ev) {
  if (ev.fim) return ev.fim - ev.inicio
  const m = /P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/.exec(ev.duracao ?? '')
  if (m) return (((+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 24 + +(m[3] ?? 0)) * 60 + +(m[4] ?? 0)) * 60000 + +(m[5] ?? 0) * 1000
  return ev.diaTodo ? 86400000 : 3600000
}

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

/** Todas as ocorrências de um evento que caem em [de, ate). */
function ocorrencias(ev, de, ate, trocadas) {
  const dur = duracaoMs(ev)
  const dentro = (t) => t + dur > de && t < ate
  if (!ev.rrule) return dentro(ev.inicio) ? [ev.inicio] : []
  const r = ev.rrule
  const freq = r.FREQ
  const intervalo = Math.max(1, +(r.INTERVAL ?? 1))
  const count = r.COUNT ? +r.COUNT : Infinity
  const until = r.UNTIL ? (lerData(r.UNTIL, {})?.ms ?? Infinity) : Infinity
  const byday = (r.BYDAY ?? '').split(',').filter(Boolean)
  const ex = new Set(ev.exdate)
  const base = new Date(ev.inicio)
  const out = []
  let n = 0
  const aceita = (t) => {
    if (t < ev.inicio) return true
    if (t > until || n >= count) return false
    n++
    if (!ex.has(t) && !trocadas.has(t) && dentro(t)) out.push(t)
    return true
  }
  // Mantém a hora de parede do evento (dias, semanas, meses no horário local).
  const em = (d) => d.getTime()
  // Sem COUNT, pula direto para perto da janela (eventos antigos que se repetem).
  let i0 = 0
  if (count === Infinity && de > ev.inicio) {
    const dias = (de - ev.inicio) / 86400000
    const passos = freq === 'DAILY' ? dias : freq === 'WEEKLY' ? dias / 7 : freq === 'MONTHLY' ? dias / 31 : freq === 'YEARLY' ? dias / 366 : 0
    i0 = Math.max(0, Math.floor(passos / intervalo) - 1) * intervalo
  }
  for (let i = i0, guard = 0; guard < 3000; i += intervalo, guard++) {
    let datas = []
    if (freq === 'DAILY') {
      const d = new Date(base)
      d.setDate(base.getDate() + i)
      datas = [d]
    } else if (freq === 'WEEKLY') {
      const semana = new Date(base)
      semana.setDate(base.getDate() - base.getDay() + i * 7)
      const dias = byday.length ? byday.map((b) => DOW[b.slice(-2)]).filter((x) => x !== undefined) : [base.getDay()]
      datas = dias.sort().map((dw) => {
        const d = new Date(semana)
        d.setDate(semana.getDate() + dw)
        return d
      })
    } else if (freq === 'MONTHLY') {
      const mes = new Date(base.getFullYear(), base.getMonth() + i, 1, base.getHours(), base.getMinutes(), base.getSeconds())
      if (byday.length) {
        // "2TU" = segunda terça; "-1FR" = última sexta.
        for (const b of byday) {
          const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(b)
          if (!m) continue
          const dw = DOW[m[2]]
          const nth = m[1] ? +m[1] : 0
          const dias = []
          const d = new Date(mes)
          while (d.getMonth() === mes.getMonth()) {
            if (d.getDay() === dw) dias.push(new Date(d))
            d.setDate(d.getDate() + 1)
          }
          if (nth > 0 && dias[nth - 1]) datas.push(dias[nth - 1])
          else if (nth < 0 && dias[dias.length + nth]) datas.push(dias[dias.length + nth])
          else if (nth === 0) datas.push(...dias)
        }
      } else {
        const d = new Date(mes)
        d.setDate(base.getDate())
        if (d.getMonth() === mes.getMonth()) datas = [d]
      }
    } else if (freq === 'YEARLY') {
      const d = new Date(base)
      d.setFullYear(base.getFullYear() + i)
      if (d.getMonth() === base.getMonth()) datas = [d]
    } else {
      return dentro(ev.inicio) ? [ev.inicio] : []
    }
    datas.sort((a, b) => a - b)
    let continua = true
    for (const d of datas) if (!aceita(em(d))) { continua = false; break }
    if (!continua) break
    if (datas.length && em(datas[0]) >= ate) break
  }
  return out
}

/** Eventos de [de, ate) de um .ics, já expandidos. */
export function eventosDoIcs(ics, de, ate) {
  const evs = parseIcs(ics)
  const trocadasPorUid = new Map()
  for (const e of evs) if (e.recId) (trocadasPorUid.get(e.uid) ?? trocadasPorUid.set(e.uid, new Set()).get(e.uid)).add(e.recId)
  const out = []
  for (const e of evs) {
    if (e.status === 'CANCELLED') continue
    const trocadas = e.recId ? new Set() : (trocadasPorUid.get(e.uid) ?? new Set())
    const dur = duracaoMs(e)
    for (const t of ocorrencias(e, de, ate, trocadas)) {
      out.push({ id: `${e.uid ?? e.titulo}@${t}`, titulo: e.titulo || '(sem título)', local: e.local || '', inicio: t, fim: t + dur, diaTodo: Boolean(e.diaTodo) })
    }
  }
  return out
}

// ---------------------------------------------------------------- IMAP

const q = (s) => `"${String(s).replace(/[\\"]/g, (c) => '\\' + c)}"`

/** Cliente IMAP mínimo, só leitura. */
function imap(host) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: 993, servername: host, timeout: 25000 })
    let buf = Buffer.alloc(0)
    let waiter = null
    let tagN = 0
    const tryResolve = () => {
      if (!waiter) return
      // Percorre linhas pulando literais {n} até achar a linha final da tag.
      let p = 0
      for (;;) {
        const e = buf.indexOf('\r\n', p)
        if (e < 0) return
        const linha = buf.toString('latin1', p, e)
        const lit = /\{(\d+)\}$/.exec(linha)
        if (lit) {
          const fim = e + 2 + +lit[1]
          if (buf.length < fim) return
          p = fim
          continue
        }
        if (waiter.tag === '*' ? linha.startsWith('* ') : linha.startsWith(waiter.tag + ' ')) {
          const out = buf.subarray(0, e + 2)
          buf = buf.subarray(e + 2)
          const w = waiter
          waiter = null
          const st = /^\S+ (OK|NO|BAD)/.exec(linha)?.[1] ?? 'OK'
          w.resolve({ status: st, raw: out, linha })
          return
        }
        p = e + 2
      }
    }
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      tryResolve()
    })
    sock.on('timeout', () => sock.destroy(new Error('o servidor de e-mail demorou demais')))
    sock.on('error', (err) => {
      if (waiter) waiter.reject(err)
      else reject(err)
    })
    const esperar = (tag) =>
      new Promise((res, rej) => {
        waiter = { tag, resolve: res, reject: rej }
        tryResolve()
      })
    const cmd = (c) => {
      const tag = `J${++tagN}`
      sock.write(`${tag} ${c}\r\n`)
      return esperar(tag)
    }
    sock.once('secureConnect', () => {
      esperar('*').then(() => resolve({ cmd, fechar: () => sock.end() }), reject)
    })
  })
}

function decodificarCharset(bytes, charset) {
  try {
    return new TextDecoder(String(charset || 'utf-8').toLowerCase().replace(/^(us-)?ascii$/, 'utf-8')).decode(bytes)
  } catch {
    return Buffer.from(bytes).toString('utf8')
  }
}

/** =?UTF-8?B?...?= e =?UTF-8?Q?...?= */
export function decodeMimeWords(s) {
  return String(s ?? '')
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(txt, 'base64')
          : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1')
      return decodificarCharset(bytes, cs)
    })
}

function qp(s) {
  return Buffer.from(String(s).replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1')
}

function cabecalhos(txt) {
  const h = {}
  for (const l of String(txt).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = l.indexOf(':')
    if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim()
  }
  return h
}

const param = (v, nome) => new RegExp(`${nome}\\s*=\\s*"?([^";]+)"?`, 'i').exec(v ?? '')?.[1]

function semHtml(h) {
  return h
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
}

/** Corpo (parcial) → texto legível, preferindo text/plain. */
function extrairTexto(corpo, tipo, cte) {
  tipo = tipo || 'text/plain'
  if (/^multipart\//i.test(tipo)) {
    const b = param(tipo, 'boundary')
    if (!b) return ''
    const partes = corpo.split('--' + b).slice(1)
    const lidas = partes.map((p) => {
      const sep = p.search(/\r?\n\r?\n/)
      if (sep < 0) return { t: '', html: false }
      const h = cabecalhos(p.slice(0, sep))
      const ct = h['content-type'] || 'text/plain'
      return { t: extrairTexto(p.slice(sep).replace(/^\r?\n\r?\n/, ''), ct, h['content-transfer-encoding']), html: /html/i.test(ct), multi: /multipart/i.test(ct) }
    })
    const plano = lidas.find((x) => x.t && !x.html)
    return (plano ?? lidas.find((x) => x.t))?.t ?? ''
  }
  if (!/^text\//i.test(tipo)) return ''
  const enc = String(cte || '').toLowerCase()
  let bytes
  if (enc === 'base64') bytes = Buffer.from(corpo.replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+[^=]*$/, (m) => m), 'base64')
  else if (enc === 'quoted-printable') bytes = qp(corpo)
  else bytes = Buffer.from(corpo, 'latin1')
  let t = decodificarCharset(bytes, param(tipo, 'charset'))
  if (/html/i.test(tipo)) t = semHtml(t)
  return t
}

function limparTrecho(t) {
  return t
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[​-‏͏­]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

/** Os N e-mails mais recentes da caixa de entrada, sem marcar nada como lido. */
export async function buscarEmails({ host, usuario, senhaApp, quantidade = 20 }) {
  if (!IMAP_HOSTS.has(host)) throw new Error('servidor de e-mail não permitido')
  const c = await imap(host)
  try {
    const login = await c.cmd(`LOGIN ${q(usuario)} ${q(senhaApp)}`)
    if (login.status !== 'OK') throw Object.assign(new Error('Senha de app inválida ou verificação em 2 etapas desativada — refaça em myaccount.google.com/apppasswords'), { login: true })
    const ex = await c.cmd('EXAMINE INBOX')
    const total = +(/\* (\d+) EXISTS/.exec(ex.raw.toString('latin1'))?.[1] ?? 0)
    if (!total) return []
    const de = Math.max(1, total - quantidade + 1)
    const r = await c.cmd(
      `FETCH ${de}:${total} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.6000>)`,
    )
    return lerFetch(r.raw).reverse()
  } finally {
    c.cmd('LOGOUT').catch(() => {})
    setTimeout(() => c.fechar(), 300)
  }
}

export function lerFetch(raw) {
  const msgs = []
  let m = null
  let p = 0
  for (;;) {
    const e = raw.indexOf('\r\n', p)
    if (e < 0) break
    const linha = raw.toString('latin1', p, e)
    if (/^\* \d+ FETCH/.test(linha)) {
      m = { flags: '', header: '', text: '' }
      msgs.push(m)
    }
    if (m) {
      const fl = /FLAGS \(([^)]*)\)/.exec(linha)
      if (fl) m.flags = fl[1]
    }
    const lit = /\{(\d+)\}$/.exec(linha)
    if (lit) {
      const n = +lit[1]
      const corpo = raw.toString('latin1', e + 2, e + 2 + n)
      if (m) {
        if (/HEADER\.FIELDS|HEADER\]/i.test(linha.slice(-200))) m.header = corpo
        else m.text = corpo
      }
      p = e + 2 + n
      continue
    }
    p = e + 2
  }
  // Cabeçalho com UTF-8 cru (sem =?...?=) chega como bytes: conserta.
  const utf = (v) => (/[\x80-\xff]/.test(v) ? Buffer.from(v, 'latin1').toString('utf8') : v)
  return msgs.map((x) => {
    const h = Object.fromEntries(Object.entries(cabecalhos(x.header)).map(([k, v]) => [k, utf(v)]))
    const de = decodeMimeWords(h.from || '')
    const nome = /^"?([^"<]*?)"?\s*<[^>]+>/.exec(de)?.[1]?.trim()
    const end = /<([^>]+)>/.exec(de)?.[1] ?? de
    return {
      id: (h['message-id'] || `${h.date}|${h.subject}`).trim(),
      de: nome || end,
      deEmail: end,
      assunto: decodeMimeWords(h.subject || '(sem assunto)'),
      data: Date.parse(h.date || '') || Date.now(),
      trecho: limparTrecho(extrairTexto(x.text, h['content-type'], h['content-transfer-encoding'])),
      lido: /\\Seen/i.test(x.flags),
    }
  })
}

// ---------------------------------------------------------------- triagem

let cache = null
function lerCache() {
  if (cache) return cache
  try {
    cache = existsSync(CACHE()) ? JSON.parse(readFileSync(CACHE(), 'utf8')) : {}
  } catch {
    cache = {}
  }
  return cache
}
function gravarCache() {
  // Só os 600 mais recentes: o cache não cresce para sempre.
  const ent = Object.entries(cache).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, 600)
  cache = Object.fromEntries(ent)
  try {
    writeFileSync(CACHE(), JSON.stringify(cache))
  } catch {}
}

export function triagemLocal(e) {
  const t = `${e.deEmail} ${e.de} ${e.assunto} ${e.trecho}`.toLowerCase()
  if (/no-?reply|newsletter|unsubscribe|descadastr|promo|oferta|desconto|% off|cupom|marketing|notifica|news@|info@|mailer|noreply/.test(t)) return 'ruido'
  if (/\?|prazo|urgente|fatura|boleto|vencimento|reuni[aã]o|por favor|pode me|poderia|preciso|responder|confirme|aguardo|solicita|intima|audi[eê]ncia|despacho/.test(t)) return 'acao'
  return 'info'
}

async function triar(emails) {
  const c = lerCache()
  const novos = emails.filter((e) => !c[e.id])
  if (novos.length && perguntar) {
    const lista = novos.slice(0, 40).map((e, i) => ({ i, de: e.de, assunto: e.assunto.slice(0, 140), trecho: e.trecho.slice(0, 200) }))
    try {
      const resp = await perguntar(
        'Classifique cada e-mail em um balde:\n' +
          '- "acao": pede resposta, tarefa, decisão ou tem prazo — alguém esperando o usuário;\n' +
          '- "info": vale saber, mas não exige nada (confirmação, recibo, atualização);\n' +
          '- "ruido": promoção, newsletter, notificação automática.\n' +
          'Responda SÓ com um JSON: [{"i":0,"balde":"acao","resumo":"uma frase curta em português"}].\n\n' +
          JSON.stringify(lista),
      )
      const json = JSON.parse(/\[[\s\S]*\]/.exec(resp)?.[0] ?? '[]')
      for (const r of json) {
        const e = novos[r.i]
        if (e && ['acao', 'info', 'ruido'].includes(r.balde)) c[e.id] = { balde: r.balde, resumo: String(r.resumo ?? '').slice(0, 200), por: 'ia', at: Date.now() }
      }
      console.log(`[jarvis] e-mails: ${json.length} triados pelo Claude numa chamada só`)
    } catch (err) {
      console.warn(`[jarvis] triagem pelo Claude falhou, usando a local: ${err?.message ?? err}`)
    }
  }
  for (const e of novos) if (!c[e.id]) c[e.id] = { balde: triagemLocal(e), resumo: e.assunto, por: 'local', at: Date.now() }
  if (novos.length) gravarCache()
  return emails.map((e) => ({ ...e, ...c[e.id] }))
}

// ---------------------------------------------------------------- estado

const estado = {
  eventos: [],
  agendaErros: [],
  agendaAt: 0,
  emails: [],
  emailErros: [],
  emailsAt: 0,
  carregando: { agenda: false, emails: false },
}
let primeiraCarga = null

export function estadoIntegracoes() {
  const c = lerConfig()
  return {
    ...estado,
    temAgenda: c.agendas.some((a) => a.url),
    temEmail: c.emails.some((e) => e.usuario && e.senhaApp),
    acao: estado.emails.filter((e) => e.balde === 'acao' && !e.lido).length,
  }
}

export async function atualizarAgenda() {
  const c = lerConfig()
  const ags = c.agendas.filter((a) => a.url)
  estado.carregando.agenda = true
  const hoje = new Date()
  hoje.setHours(0, 0, 0, 0)
  const de = hoje.getTime()
  const ate = de + (DIAS_JANELA + 1) * 86400000
  const erros = []
  const todos = []
  await Promise.all(
    ags.map(async (a) => {
      try {
        const evs = eventosDoIcs(await baixar(a.url), de, ate)
        todos.push(...evs.map((e) => ({ ...e, id: `${a.id}:${e.id}`, agenda: a.nome, cor: a.cor })))
      } catch (err) {
        erros.push({ nome: a.nome, erro: String(err?.message ?? err) })
      }
    }),
  )
  estado.eventos = todos.sort((x, y) => x.inicio - y.inicio || Number(y.diaTodo) - Number(x.diaTodo))
  estado.agendaErros = erros
  estado.agendaAt = Date.now()
  estado.carregando.agenda = false
  if (ags.length) console.log(`[jarvis] agenda: ${todos.length} eventos de ${ags.length} agenda(s)${erros.length ? `, ${erros.length} com erro` : ''}`)
  avisar()
}

export async function atualizarEmails() {
  const c = lerConfig()
  const contas = c.emails.filter((e) => e.usuario && e.senhaApp)
  estado.carregando.emails = true
  const erros = []
  const todos = []
  await Promise.all(
    contas.map(async (conta) => {
      try {
        const es = await buscarEmails({ ...conta, quantidade: c.quantidade })
        todos.push(...es.map((e) => ({ ...e, conta: conta.apelido, cor: conta.cor })))
      } catch (err) {
        erros.push({ nome: conta.apelido, erro: String(err?.message ?? err) })
      }
    }),
  )
  estado.emails = (await triar(todos)).sort((a, b) => b.data - a.data)
  estado.emailErros = erros
  estado.emailsAt = Date.now()
  estado.carregando.emails = false
  if (contas.length) console.log(`[jarvis] e-mails: ${todos.length} de ${contas.length} conta(s)${erros.length ? `, ${erros.length} com erro` : ''}`)
  avisar()
}

/** Espera a primeira busca (para o digest da manhã não sair vazio). */
export function prontoIntegracoes(maxMs = 25000) {
  return Promise.race([primeiraCarga ?? Promise.resolve(), new Promise((r) => setTimeout(r, maxMs))])
}

export function iniciarIntegracoes(projectRoot, opts = {}) {
  root = projectRoot
  perguntar = opts.perguntar ?? null
  avisar = opts.avisar ?? (() => {})
  primeiraCarga = Promise.allSettled([atualizarAgenda(), atualizarEmails()])
  setInterval(() => void atualizarAgenda().catch(() => {}), 10 * 60 * 1000)
  const min = Math.max(5, +lerConfig().intervaloEmailsMin || 15)
  setInterval(() => void atualizarEmails().catch(() => {}), min * 60 * 1000)
}

/** Uma linha compacta para o prompt do Claude: agenda de hoje + ações. */
export function contextoCompacto() {
  const s = estadoIntegracoes()
  if (!s.temAgenda && !s.temEmail) return ''
  const fimHoje = new Date()
  fimHoje.setHours(23, 59, 59, 999)
  const hoje = s.eventos.filter((e) => e.inicio <= fimHoje.getTime() && e.fim >= Date.now() - 3600000).slice(0, 12)
  const hh = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const partes = []
  if (s.temAgenda) partes.push(`Agenda de hoje: ${hoje.length ? hoje.map((e) => `${e.diaTodo ? 'dia todo' : hh(e.inicio)} ${e.titulo}`).join(' · ') : 'nada'}`)
  if (s.temEmail) partes.push(`E-mails pedindo ação: ${s.acao}`)
  return partes.join(' | ')
}
