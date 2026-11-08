/**
 * O cérebro local do JARVIS — tudo o que ele resolve SEM gastar o Claude.
 *
 * Antes de cada pedido ir para o Claude, `handleLocal` tenta entender o pedido
 * com regras simples em português. Se reconhecer, resolve aqui mesmo, de graça:
 *
 *   - "bom dia" / "boa tarde" / "me atualiza"  → briefing com clima e notícias
 *   - "que horas são" / "que dia é hoje"
 *   - "como está o tempo em Recife"             → clima (Open-Meteo, sem chave)
 *   - "notícias sobre inteligência artificial"  → manchetes (RSS)
 *   - "coloca lo-fi no YouTube"                 → acha o vídeo e abre tocando
 *   - "pesquisa no Google ..."                  → abre a pesquisa
 *   - "abre o WhatsApp" / "abre a calculadora"  → sites e programas conhecidos
 *   - "procura nos meus arquivos a pasta X"     → busca nas pastas do usuário
 *
 * Qualquer outra coisa volta `null` e segue para o Claude, como antes.
 *
 * As respostas são faladas em trechos e cada trecho pode trazer um cartão para
 * a tela, no ritmo da fala — é o "briefing" do layout.
 */

import { AREAS } from './cerebro.mjs'
import { spawn } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { acharApp, acharArquivos } from './indice.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

// ------------------------------------------------------------------ config

/** Preferências do usuário em jarvis-config.json na pasta do projeto. */
export function loadConfig(root) {
  const defaults = {
    cidade: 'Belém',
    latitude: -1.4558,
    longitude: -48.4902,
    nome: 'senhor',
    // Temas do radar de notícias do "bom dia".
    temas: ['tecnologia', 'inteligência artificial', 'Pará', 'economia'],
    // Feeds fixos das manchetes principais.
    feeds: [
      'https://g1.globo.com/rss/g1/',
      'https://feeds.bbci.co.uk/portuguese/rss.xml',
      'https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419',
    ],
    noticiasPorBriefing: 3,
    // O jornal do dia (no estilo do The News): seções, fontes e buscas.
    // "feeds" são RSS; "buscas" viram pesquisas no Google Notícias do último dia.
    jornal: [
      {
        secao: 'Política',
        feeds: ['https://agenciabrasil.ebc.com.br/rss/politica/feed.xml', 'https://www.camara.leg.br/noticias/rss/ultimas-noticias'],
        buscas: ['Senado aprova', 'Câmara aprova projeto', 'Lula sanciona', 'Congresso aprova'],
        itens: 5,
      },
      {
        secao: 'Direito',
        feeds: ['https://www.conjur.com.br/rss.xml', 'https://agenciabrasil.ebc.com.br/rss/justica/feed.xml'],
        buscas: ['STF decide', 'STJ decide', 'nova lei sancionada', 'TST decide'],
        itens: 5,
      },
      { secao: 'Economia', feeds: ['https://agenciabrasil.ebc.com.br/rss/economia/feed.xml'], buscas: ['economia Brasil', 'Banco Central juros'], itens: 3 },
      {
        secao: 'Inteligência artificial',
        feeds: [],
        buscas: ['inteligência artificial', 'OpenAI', 'Anthropic Claude', 'Google Gemini', 'IA regulação'],
        itens: 4,
      },
      { secao: 'Tecnologia', feeds: ['https://g1.globo.com/rss/g1/tecnologia/'], buscas: ['tecnologia lançamento'], itens: 2 },
      { secao: 'Pará', feeds: ['https://g1.globo.com/rss/g1/pa/para/'], buscas: ['Belém Pará', 'governo do Pará'], itens: 3 },
      {
        secao: 'Mundo',
        feeds: ['https://agenciabrasil.ebc.com.br/rss/internacional/feed.xml', 'https://feeds.bbci.co.uk/portuguese/rss.xml'],
        buscas: ['Estados Unidos', 'Europa', 'China', 'guerra'],
        itens: 4,
      },
    ],
  }
  try {
    const file = join(root, 'jarvis-config.json')
    if (existsSync(file)) return { ...defaults, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    /* config inválida: usa o padrão */
  }
  return defaults
}

// ------------------------------------------------------------------ texto

/** Minúsculas, sem acentos e sem pontuação — para comparar pedidos. */
export const norm = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Tira o vocativo e as cortesias do começo e do fim. */
function clean(text) {
  return norm(text)
    .replace(/^(ei |oi |ola |fala |e ai )?(jarvis|jarves|jarbas|javis|javi|jaaves|jav|ja vis[eiou]?|djarvis|jervis|travis)\b ?/, '')
    .replace(/^(por favor|pfv|pf) /, '')
    .replace(/ (por favor|pfv|pf|jarvis)$/, '')
    .trim()
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']

/** Número falado do jeito que se diz: 27,4 → "vinte e sete vírgula quatro". */
function falarNumero(n) {
  const u = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove']
  const d = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa']
  const int = (x) => {
    x = Math.round(x)
    if (x < 0) return `menos ${int(-x)}`
    if (x < 20) return u[x]
    if (x < 100) return d[Math.floor(x / 10)] + (x % 10 ? ` e ${u[x % 10]}` : '')
    if (x === 100) return 'cem'
    return String(x)
  }
  if (Number.isInteger(n)) return int(n)
  const [a, b] = n.toFixed(1).split('.')
  return b === '0' ? int(Number(a)) : `${int(Number(a))} vírgula ${u[Number(b)]}`
}

function falarHora(date) {
  const h = date.getHours()
  const m = date.getMinutes()
  const hh = h === 0 ? 'meia-noite' : h === 12 ? 'meio-dia' : h === 1 || h === 13 ? 'uma' : h === 2 || h === 14 ? 'duas' : falarNumero(h > 12 ? h - 12 : h)
  const periodo = h < 12 ? 'da manhã' : h < 18 ? 'da tarde' : 'da noite'
  const extra = h === 0 || h === 12 ? '' : ` ${periodo}`
  return m === 0 ? `${hh} em ponto${extra}` : `${hh} e ${falarNumero(m)}${extra}`
}

// ------------------------------------------------------------------ rede

async function getText(url, ms = 6000) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(ms),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.text()
}
const getJson = async (url, ms) => JSON.parse(await getText(url, ms))

// ------------------------------------------------------------------ abrir coisas

/** Abre um site, pasta, arquivo ou protocolo (calculator:, ms-settings:). */
export function openThing(target) {
  try {
    const p = platform()
    const cmd = p === 'win32' ? 'explorer.exe' : p === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(cmd, [target], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

function runProgram(exe, args = []) {
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

const SITES = {
  youtube: 'https://www.youtube.com',
  'you tube': 'https://www.youtube.com',
  whatsapp: 'https://web.whatsapp.com',
  'whats app': 'https://web.whatsapp.com',
  zap: 'https://web.whatsapp.com',
  gmail: 'https://mail.google.com',
  email: 'https://mail.google.com',
  'meu email': 'https://mail.google.com',
  'e mail': 'https://mail.google.com',
  instagram: 'https://www.instagram.com',
  insta: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com',
  tiktok: 'https://www.tiktok.com',
  'tik tok': 'https://www.tiktok.com',
  netflix: 'https://www.netflix.com',
  spotify: 'https://open.spotify.com',
  'google drive': 'https://drive.google.com',
  drive: 'https://drive.google.com',
  agenda: 'https://calendar.google.com',
  'google agenda': 'https://calendar.google.com',
  calendario: 'https://calendar.google.com',
  'google maps': 'https://www.google.com/maps',
  maps: 'https://www.google.com/maps',
  mapa: 'https://www.google.com/maps',
  google: 'https://www.google.com',
  claude: 'https://claude.ai',
  chatgpt: 'https://chatgpt.com',
  linkedin: 'https://www.linkedin.com',
  'mercado livre': 'https://www.mercadolivre.com.br',
  amazon: 'https://www.amazon.com.br',
  shopee: 'https://shopee.com.br',
  'prime video': 'https://www.primevideo.com',
  globoplay: 'https://globoplay.globo.com',
  g1: 'https://g1.globo.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  pncp: 'https://pncp.gov.br/app/editais',
  'portal nacional de contratacoes': 'https://pncp.gov.br/app/editais',
  'compras gov': 'https://www.gov.br/compras',
  'diario oficial': 'https://www.ioepa.com.br',
  pje: 'https://pje.tjpa.jus.br',
  'canva': 'https://www.canva.com',
}

const PROGRAMAS = {
  calculadora: ['protocol', 'calculator:'],
  configuracoes: ['protocol', 'ms-settings:'],
  configuracao: ['protocol', 'ms-settings:'],
  'bloco de notas': ['exe', 'notepad.exe'],
  notepad: ['exe', 'notepad.exe'],
  explorador: ['exe', 'explorer.exe'],
  'explorador de arquivos': ['exe', 'explorer.exe'],
  'meus arquivos': ['exe', 'explorer.exe'],
  paint: ['exe', 'mspaint.exe'],
  word: ['protocol', 'ms-word:'],
  excel: ['protocol', 'ms-excel:'],
  powerpoint: ['protocol', 'ms-powerpoint:'],
  camera: ['protocol', 'microsoft.windows.camera:'],
  relogio: ['protocol', 'ms-clock:'],
  despertador: ['protocol', 'ms-clock:'],
  loja: ['protocol', 'ms-windows-store:'],
  'microsoft store': ['protocol', 'ms-windows-store:'],
  steam: ['protocol', 'steam://open/main'],
  capcut: ['protocol', 'capcut:'],
}

// ---- programas instalados: atalhos da Área de Trabalho e do Menu Iniciar ----

/** Apelidos: o que você fala → nomes de atalho que podem existir. */
const APELIDOS = {
  lol: ['league of legends', 'riot client'],
  'league of legends': ['league of legends', 'riot client'],
  liga: ['league of legends'],
  valorant: ['valorant', 'riot client'],
  riot: ['riot client'],
  fortnite: ['fortnite', 'epic games'],
  epic: ['epic games'],
  'epic games': ['epic games'],
  minecraft: ['minecraft'],
  roblox: ['roblox player', 'roblox'],
  discord: ['discord'],
  steam: ['steam'],
  capcut: ['capcut'],
  'virtual dj': ['virtualdj', 'virtual dj'],
  virtualdj: ['virtualdj'],
  whatsapp: ['whatsapp'],
  'msi afterburner': ['msi afterburner'],
  afterburner: ['msi afterburner'],
  chrome: ['google chrome'],
  edge: ['microsoft edge'],
  word: ['word'],
  excel: ['excel'],
  powerpoint: ['powerpoint'],
  obs: ['obs studio'],
  spotify: ['spotify'],
  teams: ['microsoft teams', 'teams'],
  zoom: ['zoom'],
}

let atalhosCache = { at: 0, list: [] }

async function listarAtalhos() {
  if (Date.now() - atalhosCache.at < 5 * 60 * 1000 && atalhosCache.list.length) return atalhosCache.list
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
        if (/desinstalar|uninstall|remover|readme|leia-me|help|ajuda|site|website/i.test(nome)) continue
        list.push({ nome, n: norm(nome), path: full })
      }
    }
  }
  for (const p of pastas) if (existsSync(p)) await walk(p, 0)
  atalhosCache = { at: Date.now(), list }
  return list
}

/** O atalho que melhor combina com o que foi pedido, ou null. */
async function acharPrograma(pedido) {
  const q = norm(pedido)
  if (!q) return null
  const alvos = APELIDOS[q] ?? [q]
  // O índice do computador (apps instalados + atalhos) responde na hora.
  const doIndice = acharApp(alvos)
  if (doIndice && doIndice.score >= 60) return { nome: doIndice.nome, path: doIndice.abrir, score: doIndice.score }
  const list = await listarAtalhos()
  let melhor = null
  for (const alvo of alvos) {
    const words = norm(alvo).split(' ').filter(Boolean)
    for (const a of list) {
      let score = 0
      if (a.n === norm(alvo)) score = 100
      else if (a.n.startsWith(norm(alvo))) score = 80
      else if (words.every((w) => a.n.includes(w))) score = 60 - a.n.length / 10
      if (score && (!melhor || score > melhor.score)) melhor = { ...a, score }
    }
    if (melhor && melhor.score >= 60) break
  }
  return melhor
}

function userFolders() {
  const h = homedir()
  return {
    downloads: join(h, 'Downloads'),
    documentos: join(h, 'Documents'),
    'area de trabalho': join(h, 'Desktop'),
    desktop: join(h, 'Desktop'),
    imagens: join(h, 'Pictures'),
    fotos: join(h, 'Pictures'),
    videos: join(h, 'Videos'),
    musicas: join(h, 'Music'),
    onedrive: join(h, 'OneDrive'),
  }
}

// ------------------------------------------------------------------ clima

const WMO = {
  0: ['céu limpo', 'sol'], 1: ['poucas nuvens', 'sol'], 2: ['céu parcialmente nublado', 'nuvem-sol'], 3: ['céu nublado', 'nuvem'],
  45: ['neblina', 'nuvem'], 48: ['neblina', 'nuvem'],
  51: ['garoa fraca', 'chuva'], 53: ['garoa', 'chuva'], 55: ['garoa forte', 'chuva'],
  61: ['chuva fraca', 'chuva'], 63: ['chuva', 'chuva'], 65: ['chuva forte', 'chuva'],
  80: ['pancadas de chuva', 'chuva'], 81: ['pancadas de chuva', 'chuva'], 82: ['temporal', 'tempestade'],
  95: ['trovoadas', 'tempestade'], 96: ['trovoadas com granizo', 'tempestade'], 99: ['trovoadas com granizo', 'tempestade'],
}

async function geocode(city) {
  const j = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt&format=json`,
  )
  const r = j.results?.[0]
  if (!r) return null
  return { nome: r.name, lat: r.latitude, lon: r.longitude, uf: r.admin1 ?? '' }
}

/**
 * A cidade de um pedido de clima: a última "em/de/no/na X" da frase.
 * "coloca em tela o clima daqui de Belém do Pará" → "belem".
 * Sem cidade, "daqui" ou "aqui" → a cidade padrão (string vazia).
 */
function cidadeDoPedido(t) {
  const limpo = t
    .replace(/\b(do|de) (para|pa)$/, '')
    .replace(/\b(hoje|amanha|agora|neste momento|por favor|pra mim|para mim|na tela|em tela)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const m = /.*\b(?:em|de|no|na|para|pra|da|do)\s+([a-z][a-z ]{2,30})$/.exec(limpo)
  let c = (m?.[1] ?? '').trim()
  c = c.replace(/^(cidade|cidade de|municipio de)\s+/, '').trim()
  if (!c || /\b(clima|tempo|temperatura|previsao|aqui|daqui|minha cidade|casa|mim|tela)\b/.test(c)) return ''
  return c
}

async function weather(cfg, city) {
  let place = { nome: cfg.cidade, lat: cfg.latitude, lon: cfg.longitude }
  if (city && norm(city) !== norm(cfg.cidade)) {
    const g = await geocode(city)
    if (!g) return null
    place = g
  }
  const j = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1',
  )
  const c = j.current ?? {}
  const d = j.daily ?? {}
  const [desc, icon] = WMO[c.weather_code] ?? ['tempo variável', 'nuvem']
  return {
    cidade: place.nome,
    temp: c.temperature_2m,
    sensacao: c.apparent_temperature,
    umidade: c.relative_humidity_2m,
    vento: c.wind_speed_10m,
    min: d.temperature_2m_min?.[0],
    max: d.temperature_2m_max?.[0],
    chuva: d.precipitation_probability_max?.[0],
    desc,
    icon,
  }
}

function weatherCard(w) {
  return {
    kind: 'clima',
    kicker: 'PANORAMA · CLIMA',
    title: w.cidade,
    clima: w,
  }
}

function weatherSpeech(w) {
  const partes = [`Em ${w.cidade}, agora faz ${falarNumero(Math.round(w.temp))} graus, com ${w.desc}`]
  if (w.min != null && w.max != null) {
    partes.push(`A mínima será de ${falarNumero(Math.round(w.min))} e a máxima de ${falarNumero(Math.round(w.max))}`)
  }
  if (w.chuva != null) partes.push(`com chance de chuva de ${falarNumero(w.chuva)} por cento`)
  return partes.join('. ').replace('. com chance', ', com chance') + '.'
}

// ------------------------------------------------------------------ notícias

function entities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

function decode(s) {
  return entities(String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** As primeiras frases de um texto, até uns 280 caracteres. */
function resumo(txt) {
  const t = String(txt).replace(/\s+/g, ' ').trim()
  if (t.length <= 280) return t
  const cut = t.slice(0, 300)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`
}

function parseFeed(xml, fallbackSource = '') {
  const items = []
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) ?? []
  const channel = decode(/<title[^>]*>([\s\S]*?)<\/title>/.exec(xml)?.[1] ?? fallbackSource)
  for (const b of blocks) {
    const get = (name) => {
      const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(b)
      return m ? m[1] : ''
    }
    let title = decode(get('title')).replace(/^[A-ZÇÃÕÉÍÓÚÂÊÔ ]{4,20}\.\s+/, '')
    let source = decode(get('source')) || channel
    // Google News põe a fonte no fim do título: "Manchete - Folha".
    const dash = title.lastIndexOf(' - ')
    if (dash > 20 && /news\.google/.test(xml.slice(0, 2000))) {
      source = title.slice(dash + 3)
      title = title.slice(0, dash)
    }
    const link = decode(get('link')) || (/<link[^>]+href="([^"]+)"/.exec(b)?.[1] ?? '')
    let desc = decode(get('description') || get('summary') || get('content'))
    // O Google Notícias põe no resumo só o título de novo e o nome da fonte.
    if (norm(desc).startsWith(norm(title).slice(0, 30)) || /news\.google/.test(desc)) desc = ''
    const image =
      /<media:content[^>]+url="([^"]+)"/.exec(b)?.[1] ??
      /<media:thumbnail[^>]+url="([^"]+)"/.exec(b)?.[1] ??
      /<enclosure[^>]+url="([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i.exec(b)?.[1] ??
      /<img[^>]+src=["']([^"']+)["']/.exec(entities(get('description') + get('content:encoded')))?.[1] ??
      ''
    const when = Date.parse(decode(get('pubDate') || get('updated') || get('published'))) || 0
    if (title) items.push({ title, link, desc: resumo(desc), image, source: source.replace(/^g1\s*>.*$/i, 'g1'), when })
  }
  return items
}

async function feed(url) {
  try {
    return parseFeed(await getText(url, 7000))
  } catch {
    return []
  }
}

const googleNews = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`

async function news(topic, n = 4, cfg, extra) {
  const lists = extra
    ? await Promise.all([...(extra.feeds ?? []).map(feed), ...(extra.buscas ?? []).map((q) => feed(googleNews(`${q} when:1d`)))])
    : topic
      ? [await feed(googleNews(`${topic} when:2d`))]
      : await Promise.all((cfg?.feeds ?? []).map(feed))
  const seen = new Set()
  const all = []
  for (const list of lists) {
    for (const it of list) {
      const k = norm(it.title).slice(0, 60)
      if (seen.has(k)) continue
      seen.add(k)
      all.push(it)
    }
  }
  // Mais recentes primeiro; as que têm resumo ganham um empurrão.
  const day = 24 * 3600 * 1000
  all.sort((a, b) => b.when + (b.desc ? day / 4 : 0) - (a.when + (a.desc ? day / 4 : 0)))
  // Alterna entre fontes para não ler cinco manchetes do mesmo lugar.
  return all.slice(0, n)
}

/** Duas manchetes falam da mesma coisa? (muitas palavras em comum) */
function parecidas(a, b) {
  // Compara pelo começo das palavras ("utilizam"/"usam" não, mas
  // "climático"/"climáticos" e "enfrentam"/"enfrentando" sim).
  const raiz = (t) => new Set(norm(t).split(' ').filter((w) => w.length > 3).map((w) => w.slice(0, 6)))
  const wa = raiz(a)
  const wb = raiz(b)
  if (!wa.size || !wb.size) return false
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  return inter / Math.min(wa.size, wb.size) >= 0.45
}

function newsCard(it, tema, kicker) {
  return {
    kind: 'noticia',
    kicker: kicker ?? `RADAR · ${(tema || 'NOTÍCIAS').toUpperCase()}`,
    title: it.title,
    text: it.desc && it.desc !== it.title ? it.desc : '',
    image: it.image || '',
    source: it.source || '',
    link: it.link || '',
  }
}

// ------------------------------------------------------------------ YouTube

async function youtubeFirst(query) {
  const html = await getText(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=pt-BR`, 8000)
  const re = /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,1500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g
  const m = re.exec(html)
  if (m) return { id: m[1], title: JSON.parse(`"${m[2]}"`) }
  const id = /"videoId":"([\w-]{11})"/.exec(html)?.[1]
  return id ? { id, title: query } : null
}

// ------------------------------------------------------------------ arquivos

async function findFiles(query, { onlyDirs = false, limit = 8, budgetMs = 5000, local = '' } = {}) {
  const words = norm(query).split(' ').filter((w) => w.length > 1)
  if (!words.length) return []
  // Com o índice pronto, a busca é instantânea.
  const rapido = acharArquivos(query, { onlyDirs, local, limit })
  if (rapido) return rapido.map((h) => ({ path: h.path, name: h.nome, dir: h.dir, score: h.score }))
  const roots = Object.values(userFolders()).filter((p, i, a) => existsSync(p) && a.indexOf(p) === i)
  const skip = /^(node_modules|appdata|\.git|\$recycle\.bin|\..*|windows|program files.*)$/i
  const started = Date.now()
  const hits = []
  const queue = roots.map((p) => ({ p, depth: 0 }))
  let seen = 0
  while (queue.length && Date.now() - started < budgetMs && seen < 60000) {
    const { p, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(p, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      seen++
      const full = join(p, e.name)
      const isDir = e.isDirectory()
      const n = norm(e.name)
      if (words.every((w) => n.includes(w)) && (!onlyDirs || isDir)) {
        // Mais pontos para nome exato e para quem está mais perto da raiz.
        const exact = n === words.join(' ') ? 10 : 0
        hits.push({ path: full, name: e.name, dir: isDir, score: exact + (isDir ? 2 : 0) - depth })
      }
      if (isDir && depth < 6 && !skip.test(e.name)) queue.push({ p: full, depth: depth + 1 })
    }
  }
  hits.sort((a, b) => b.score - a.score)
  const out = hits.slice(0, limit)
  for (const h of out) {
    try {
      const s = await stat(h.path)
      h.when = s.mtimeMs
    } catch {
      /* sem data */
    }
  }
  return out
}

function filesCard(query, hits) {
  return {
    kind: 'lista',
    kicker: 'ARQUIVOS · BUSCA',
    title: hits.length ? `${hits.length} resultado${hits.length > 1 ? 's' : ''} para “${query}”` : `Nada encontrado para “${query}”`,
    items: hits.map((h) => ({
      label: `${h.dir ? '📁' : '📄'} ${h.name}`,
      sub: dirname(h.path).replace(homedir(), '~'),
    })),
  }
}

/**
 * Devolve, com os acentos originais, um trecho que foi achado no texto
 * normalizado ("inteligencia artificial" → "inteligência artificial").
 */
function restorer(raw) {
  const rawTokens = String(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const normTokens = rawTokens.map((w) => norm(w))
  return (piece) => {
    const want = norm(piece).split(' ').filter(Boolean)
    if (!want.length) return piece
    for (let i = normTokens.length - want.length; i >= 0; i--) {
      if (want.every((w, k) => normTokens[i + k] === w)) return rawTokens.slice(i, i + want.length).join(' ')
    }
    return piece
  }
}

// ------------------------------------------------------------------ sistema

/** Roda um comando curto do PowerShell, escondido. */
function ps(command) {
  if (platform() !== 'win32') return false
  return runProgram('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command])
}

/** Aperta uma tecla especial (volume, mídia) n vezes. */
const tecla = (code, n = 1) =>
  ps(`$w = New-Object -ComObject WScript.Shell; 1..${n} | ForEach-Object { $w.SendKeys([char]${code}) }`)

/** Comandos do Windows: volume, mídia, tela. Devolve a fala ou null. */
function comandoSistema(t, ctx) {
  const run = ctx.ps ?? ps
  const key = ctx.tecla ?? tecla
  const n = Number(/\b(\d{1,3})\s*(?:%|por cento)/.exec(t)?.[1] ?? 0)
  if (/\b(muta|mutar|silencia|silenciar|tira o som|tira o audio|sem som)\b/.test(t)) return key(173) && 'Som desligado.'
  if (/\b(volume no maximo|volume maximo|volume todo)\b/.test(t)) return key(175, 50) && 'Volume no máximo.'
  if (/\b(aumenta|aumente|sobe|suba|mais alto|aumentar)\b.*\b(volume|som)\b|\b(volume|som) (mais alto|pra cima)\b/.test(t))
    return key(175, n ? Math.ceil(n / 2) : 5) && 'Volume aumentado.'
  if (/\b(abaixa|abaixe|diminui|diminua|baixa|baixe|mais baixo|diminuir)\b.*\b(volume|som)\b|\b(volume|som) (mais baixo|pra baixo)\b/.test(t))
    return key(174, n ? Math.ceil(n / 2) : 5) && 'Volume diminuído.'
  if (/\b(pausa|pause|pausar|continua a musica|da play|despausa|play na musica|tocar de novo)\b/.test(t) && !/\byoutube\b/.test(t))
    return key(179) && 'Feito.'
  if (/\b(proxima musica|pula a musica|pula essa|proxima faixa|passa a musica|avanca a musica)\b/.test(t)) return key(176) && 'Próxima.'
  if (/\b(musica anterior|volta a musica|faixa anterior)\b/.test(t)) return key(177) && 'Voltando.'
  if (/\b(bloqueia|bloquear|trava|travar) (a tela|o computador|o pc)\b/.test(t))
    return runProgram('rundll32.exe', ['user32.dll,LockWorkStation']) && 'Tela bloqueada.'
  if (/\b(tira|tire|faz|faca) (um )?(print|captura de tela|screenshot)\b/.test(t))
    return (ctx.open ?? openThing)('ms-screenclip:') && 'Selecione a área da tela.'
  if (/\b(mostra a area de trabalho|mostrar a area de trabalho|minimiza os programas|minimiza as janelas do windows)\b/.test(t))
    return run('(New-Object -ComObject Shell.Application).MinimizeAll()') && 'Área de trabalho à vista.'
  return null
}

// ------------------------------------------------------------------ lembretes

/**
 * "me lembra em 10 minutos de tirar o bolo", "timer de 5 minutos",
 * "me lembra às 15h de ligar para o cliente", "me avisa daqui a 1 hora".
 * Devolve { quando (ms epoch), texto } ou null.
 */
export function lerLembrete(t) {
  if (!/\b(lembra|lembre|lembrete|avisa|avise|timer|temporizador|alarme|despertador|cronometro)\b/.test(t)) return null
  const NUM = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, quinze: 15, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, meia: 0.5 }
  const num = (x) => (x == null ? NaN : /^\d/.test(x) ? Number(x) : NUM[x] ?? NaN)
  let quando = 0
  const rel = /\b(?:em|daqui a|daqui|de|por)\s+(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|quinze|vinte|trinta|quarenta|cinquenta|meia)\s*(segundos?|minutos?|min|horas?|h)\b/.exec(t)
  if (rel) {
    const v = num(rel[1])
    const u = rel[2]
    const ms = /^s/.test(u) ? 1000 : /^h/.test(u) ? 3600000 : 60000
    if (!Number.isNaN(v)) quando = Date.now() + v * ms
  }
  if (!quando && /\bmeia hora\b/.test(t)) quando = Date.now() + 30 * 60000
  const abs = /\b(?:as|a)\s+(\d{1,2})(?:\s*(?:h|horas?|:)\s*(\d{1,2})?)?\b/.exec(t)
  if (!quando && abs) {
    const d = new Date()
    let h = Number(abs[1])
    const m = Number(abs[2] ?? 0)
    if (/\b(da tarde|da noite)\b/.test(t) && h < 12) h += 12
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
    quando = d.getTime()
  }
  if (!quando) return null
  const resto = t.replace(/^.*?\b(lembra|lembre|avisa|avise|lembrete)(-me)?\b\s*(me\s+)?/, '')
  let texto = resto
    .replace(/\b(?:em|daqui a|daqui|as|a|de|por)\s+(?:\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|quinze|vinte|trinta|quarenta|cinquenta|meia)\s*(?:segundos?|minutos?|min|horas?|h\b)?(?:\s*\d{1,2})?/g, ' ')
    .replace(/\b(meia hora|da tarde|da noite|da manha)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(de|para|pra|que|do|da)\s+/, '')
    .replace(/^(cria|crie|marca|marque|coloca|coloque|bota|poe|faz|faca|um|uma|novo|nova|\s)+(alarme|timer|temporizador|lembrete|despertador|cronometro)\b\s*(de|para|pra)?/, '')
    .trim()
  if (/^(timer|temporizador|cronometro|alarme|despertador)$|^$/.test(texto)) texto = ''
  if (/\b(timer|temporizador|cronometro|alarme|despertador)\b/.test(t) && !texto) texto = ''
  return { quando, texto }
}

// ------------------------------------------------------------------ o roteador

/**
 * Tenta resolver o pedido localmente.
 * Retorna uma lista de passos [{ say, card? }] ou null (vai para o Claude).
 */
const STOP = new Set('eu meu minha meus minhas o a os as um uma de do da dos das que e é em no na nos nas pra para por com sou tenho estou to tô vou quero gosto amo ele ela isso esse essa'.split(' '))
const AREA_PISTAS = [
  ['saude', /\b(treino|academia|corrida|correr|dormir|sono|dieta|alergi|medico|remedio|saude|futebol|esporte|peso)/],
  ['financas', /\b(dinheiro|divida|economizar|guardar dinheiro|investir|investimento|salario|renda|financ|conta|cartao)/],
  ['relacoes', /\b(namorada|namorado|esposa|mae|pai|irmao|irma|amigo|amiga|familia|filho|filha|socio|chefe)\b/],
  ['aprendizado', /\b(estud|curso|livro|ler|aprender|faculdade|pos|concurso|prova|ingles)/],
  ['projetos', /\b(projeto|app|aplicativo|site|canal|bot|jarvis|sistema)\b/],
  ['trabalho', /\b(trabalho|emprego|empresa|cargo|cliente|licitac|advocacia|escritorio|processo)/],
  ['metas', /\b(meta|objetivo|quero|sonho|plano|pretendo|ate o fim|ano que vem)\b/],
]
function notaDoTexto(txt) {
  const n = clean(txt)
  const area = (AREA_PISTAS.find(([, re]) => re.test(n)) ?? ['meta'])[0]
  const palavras = txt.replace(/[.,;:!?]/g, '').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(clean(w)))
  const title = palavras.slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Nota'
  return { area, title, body: txt[0].toUpperCase() + txt.slice(1).replace(/\s*$/, '') }
}

export async function handleLocal(raw, ctx) {
  const cfg = ctx.config
  const t = clean(raw)
  if (!t) return null
  const allowOpen = ctx.allowOpen !== false
  const opener = ctx.open ?? openThing
  const runner = ctx.run ?? runProgram
  const R = restorer(raw)

  // ---- respostas a uma oferta ("Quer que eu leia o jornal do dia?")
  const state = ctx.state ?? {}
  if (state.pending === 'jornal') {
    state.pending = null
    if (/^(sim|quero|pode|claro|manda|le|leia|ler|bora|vai|ok|okay|com certeza|por favor|isso|beleza|demorou|uhum)\b/.test(t)) return jornal(cfg)
    if (/^(nao|agora nao|depois|deixa|dispenso|nem|nada)\b/.test(t)) return [{ say: 'Muito bem, senhor. Estou à disposição.' }]
  }

  // ---- segundo cérebro: "anota que...", "guarda no meu cérebro que..."
  if (ctx.salvarNota) {
    const m = t.match(/^(?:anota|anote|guarda|guarde|grava|grave|registra|registre|salva|salve|memoriza|memorize|lembra|lembre)(?: ai| isso)?(?: (?:no|em) (?:meu |seu )?(?:segundo )?cerebro| na (?:sua )?memoria)?(?: que|:) (.{3,})$/)
    if (m) {
      const nota = notaDoTexto(R(m[1]))
      const n = ctx.salvarNota(nota)
      return [{ say: 'Anotado no seu segundo cérebro, senhor.', card: { kind: 'texto', kicker: `SEGUNDO CÉREBRO · ${(AREAS[n.area] ?? n.area).toUpperCase()}`, title: n.title, text: n.body } }]
    }
  }

  // ---- jornal do dia
  if (/\b(jornal|the news|leitura do dia|noticias do dia completas|ler as noticias|le as noticias|leia as noticias)\b/.test(t)) {
    return jornal(cfg)
  }

  // ---- comandos do Windows (volume, mídia, tela)
  if (allowOpen) {
    const sis = comandoSistema(t, { ...ctx, open: opener })
    if (sis) return [{ say: sis }]
  }

  // ---- lembretes e timers
  const lemb = lerLembrete(t)
  if (lemb && ctx.lembrar) {
    lemb.texto = lemb.texto ? R(lemb.texto) : ''
    ctx.lembrar(lemb)
    const d = new Date(lemb.quando)
    const seg = Math.round((lemb.quando - Date.now()) / 1000)
    const min = Math.round(seg / 60)
    const quando =
      seg < 60 ? `em ${falarNumero(seg)} segundos` : min < 60 ? (min <= 1 ? 'em um minuto' : `em ${falarNumero(min)} minutos`) : `às ${falarHora(d)}`
    return [{
      say: lemb.texto ? `Combinado. Eu te lembro ${quando}.` : `Timer marcado. Eu aviso ${quando}.`,
      card: { kind: 'texto', kicker: 'LEMBRETE', title: lemb.texto || 'Timer', text: d.toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) },
    }]
  }

  // ---- hora e data
  if (/\b(que horas (sao|e)|horas sao|me diz as horas|qual a hora)\b/.test(t)) {
    const now = new Date()
    return [{ say: `São ${falarHora(now)}.`, card: { kind: 'texto', kicker: 'SISTEMA · RELÓGIO', title: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), text: now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }) } }]
  }
  if (/\b(que dia (e|eh) hoje|qual (e )?a data|data de hoje|hoje e que dia)\b/.test(t)) {
    const now = new Date()
    return [{ say: `Hoje é ${DIAS[now.getDay()]}, ${now.getDate() === 1 ? 'primeiro' : falarNumero(now.getDate())} de ${MESES[now.getMonth()]}.` }]
  }

  // ---- briefing
  if (/^(bom dia|boa tarde|boa noite)\b/.test(t) || /\b(briefing|me atualiza|me atualize|resumo do dia|novidades do dia|o que tem de novo)\b/.test(t)) {
    return briefing(t, cfg, state)
  }

  // ---- clima
  if (/\b(clima|tempo|temperatura|previsao|vai chover|chuva|calor|frio)\b/.test(t) && !/\b(quanto tempo|tempo de|tempo para|tempo que)\b/.test(t)) {
    const city = cidadeDoPedido(t)
    const w = await weather(cfg, city)
    if (!w) return [{ say: `Não encontrei a cidade ${city}, senhor.` }]
    return [{ say: weatherSpeech(w), card: weatherCard(w) }]
  }

  // ---- notícias
  if (/\b(noticia|noticias|manchete|manchetes|jornal)\b/.test(t)) {
    const topic = R(/\b(?:sobre|de|do|da|dos|das)\s+(.+)$/.exec(t)?.[1]?.replace(/^(hoje|agora|do dia|de hoje)$/, '').trim() ?? '')
    const items = await news(topic, 3, cfg)
    if (!items.length) return [{ say: 'Receio que as fontes de notícias não responderam agora, senhor.' }]
    const steps = [{ say: topic ? `As principais notícias sobre ${topic}.` : 'As principais manchetes de agora.' }]
    for (const it of items) steps.push({ say: `${it.title}.`, card: newsCard(it, topic) })
    return steps
  }

  // ---- YouTube
  const yt =
    /\b(?:coloca|coloque|toca|toque|poe|ponha|bota|reproduz|reproduza|tocar|colocar|quero (?:ver|ouvir|assistir)|abre|abra|procura|pesquisa|busca)\b\s*(?:um |uma |o |a )?(?:video |musica |clipe )?(?:de |do |da )?(.*?)\s*(?:no|na|pelo) (?:youtube|you tube)$/.exec(t) ??
    /\b(?:youtube|you tube)\s+(?:e\s+)?(?:coloca|coloque|toca|toque|poe|ponha|bota|procura|pesquisa|busca)\s+(?:um |uma |o |a )?(?:video |musica |clipe )?(?:de |do |da )?(.+)$/.exec(t) ??
    /^(?:toca|toque|tocar)\s+(?:um |uma |o |a )?(?:video |musica |clipe |som )?(?:de |do |da )?(.+)$/.exec(t) ??
    /^(?:coloca|coloque|poe|ponha|bota)\s+(?:um |uma )?(?:video|musica|clipe|som)\s+(?:de |do |da )?(.+)$/.exec(t)
  if (yt) {
    const q = R((yt[1] ?? '').trim())
    if (!allowOpen) return null
    if (!q || q === 'youtube') {
      opener(SITES.youtube)
      return [{ say: 'Abrindo o YouTube, senhor.' }]
    }
    try {
      const v = await youtubeFirst(q)
      if (v) {
        opener(`https://www.youtube.com/watch?v=${v.id}`)
        return [{ say: `Tocando ${v.title}.`, card: { kind: 'video', kicker: 'MÍDIA · YOUTUBE', title: v.title, image: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, source: 'YOUTUBE' } }]
      }
    } catch {
      /* cai para a pesquisa */
    }
    opener(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`)
    return [{ say: `Pesquisa de ${q} aberta no YouTube.` }]
  }

  // ---- arquivos e pastas
  const fileAsk =
    /\b(?:procura|procure|acha|ache|encontra|encontre|busca|busque|localiza|abre|abra)\b\s*(?:nos meus arquivos |no computador |no meu computador |no pc )?(?:a |o |as |os |minha |meu )?(pasta|arquivo|documento|planilha|foto|pdf)s?\s+(?:chamad[ao] |de nome |com nome |do |da |de )?(.+?)(?:\s+(?:nos meus arquivos|no computador|no meu computador|no pc|no meu pc))?$/.exec(t) ??
    /\b(?:procura|procure|acha|ache|encontra|encontre|busca|busque)\b\s+(?:nos meus arquivos|no computador|no meu computador|no pc)\s+(?:a |o )?(?:(pasta|arquivo) )?(.+)$/.exec(t)
  if (fileAsk) {
    const kind = fileAsk[1] ?? ''
    let q = fileAsk[2].replace(/\s+e (abre|abra|mostra)$/, '').trim()
    // "... nos meus documentos" / "na área de trabalho" / "nos downloads"
    const LOCAIS = [
      [/\s+(?:nos meus documentos|nos documentos|em documentos|na pasta documentos|em meus documentos|dos meus documentos|dos documentos)$/, 'documentos'],
      [/\s+(?:na minha area de trabalho|na area de trabalho|no desktop|da area de trabalho)$/, 'area de trabalho'],
      [/\s+(?:nos meus downloads|nos downloads|em downloads|na pasta downloads|dos downloads)$/, 'downloads'],
      [/\s+(?:nas minhas imagens|nas imagens|nas fotos|nas minhas fotos)$/, 'imagens'],
      [/\s+(?:nos meus videos|nos videos)$/, 'videos'],
      [/\s+(?:no onedrive|no meu onedrive)$/, 'onedrive'],
    ]
    let local = ''
    for (const [re, nome] of LOCAIS) {
      if (re.test(q)) {
        q = q.replace(re, '').trim()
        local = nome
      }
    }
    // Pasta: procurar já abre. Arquivo: só abre se pedir.
    const wantsOpen = /^(abre|abra)\b/.test(t) || /\be (abre|abra)\b/.test(t) || kind === 'pasta'
    const named = userFolders()[q]
    if (named && kind === 'pasta') {
      if (allowOpen) opener(named)
      return [{ say: `Abrindo a pasta ${q}.` }]
    }
    q = R(q.replace(/^(chamad[ao]|de nome) /, ''))
    let hits = await findFiles(q, { onlyDirs: kind === 'pasta', local })
    if (!hits.length && local) hits = await findFiles(q, { onlyDirs: kind === 'pasta' })
    if (!hits.length) return [{ say: `Não encontrei ${kind || 'nada'} com o nome ${q} nas suas pastas, senhor.`, card: filesCard(q, hits) }]
    if (wantsOpen && allowOpen) {
      opener(hits[0].path)
      return [{ say: `Encontrei e abri ${hits[0].dir ? 'a pasta' : 'o arquivo'} ${hits[0].name}.`, card: filesCard(q, hits) }]
    }
    return [{ say: `Encontrei ${hits.length === 1 ? 'um resultado' : `${falarNumero(hits.length)} resultados`}. O primeiro é ${hits[0].name}, em ${basename(dirname(hits[0].path))}.`, card: filesCard(q, hits) }]
  }

  // ---- Google
  const g = /^(?:pesquisa|pesquise|procura|procure|busca|busque|googla|googlar)\s+(?:no google\s+)?(?:por |sobre )?(.+?)(?:\s+no google)?$/.exec(t)
  if (g && allowOpen) {
    const q = R(g[1].trim())
    opener(`https://www.google.com/search?q=${encodeURIComponent(q)}`)
    return [{ say: `Pesquisa de ${q} aberta no navegador.` }]
  }

  // ---- abrir site, programa ou pasta conhecida
  const open = /^(?:(?:me |pra mim |para mim )?(?:abre|abra|abrir|abri|inicia|inicie|liga|executa|execute|roda|rode|entra no|entra na|vai no|vai na|acessa|acesse|joga|jogar|quero jogar|vamos jogar|bora jogar|abre pra mim|abre para mim))\s+(?:o |a |os |as |meu |minha |o meu |a minha |site do |site da |o site do |o site da |o site |site )?(.+)$/.exec(t)
  if (open && allowOpen) {
    const what = open[1].replace(/^(pasta|programa|aplicativo|app|site) (de |do |da )?/, '').trim()
    if (SITES[what]) {
      opener(SITES[what])
      return [{ say: `Abrindo ${what}.` }]
    }
    const prog = PROGRAMAS[what]
    if (prog) {
      if (prog[0] === 'exe') runner(prog[1])
      else opener(prog[1])
      return [{ say: `Abrindo ${what}.` }]
    }
    const folder = userFolders()[what]
    if (folder) {
      opener(folder)
      return [{ say: `Abrindo a pasta ${what}.` }]
    }
    // Programa instalado: procura o atalho na Área de Trabalho e no Menu Iniciar.
    const prog2 = await acharPrograma(what.replace(/^(o |a |jogo |o jogo |programa |aplicativo |app )/, ''))
    if (prog2) {
      opener(prog2.path)
      return [{ say: `Abrindo ${prog2.nome}.` }]
    }
    if (/^[a-z0-9-]+( ?\. ?| ponto )(com|br|net|org|gov|jus|app|io)( ?\. ?| ponto )?(br)?$/.test(what)) {
      const host = what.replace(/ ponto /g, '.').replace(/\s/g, '')
      opener(`https://${host}`)
      return [{ say: `Abrindo ${host}.` }]
    }
    // Desconhecido: deixa o Claude decidir.
  }

  return null
}

// ------------------------------------------------------------------ briefing

function saudacao(t) {
  const h = new Date().getHours()
  if (/^boa noite/.test(t) || h >= 18) return 'Boa noite'
  if (/^boa tarde/.test(t) || h >= 12) return 'Boa tarde'
  return 'Bom dia'
}

/**
 * O "bom dia": hora, clima, as suas coisas (e-mails, redes — quando estiverem
 * conectadas), as manchetes rápidas e, no fim, a oferta do jornal do dia.
 */
async function briefing(t, cfg, state) {
  const now = new Date()
  const steps = []
  steps.push({
    say: `${saudacao(t)}, ${cfg.nome}. São ${falarHora(now)} de ${DIAS[now.getDay()]}, ${now.getDate() === 1 ? 'primeiro' : falarNumero(now.getDate())} de ${MESES[now.getMonth()]}.`,
    card: {
      kind: 'status',
      kicker: 'BRIEFING DIÁRIO',
      title: 'Atualizando o seu radar...',
      text: 'Clima, seus apps e as manchetes do dia.',
      chips: ['CLIMA', 'E-MAILS', 'REDES', 'MANCHETES', 'JORNAL'],
      active: 'CLIMA',
      transient: true,
    },
  })

  const [w, principais] = await Promise.all([
    weather(cfg, '').catch(() => null),
    news('', 6, cfg).catch(() => []),
  ])

  if (w) steps.push({ say: weatherSpeech(w), card: weatherCard(w) })

  // As suas coisas. Por enquanto nada conectado; quando estiver, cada app
  // entra aqui com o resumo dele (e-mails novos, LinkedIn, X...).
  const apps = cfg.apps ?? {}
  const conectados = Object.entries(apps).filter(([, v]) => v)
  steps.push({
    say: conectados.length ? '' : 'Seus e-mails, o LinkedIn e o Twitter ainda não estão conectados.',
    card: {
      kind: 'lista',
      kicker: 'SEUS APPS',
      title: conectados.length ? 'Atualizações' : 'Aguardando conexão',
      items: [
        { label: '✉ E-mails', sub: apps.email ? 'conectado' : 'não conectado' },
        { label: 'in LinkedIn', sub: apps.linkedin ? 'conectado' : 'não conectado' },
        { label: '𝕏 Twitter / X', sub: apps.twitter ? 'conectado' : 'não conectado' },
        { label: '📅 Agenda', sub: apps.agenda ? 'conectada' : 'não conectada' },
      ],
    },
  })

  let n = 0
  const ditas = []
  for (const it of principais) {
    if (n >= cfg.noticiasPorBriefing) break
    if (ditas.some((d) => parecidas(d, it.title))) continue
    ditas.push(it.title)
    steps.push({ say: `${n === 0 ? 'Nas manchetes: ' : ''}${it.title}.`, card: newsCard(it, 'MANCHETES') })
    n++
  }
  if (!w && !n) steps.push({ say: 'Receio que as fontes de clima e notícias não responderam agora.' })

  steps.push({
    say: 'Quer que eu leia o jornal do dia? São alguns minutos com política, direito, inteligência artificial, economia, o Pará e o mundo.',
    card: {
      kind: 'status',
      kicker: 'JORNAL DO DIA',
      title: 'Leitura de 10 minutos',
      text: 'Diga “sim” para eu começar, ou peça outra coisa.',
      chips: (cfg.jornal ?? []).map((s) => s.secao.toUpperCase()),
      transient: true,
    },
  })
  state.pending = 'jornal'
  return steps.filter((s) => s.say || s.card)
}

/** O jornal do dia, por seções, com resumo de cada notícia. */
async function jornal(cfg) {
  const secoes = cfg.jornal ?? []
  const listas = await Promise.all(
    secoes.map((sec) => news('', (sec.itens ?? 2) + 2, cfg, sec).catch(() => [])),
  )
  const steps = [
    {
      say: 'O jornal de hoje.',
      card: {
        kind: 'status',
        kicker: 'JORNAL DO DIA',
        title: new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }),
        text: 'Política, direito, economia, tecnologia e mais.',
        chips: secoes.map((s) => s.secao.toUpperCase()),
        transient: true,
      },
    },
  ]
  const usados = new Set()
  secoes.forEach((sec, i) => {
    const itens = []
    for (const it of listas[i]) {
      if ([...usados].some((u) => parecidas(u, it.title))) continue
      usados.add(it.title)
      itens.push(it)
      if (itens.length >= (sec.itens ?? 2)) break
    }
    itens.forEach((it, j) => {
      const abre = j === 0 ? `${sec.secao}. ` : ''
      const corpo = it.desc && norm(it.desc) !== norm(it.title) ? ` ${it.desc}` : ''
      steps.push({ say: `${abre}${it.title.replace(/[.!?]$/, '')}.${corpo}`, card: newsCard(it, '', `JORNAL · ${sec.secao.toUpperCase()}`) })
    })
  })
  if (steps.length === 1) return [{ say: 'Receio que as fontes do jornal não responderam agora, senhor.' }]
  steps.push({ say: 'Esse foi o jornal de hoje. Posso ajudar em mais alguma coisa?' })
  return steps
}


/**
 * O painel que aparece ao abrir o JARVIS: clima e notícias do dia, em
 * cartões, sem falar nada e sem gastar o Claude.
 */
export async function painelInicial(cfg) {
  const [w, principais, ia, politica] = await Promise.all([
    weather(cfg, '').catch(() => null),
    news('', 5, cfg).catch(() => []),
    news('inteligência artificial', 2, cfg).catch(() => []),
    news('', 2, cfg, { feeds: ['https://agenciabrasil.ebc.com.br/rss/politica/feed.xml'], buscas: ['Senado aprova', 'Câmara aprova'] }).catch(() => []),
  ])
  const cards = []
  if (w) cards.push(weatherCard(w))
  const vistas = []
  const add = (it, kicker) => {
    if (vistas.some((v) => parecidas(v, it.title))) return
    vistas.push(it.title)
    cards.push(newsCard(it, '', kicker))
  }
  principais.slice(0, 3).forEach((it) => add(it, 'MANCHETES DO DIA'))
  politica.slice(0, 1).forEach((it) => add(it, 'POLÍTICA'))
  ia.slice(0, 1).forEach((it) => add(it, 'INTELIGÊNCIA ARTIFICIAL'))
  cards.push({
    kind: 'status',
    kicker: 'JORNAL DO DIA',
    title: 'Diga “lê o jornal”',
    text: 'Leitura de alguns minutos: política, direito, IA, economia, Pará e mundo.',
    chips: ['POLÍTICA', 'DIREITO', 'IA', 'MUNDO'],
  })
  return cards
}
