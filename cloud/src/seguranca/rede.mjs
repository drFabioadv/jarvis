/**
 * Acesso à internet com proteção contra SSRF: só http/https, porta padrão,
 * o nome é resolvido e TODOS os endereços precisam ser públicos (nada de
 * 127.x, 10.x, 192.168.x, 169.254.x — metadados de nuvem —, IPv6 local...).
 * Cada redirecionamento é conferido de novo. Tamanho e tempo limitados.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const V4_PRIVADO = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
  [0xe0000000, 4], [0xf0000000, 4],
]

function v4(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
}

export function enderecoPrivado(ip) {
  if (isIP(ip) === 4) {
    const n = v4(ip)
    return V4_PRIVADO.some(([base, bits]) => (n & (~0 << (32 - bits))) >>> 0 === base)
  }
  const s = ip.toLowerCase()
  if (s === '::' || s === '::1') return true
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (m) return enderecoPrivado(m[1])
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8')
}

export async function conferirUrl(bruta, { resolver = lookup } = {}) {
  let u
  try {
    u = new URL(bruta)
  } catch {
    throw new Error('endereço inválido')
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('só http e https')
  if (u.username || u.password) throw new Error('endereço com usuário/senha não é aceito')
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('porta não permitida')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw new Error('endereço interno bloqueado')
  const ips = isIP(host) ? [{ address: host }] : await resolver(host, { all: true, verbatim: true })
  if (!ips.length || ips.some((x) => enderecoPrivado(x.address))) throw new Error('endereço interno bloqueado')
  return u
}

/** fetch seguro para conteúdo da internet (não confiável). */
export async function buscarSeguro(url, { maxBytes = 2_000_000, timeoutMs = 15000, cabecalhos = {}, fetch: f = fetch, resolver } = {}) {
  let atual = url
  for (let i = 0; i < 4; i++) {
    const u = await conferirUrl(atual, { resolver })
    const res = await f(u, {
      redirect: 'manual',
      headers: { 'user-agent': 'JARVIS/3.0 (+assistente pessoal)', accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.5', ...cabecalhos },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      atual = new URL(res.headers.get('location'), u).toString()
      continue
    }
    const tipo = res.headers.get('content-type') ?? ''
    const partes = []
    let total = 0
    for await (const p of res.body ?? []) {
      total += p.length
      if (total > maxBytes) break
      partes.push(p)
    }
    return { status: res.status, url: u.toString(), tipo, texto: Buffer.concat(partes).toString('utf8') }
  }
  throw new Error('redirecionamentos demais')
}

/** HTML → texto legível (para o modelo ler). */
export function htmlParaTexto(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/** Embrulha conteúdo de fora: o modelo é instruído a nunca obedecer o que vier aqui. */
export function naoConfiavel(origem, texto, max = 6000) {
  const limpo = String(texto ?? '').replace(/<<\/?conteudo_externo[^>]*>>/g, '').slice(0, max)
  return `<<conteudo_externo origem="${String(origem).slice(0, 200)}">>\n${limpo}\n<</conteudo_externo>>`
}
