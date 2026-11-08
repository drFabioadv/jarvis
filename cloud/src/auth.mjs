/**
 * Acesso exclusivo do proprietário.
 *
 * - Cadastro: só existe UMA conta. Ela é criada com um código de configuração
 *   de uso único gerado no servidor (npm run owner:setup-token). Depois disso
 *   a rota de cadastro deixa de existir na prática.
 * - Login: e-mail + senha (scrypt) + segundo fator (TOTP) — ou passkey.
 * - Sessões: cookie httpOnly/Secure/SameSite=Strict; no banco só o hash.
 *   Expiram por tempo e por inatividade; podem ser revogadas (dispositivos).
 * - Força bruta: limite por IP e por conta, com bloqueio progressivo.
 * - Recuperação: 10 códigos de uso único gerados ao ativar o TOTP.
 * - Tudo vai para a auditoria (sem segredos).
 */
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import { z } from 'zod'
import { q, transacao } from './db.mjs'
import { auditar } from './seguranca/auditoria.mjs'
import { cifrar, conferirSenha, conferirTotp, decifrar, hashSenha, novoSegredoTotp, sha256, tokenAleatorio, uriTotp } from './seguranca/cripto.mjs'

const COOKIE = 'jv_sessao'

export async function existeProprietario() {
  return (await q('SELECT 1 FROM owners LIMIT 1')).rowCount > 0
}

export async function gerarCodigoSetup() {
  if (await existeProprietario()) throw new Error('o proprietário já existe; o cadastro está fechado')
  const codigo = tokenAleatorio(18)
  await q(`INSERT INTO codigos_setup (hash, expira) VALUES ($1, now() + interval '1 hour')`, [sha256(codigo)])
  return codigo
}

/** Limite de tentativas: 5 por conta e 20 por IP a cada 15 min, com espera crescente. */
async function bloqueado(chaves) {
  for (const [chave, max] of chaves) {
    const n = (await q(`SELECT count(*)::int AS n FROM tentativas_login WHERE chave = $1 AND em > now() - interval '15 minutes'`, [chave])).rows[0].n
    if (n >= max) return true
  }
  return false
}
const falhou = (chaves) => Promise.all(chaves.map(([c]) => q('INSERT INTO tentativas_login (chave) VALUES ($1)', [c])))

export function registrarAuth(app, { cfg }) {
  const segura = cfg.https
  const opcoesCookie = (maxAgeS) => ({ path: '/', httpOnly: true, secure: segura, sameSite: 'strict', maxAge: maxAgeS })
  const origem = new URL(cfg.PUBLIC_URL).origin

  async function criarSessao(reply, req, ownerId, mfa) {
    const token = tokenAleatorio(32)
    const dias = cfg.JARVIS_SESSAO_DIAS
    await q(`INSERT INTO sessoes (id, owner_id, dispositivo, ip, mfa, expira) VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)`, [sha256(token), ownerId, String(req.headers['user-agent'] ?? '').slice(0, 200), req.ip, mfa, String(dias)])
    reply.setCookie(COOKIE, token, opcoesCookie(dias * 86400))
  }

  /** Lê a sessão do cookie; renova a atividade. */
  async function sessaoDe(req) {
    const token = req.cookies?.[COOKIE]
    if (!token) return null
    const s = (
      await q(
        `UPDATE sessoes SET ultima_atividade = now() WHERE id = $1 AND NOT revogada AND expira > now() AND ultima_atividade > now() - ($2 || ' days')::interval
         RETURNING id, owner_id, mfa`,
        [sha256(token), String(cfg.JARVIS_SESSAO_INATIVA_DIAS)],
      )
    ).rows[0]
    return s ?? null
  }

  async function temSegundoFator(ownerId) {
    const r = (await q(`SELECT totp_ativo, (SELECT count(*)::int FROM passkeys WHERE owner_id = $1) AS pk FROM owners WHERE id = $1`, [ownerId])).rows[0]
    return Boolean(r?.totp_ativo || r?.pk > 0)
  }

  /**
   * Middleware: exige sessão. Com JARVIS_EXIGIR_MFA, enquanto o proprietário
   * não tiver segundo fator, só deixa usar as rotas de segurança da conta.
   */
  async function exigirSessao(req, reply) {
    const s = await sessaoDe(req)
    if (!s) return reply.code(401).send({ erro: 'sessão necessária' })
    req.ownerId = s.owner_id
    req.sessaoId = s.id
    req.sessaoMfa = s.mfa
    if (cfg.JARVIS_EXIGIR_MFA && !req.url.startsWith('/api/auth/')) {
      if (!(await temSegundoFator(s.owner_id))) return reply.code(403).send({ erro: 'ative o segundo fator (aplicativo autenticador ou passkey) para continuar', mfaPendente: true })
      if (!s.mfa) return reply.code(403).send({ erro: 'entre de novo usando o segundo fator', mfaPendente: true })
    }
  }

  // CSRF: além do SameSite=Strict, toda requisição que muda algo precisa do
  // cabeçalho x-jarvis (um site de fora não consegue mandá-lo sem CORS, que
  // não liberamos) e, se houver Origin, ela precisa ser a nossa.
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.url.startsWith('/api/')) return
    if (req.url.startsWith('/api/dispositivos/parear')) return
    if (req.headers['x-jarvis'] !== '1') return reply.code(403).send({ erro: 'requisição sem o cabeçalho de proteção' })
    const o = req.headers.origin
    if (o && o !== origem) return reply.code(403).send({ erro: 'origem não permitida' })
  })

  // ---------------------------------------------------------------- estado
  app.get('/api/auth/estado', async (req) => {
    const s = await sessaoDe(req)
    const existe = await existeProprietario()
    if (!s) return { proprietario: existe, logado: false }
    const o = (await q('SELECT id, email, nome, totp_ativo FROM owners WHERE id = $1', [s.owner_id])).rows[0]
    const pk = (await q('SELECT count(*)::int AS n FROM passkeys WHERE owner_id = $1', [s.owner_id])).rows[0].n
    return { proprietario: true, logado: true, email: o.email, nome: o.nome, totp: o.totp_ativo, passkeys: pk, mfaSessao: s.mfa, exigirMfa: cfg.JARVIS_EXIGIR_MFA }
  })

  // ---------------------------------------------------------------- cadastro único
  const Setup = z.object({ codigo: z.string().min(10), email: z.email(), nome: z.string().min(1).max(80), senha: z.string().min(10).max(200) })
  app.post('/api/auth/setup', { config: { rateLimit: true } }, async (req, reply) => {
    const d = Setup.safeParse(req.body)
    if (!d.success) return reply.code(400).send({ erro: 'dados inválidos (senha com no mínimo 10 caracteres)' })
    if (await bloqueado([[`setup:${req.ip}`, 5]])) return reply.code(429).send({ erro: 'muitas tentativas; espere 15 minutos' })
    const hash = await hashSenha(d.data.senha)
    try {
      const ownerId = await transacao(async (c) => {
        if ((await c.query('SELECT 1 FROM owners LIMIT 1')).rowCount) throw Object.assign(new Error('fechado'), { codigo: 403 })
        const cod = (await c.query(`UPDATE codigos_setup SET usado = true WHERE hash = $1 AND NOT usado AND expira > now() RETURNING hash`, [sha256(d.data.codigo)])).rows[0]
        if (!cod) throw Object.assign(new Error('código'), { codigo: 401 })
        const o = await c.query(`INSERT INTO owners (email, nome, senha_hash) VALUES (lower($1), $2, $3) RETURNING id`, [d.data.email, d.data.nome, hash])
        await c.query('INSERT INTO config_owner (owner_id, dados) VALUES ($1, $2)', [o.rows[0].id, {}])
        return o.rows[0].id
      })
      await auditar(ownerId, 'proprietario_criado', {}, req.ip)
      await criarSessao(reply, req, ownerId, false)
      return { ok: true }
    } catch (err) {
      if (err.codigo === 403) return reply.code(403).send({ erro: 'o cadastro está fechado' })
      if (err.codigo === 401) {
        await falhou([[`setup:${req.ip}`]])
        return reply.code(401).send({ erro: 'código de configuração inválido ou expirado' })
      }
      throw err
    }
  })

  // ---------------------------------------------------------------- login
  const Login = z.object({ email: z.email(), senha: z.string().min(1).max(200), codigo: z.string().max(40).optional() })
  app.post('/api/auth/login', async (req, reply) => {
    const d = Login.safeParse(req.body)
    if (!d.success) return reply.code(400).send({ erro: 'dados inválidos' })
    const email = d.data.email.toLowerCase()
    const chaves = [[`ip:${req.ip}`, 20], [`conta:${email}`, 5]]
    if (await bloqueado(chaves)) {
      await auditar(null, 'login_bloqueado', { email }, req.ip)
      return reply.code(429).send({ erro: 'muitas tentativas; espere 15 minutos' })
    }
    const o = (await q('SELECT * FROM owners WHERE email = $1', [email])).rows[0]
    // Mesmo sem conta, gasta o tempo do scrypt (não revela se o e-mail existe).
    const okSenha = await conferirSenha(d.data.senha, o?.senha_hash ?? 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86))
    if (!o || !okSenha) {
      await falhou(chaves)
      await auditar(o?.id ?? null, 'login_falhou', { motivo: 'senha' }, req.ip)
      return reply.code(401).send({ erro: 'e-mail ou senha incorretos' })
    }
    let mfa = false
    if (o.totp_ativo) {
      if (!d.data.codigo) return { segundoFator: true }
      const cod = d.data.codigo.trim()
      const segredo = decifrar(o.totp_cifrado, cfg.chaveMestra)
      if (conferirTotp(segredo, cod)) mfa = true
      else {
        // Código de recuperação (uso único)
        const rec = (await q(`UPDATE codigos_recuperacao SET usado = now() WHERE owner_id = $1 AND hash = $2 AND usado IS NULL RETURNING hash`, [o.id, sha256(cod.replace(/[\s-]/g, '').toUpperCase())])).rows[0]
        if (!rec) {
          await falhou(chaves)
          await auditar(o.id, 'login_falhou', { motivo: 'segundo fator' }, req.ip)
          return reply.code(401).send({ erro: 'código do autenticador inválido' })
        }
        mfa = true
        await auditar(o.id, 'codigo_recuperacao_usado', {}, req.ip)
      }
    }
    await criarSessao(reply, req, o.id, mfa)
    await auditar(o.id, 'login', { mfa }, req.ip)
    return { ok: true, mfa }
  })

  app.post('/api/auth/sair', async (req, reply) => {
    const s = await sessaoDe(req)
    if (s) {
      await q('UPDATE sessoes SET revogada = true WHERE id = $1', [s.id])
      await auditar(s.owner_id, 'logout', {}, req.ip)
    }
    reply.clearCookie(COOKIE, { path: '/' })
    return { ok: true }
  })

  // ---------------------------------------------------------------- TOTP
  app.post('/api/auth/totp/iniciar', { preHandler: exigirSessao }, async (req) => {
    const o = (await q('SELECT email FROM owners WHERE id = $1', [req.ownerId])).rows[0]
    const segredo = novoSegredoTotp()
    await q('UPDATE owners SET totp_cifrado = $2 WHERE id = $1 AND NOT totp_ativo', [req.ownerId, cifrar(segredo, cfg.chaveMestra)])
    return { segredo, uri: uriTotp(segredo, o.email) }
  })
  app.post('/api/auth/totp/confirmar', { preHandler: exigirSessao }, async (req, reply) => {
    const o = (await q('SELECT totp_cifrado, totp_ativo FROM owners WHERE id = $1', [req.ownerId])).rows[0]
    if (o.totp_ativo) return reply.code(409).send({ erro: 'o autenticador já está ativo' })
    if (!o.totp_cifrado || !conferirTotp(decifrar(o.totp_cifrado, cfg.chaveMestra), req.body?.codigo)) return reply.code(400).send({ erro: 'código incorreto' })
    const codigos = Array.from({ length: 10 }, () => tokenAleatorio(8).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase())
    await transacao(async (c) => {
      await c.query('UPDATE owners SET totp_ativo = true WHERE id = $1', [req.ownerId])
      await c.query('DELETE FROM codigos_recuperacao WHERE owner_id = $1', [req.ownerId])
      for (const cod of codigos) await c.query('INSERT INTO codigos_recuperacao (owner_id, hash) VALUES ($1, $2)', [req.ownerId, sha256(cod)])
      await c.query('UPDATE sessoes SET mfa = true WHERE id = $1', [req.sessaoId])
    })
    await auditar(req.ownerId, 'totp_ativado', {}, req.ip)
    return { ok: true, codigosRecuperacao: codigos }
  })

  // ---------------------------------------------------------------- passkeys
  const rp = { rpName: 'J.A.R.V.I.S.', rpID: cfg.rpId }
  app.post('/api/auth/passkey/registro/opcoes', { preHandler: exigirSessao }, async (req) => {
    const o = (await q('SELECT email, nome FROM owners WHERE id = $1', [req.ownerId])).rows[0]
    const existentes = (await q('SELECT id, transportes FROM passkeys WHERE owner_id = $1', [req.ownerId])).rows
    const opts = await generateRegistrationOptions({
      ...rp,
      userName: o.email,
      userDisplayName: o.nome,
      attestationType: 'none',
      excludeCredentials: existentes.map((p) => ({ id: p.id, transports: p.transportes })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    })
    const id = tokenAleatorio(16)
    await q(`INSERT INTO desafios_webauthn (id, desafio, owner_id, tipo, expira) VALUES ($1, $2, $3, 'registro', now() + interval '5 minutes')`, [id, opts.challenge, req.ownerId])
    return { id, opcoes: opts }
  })
  app.post('/api/auth/passkey/registro/verificar', { preHandler: exigirSessao }, async (req, reply) => {
    const d = (await q(`DELETE FROM desafios_webauthn WHERE id = $1 AND owner_id = $2 AND tipo = 'registro' AND expira > now() RETURNING desafio`, [req.body?.id, req.ownerId])).rows[0]
    if (!d) return reply.code(400).send({ erro: 'desafio expirado' })
    let v
    try {
      v = await verifyRegistrationResponse({ response: req.body.resposta, expectedChallenge: d.desafio, expectedOrigin: origem, expectedRPID: cfg.rpId, requireUserVerification: true })
    } catch (err) {
      return reply.code(400).send({ erro: `passkey recusada: ${err.message}` })
    }
    if (!v.verified) return reply.code(400).send({ erro: 'passkey não verificada' })
    const c = v.registrationInfo.credential
    await q(`INSERT INTO passkeys (id, owner_id, chave_publica, contador, transportes, nome) VALUES ($1, $2, $3, $4, $5, $6)`, [c.id, req.ownerId, Buffer.from(c.publicKey), c.counter, c.transports ?? [], String(req.body.nome ?? 'Passkey').slice(0, 60)])
    await q('UPDATE sessoes SET mfa = true WHERE id = $1', [req.sessaoId])
    await auditar(req.ownerId, 'passkey_registrada', {}, req.ip)
    return { ok: true }
  })
  app.post('/api/auth/passkey/login/opcoes', async (req, reply) => {
    if (await bloqueado([[`ip:${req.ip}`, 20]])) return reply.code(429).send({ erro: 'muitas tentativas; espere 15 minutos' })
    const opts = await generateAuthenticationOptions({ rpID: cfg.rpId, userVerification: 'required' })
    const id = tokenAleatorio(16)
    await q(`INSERT INTO desafios_webauthn (id, desafio, tipo, expira) VALUES ($1, $2, 'login', now() + interval '5 minutes')`, [id, opts.challenge])
    return { id, opcoes: opts }
  })
  app.post('/api/auth/passkey/login/verificar', async (req, reply) => {
    const d = (await q(`DELETE FROM desafios_webauthn WHERE id = $1 AND tipo = 'login' AND expira > now() RETURNING desafio`, [req.body?.id])).rows[0]
    const pk = req.body?.resposta?.id ? (await q('SELECT * FROM passkeys WHERE id = $1', [req.body.resposta.id])).rows[0] : null
    if (!d || !pk) {
      await falhou([[`ip:${req.ip}`]])
      return reply.code(401).send({ erro: 'passkey não reconhecida' })
    }
    let v
    try {
      v = await verifyAuthenticationResponse({ response: req.body.resposta, expectedChallenge: d.desafio, expectedOrigin: origem, expectedRPID: cfg.rpId, requireUserVerification: true, credential: { id: pk.id, publicKey: new Uint8Array(pk.chave_publica), counter: Number(pk.contador), transports: pk.transportes } })
    } catch (err) {
      await falhou([[`ip:${req.ip}`]])
      return reply.code(401).send({ erro: `passkey recusada: ${err.message}` })
    }
    if (!v.verified) return reply.code(401).send({ erro: 'passkey não verificada' })
    await q('UPDATE passkeys SET contador = $2, ultimo_uso = now() WHERE id = $1', [pk.id, v.authenticationInfo.newCounter])
    await criarSessao(reply, req, pk.owner_id, true)
    await auditar(pk.owner_id, 'login', { metodo: 'passkey' }, req.ip)
    return { ok: true }
  })

  // ---------------------------------------------------------------- sessões e dispositivos
  app.get('/api/auth/sessoes', { preHandler: exigirSessao }, async (req) => {
    const r = await q(`SELECT id, dispositivo, ip, mfa, criada, ultima_atividade, expira FROM sessoes WHERE owner_id = $1 AND NOT revogada AND expira > now() ORDER BY ultima_atividade DESC`, [req.ownerId])
    return r.rows.map((s) => ({ ...s, id: s.id.slice(0, 16), atual: s.id === req.sessaoId }))
  })
  app.delete('/api/auth/sessoes/:id', { preHandler: exigirSessao }, async (req) => {
    const r = await q(`UPDATE sessoes SET revogada = true WHERE owner_id = $1 AND left(id, 16) = $2 RETURNING id`, [req.ownerId, String(req.params.id)])
    await auditar(req.ownerId, 'sessao_revogada', {}, req.ip)
    return { ok: r.rowCount > 0 }
  })
  app.post('/api/auth/sessoes/encerrar-outras', { preHandler: exigirSessao }, async (req) => {
    const r = await q(`UPDATE sessoes SET revogada = true WHERE owner_id = $1 AND id <> $2 AND NOT revogada`, [req.ownerId, req.sessaoId])
    await auditar(req.ownerId, 'sessoes_revogadas', { quantidade: r.rowCount }, req.ip)
    return { encerradas: r.rowCount }
  })
  app.get('/api/auth/passkeys', { preHandler: exigirSessao }, async (req) => (await q('SELECT id, nome, criada, ultimo_uso FROM passkeys WHERE owner_id = $1', [req.ownerId])).rows)
  app.delete('/api/auth/passkeys/:id', { preHandler: exigirSessao }, async (req) => {
    await q('DELETE FROM passkeys WHERE owner_id = $1 AND id = $2', [req.ownerId, req.params.id])
    await auditar(req.ownerId, 'passkey_removida', {}, req.ip)
    return { ok: true }
  })
  app.get('/api/auth/acessos', { preHandler: exigirSessao }, async (req) => (await q(`SELECT acao, detalhes, ip, em FROM auditoria WHERE owner_id = $1 OR (owner_id IS NULL AND acao LIKE 'login%') ORDER BY em DESC LIMIT 100`, [req.ownerId])).rows)
  app.post('/api/auth/senha', { preHandler: exigirSessao }, async (req, reply) => {
    const o = (await q('SELECT senha_hash FROM owners WHERE id = $1', [req.ownerId])).rows[0]
    if (!(await conferirSenha(String(req.body?.atual ?? ''), o.senha_hash))) return reply.code(401).send({ erro: 'senha atual incorreta' })
    await q('UPDATE owners SET senha_hash = $2 WHERE id = $1', [req.ownerId, await hashSenha(String(req.body?.nova ?? ''))])
    await q('UPDATE sessoes SET revogada = true WHERE owner_id = $1 AND id <> $2', [req.ownerId, req.sessaoId])
    await auditar(req.ownerId, 'senha_trocada', {}, req.ip)
    return { ok: true }
  })

  return { exigirSessao, sessaoDe }
}
