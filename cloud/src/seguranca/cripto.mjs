/**
 * Criptografia do JARVIS: senhas (scrypt), segredos em repouso (AES-256-GCM
 * com a chave mestra), tokens aleatórios, TOTP (RFC 6238) e comparação em
 * tempo constante. Só a biblioteca padrão do Node.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)
const N = 2 ** 15

export async function hashSenha(senha) {
  if (typeof senha !== 'string' || senha.length < 10) throw new Error('A senha precisa ter pelo menos 10 caracteres.')
  const sal = randomBytes(16)
  const h = await scrypt(senha.normalize('NFKC'), sal, 64, { N, r: 8, p: 1, maxmem: 128 * N * 8 * 2 })
  return `scrypt$${N}$${sal.toString('base64')}$${h.toString('base64')}`
}

export async function conferirSenha(senha, guardado) {
  const [alg, n, sal, h] = String(guardado ?? '').split('$')
  if (alg !== 'scrypt' || typeof senha !== 'string') return false
  const esperado = Buffer.from(h, 'base64')
  const r = await scrypt(senha.normalize('NFKC'), Buffer.from(sal, 'base64'), esperado.length, { N: Number(n), r: 8, p: 1, maxmem: 128 * Number(n) * 8 * 2 })
  return timingSafeEqual(r, esperado)
}

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex')
export const tokenAleatorio = (bytes = 32) => randomBytes(bytes).toString('base64url')

export function iguais(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Cifra (AES-256-GCM): "v1.<iv>.<tag>.<dados>" em base64url. */
export function cifrar(texto, chave) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', chave, iv)
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()])
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), dados.toString('base64url')].join('.')
}

export function decifrar(pacote, chave) {
  const [v, iv, tag, dados] = String(pacote).split('.')
  if (v !== 'v1') throw new Error('formato de segredo desconhecido')
  const d = createDecipheriv('aes-256-gcm', chave, Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(dados, 'base64url')), d.final()]).toString('utf8')
}

// ---- TOTP (Google Authenticator, Authy, 1Password...)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32(buf) {
  let bits = 0
  let valor = 0
  let out = ''
  for (const b of buf) {
    valor = (valor << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(valor >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(valor << (5 - bits)) & 31]
  return out
}
export function deBase32(s) {
  const limpo = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let valor = 0
  const out = []
  for (const ch of limpo) {
    valor = (valor << 5) | B32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((valor >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export const novoSegredoTotp = () => base32(randomBytes(20))

export function codigoTotp(segredo, quando = Date.now(), passo = 30) {
  const contador = Math.floor(quando / 1000 / passo)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(contador))
  const h = createHmac('sha1', deBase32(segredo)).update(msg).digest()
  const o = h[h.length - 1] & 15
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 1e6).padStart(6, '0')
}

/** Aceita o código atual e um passo antes/depois (relógio do celular). */
export function conferirTotp(segredo, codigo, quando = Date.now()) {
  const c = String(codigo ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(c)) return false
  return [-1, 0, 1].some((d) => iguais(codigoTotp(segredo, quando + d * 30000), c))
}

export function uriTotp(segredo, conta, emissor = 'JARVIS') {
  return `otpauth://totp/${encodeURIComponent(emissor)}:${encodeURIComponent(conta)}?secret=${segredo}&issuer=${encodeURIComponent(emissor)}&algorithm=SHA1&digits=6&period=30`
}
