/**
 * Google (Agenda, Gmail, Drive) pelas APIs oficiais, com OAuth 2.0 + PKCE.
 *
 * Você cria um "ID do cliente OAuth" no Google Cloud (tipo "Aplicativo da
 * Web"), com o redirecionamento ${PUBLIC_URL}/api/integracoes/google/retorno,
 * e coloca GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET no .env. Os tokens ficam
 * cifrados no banco (tabela integracoes) e podem ser revogados a qualquer
 * momento pelo painel.
 */
import { createHash } from 'node:crypto'
import { q } from '../db.mjs'
import { cifrar, decifrar, tokenAleatorio } from '../seguranca/cripto.mjs'

export const ESCOPOS_GOOGLE = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.readonly',
]

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const REVOGAR = 'https://oauth2.googleapis.com/revoke'

export function criarGoogle({ cfg, fetch: f = fetch }) {
  const configurado = Boolean(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET)
  const retorno = `${cfg.PUBLIC_URL.replace(/\/+$/, '')}/api/integracoes/google/retorno`

  async function iniciar(ownerId) {
    if (!configurado) throw new Error('Google não configurado: defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.')
    const estado = tokenAleatorio(24)
    const verificador = tokenAleatorio(48)
    const desafio = createHash('sha256').update(verificador).digest('base64url')
    await q(`INSERT INTO oauth_estados (estado, owner_id, provedor, verificador, expira) VALUES ($1, $2, 'google', $3, now() + interval '10 minutes')`, [estado, ownerId, verificador])
    const p = new URLSearchParams({
      client_id: cfg.GOOGLE_CLIENT_ID,
      redirect_uri: retorno,
      response_type: 'code',
      scope: ESCOPOS_GOOGLE.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: estado,
      code_challenge: desafio,
      code_challenge_method: 'S256',
    })
    return `${AUTH}?${p}`
  }

  async function concluir(ownerId, { code, state }) {
    const e = (await q(`DELETE FROM oauth_estados WHERE estado = $1 AND owner_id = $2 AND provedor = 'google' AND expira > now() RETURNING verificador`, [state, ownerId])).rows[0]
    if (!e) throw new Error('Pedido de conexão expirado ou inválido. Tente de novo.')
    const res = await f(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: cfg.GOOGLE_CLIENT_ID, client_secret: cfg.GOOGLE_CLIENT_SECRET, redirect_uri: retorno, grant_type: 'authorization_code', code_verifier: e.verificador }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(`Google recusou: ${j.error_description ?? j.error ?? res.status}`)
    let conta = ''
    try {
      conta = JSON.parse(Buffer.from(String(j.id_token).split('.')[1], 'base64url').toString()).email ?? ''
    } catch {}
    await guardar(ownerId, { access_token: j.access_token, refresh_token: j.refresh_token, expira: Date.now() + (j.expires_in ?? 3600) * 1000 }, String(j.scope ?? '').split(' '), conta)
    return { conta }
  }

  async function guardar(ownerId, tokens, escopos, conta) {
    await q(
      `INSERT INTO integracoes (owner_id, provedor, dados_cifrados, escopos, conta) VALUES ($1, 'google', $2, $3, $4)
       ON CONFLICT (owner_id, provedor) DO UPDATE SET dados_cifrados = EXCLUDED.dados_cifrados, escopos = CASE WHEN array_length(EXCLUDED.escopos, 1) > 0 THEN EXCLUDED.escopos ELSE integracoes.escopos END,
         conta = CASE WHEN EXCLUDED.conta <> '' THEN EXCLUDED.conta ELSE integracoes.conta END, atualizada = now()`,
      [ownerId, cifrar(JSON.stringify(tokens), cfg.chaveMestra), escopos ?? [], conta ?? ''],
    )
  }

  async function tokens(ownerId) {
    const r = (await q(`SELECT dados_cifrados FROM integracoes WHERE owner_id = $1 AND provedor = 'google'`, [ownerId])).rows[0]
    if (!r) return null
    return JSON.parse(decifrar(r.dados_cifrados, cfg.chaveMestra))
  }

  async function acesso(ownerId) {
    const t = await tokens(ownerId)
    if (!t) throw new Error('Google não conectado. Conecte em Configurações → Integrações.')
    if (t.expira - Date.now() > 60000) return t.access_token
    if (!t.refresh_token) throw new Error('A conexão com o Google expirou. Conecte de novo.')
    const res = await f(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.GOOGLE_CLIENT_ID, client_secret: cfg.GOOGLE_CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(`Não consegui renovar o acesso ao Google (${j.error ?? res.status}). Conecte de novo.`)
    const novo = { ...t, access_token: j.access_token, expira: Date.now() + (j.expires_in ?? 3600) * 1000 }
    await guardar(ownerId, novo)
    return novo.access_token
  }

  async function api(ownerId, url, opts = {}) {
    const tk = await acesso(ownerId)
    const res = await f(url, { ...opts, headers: { authorization: `Bearer ${tk}`, 'content-type': 'application/json', ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(20000) })
    if (res.status === 204) return {}
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Google API ${res.status}: ${j.error?.message ?? 'erro'}`)
    return j
  }

  async function desconectar(ownerId) {
    const t = await tokens(ownerId)
    if (t?.refresh_token || t?.access_token) {
      await f(REVOGAR, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }) }).catch(() => {})
    }
    await q(`DELETE FROM integracoes WHERE owner_id = $1 AND provedor = 'google'`, [ownerId])
  }

  // ---- Agenda
  const CAL = 'https://www.googleapis.com/calendar/v3'
  const agenda = {
    async listar(ownerId, { de, ate, max = 50 }) {
      const p = new URLSearchParams({ timeMin: new Date(de).toISOString(), timeMax: new Date(ate).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(max) })
      const j = await api(ownerId, `${CAL}/calendars/primary/events?${p}`)
      return (j.items ?? []).map((e) => ({ id: e.id, titulo: e.summary ?? '(sem título)', local: e.location ?? '', inicio: e.start?.dateTime ?? e.start?.date, fim: e.end?.dateTime ?? e.end?.date, diaTodo: Boolean(e.start?.date), link: e.htmlLink }))
    },
    async livres(ownerId, { de, ate, tz }) {
      const j = await api(ownerId, `${CAL}/freeBusy`, { method: 'POST', body: JSON.stringify({ timeMin: new Date(de).toISOString(), timeMax: new Date(ate).toISOString(), timeZone: tz, items: [{ id: 'primary' }] }) })
      return j.calendars?.primary?.busy ?? []
    },
    async criar(ownerId, { titulo, inicio, fim, descricao, tz }) {
      const j = await api(ownerId, `${CAL}/calendars/primary/events`, { method: 'POST', body: JSON.stringify({ summary: titulo, description: descricao, start: { dateTime: inicio, timeZone: tz }, end: { dateTime: fim, timeZone: tz } }) })
      return { id: j.id, link: j.htmlLink }
    },
    async alterar(ownerId, { id, titulo, inicio, fim, tz }) {
      const corpo = {}
      if (titulo) corpo.summary = titulo
      if (inicio) corpo.start = { dateTime: inicio, timeZone: tz }
      if (fim) corpo.end = { dateTime: fim, timeZone: tz }
      const j = await api(ownerId, `${CAL}/calendars/primary/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(corpo) })
      return { id: j.id, link: j.htmlLink }
    },
    async cancelar(ownerId, { id }) {
      await api(ownerId, `${CAL}/calendars/primary/events/${encodeURIComponent(id)}`, { method: 'DELETE' })
      return { ok: true }
    },
  }

  // ---- Gmail
  const GM = 'https://gmail.googleapis.com/gmail/v1/users/me'
  const cab = (m, n) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? ''
  const email = {
    async buscar(ownerId, { consulta = 'in:inbox', max = 10 }) {
      const j = await api(ownerId, `${GM}/messages?${new URLSearchParams({ q: consulta, maxResults: String(Math.min(max, 25)) })}`)
      const out = []
      for (const m of j.messages ?? []) {
        const d = await api(ownerId, `${GM}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
        out.push({ id: d.id, conversa: d.threadId, de: cab(d, 'from'), assunto: cab(d, 'subject'), data: cab(d, 'date'), trecho: d.snippet ?? '', naoLido: (d.labelIds ?? []).includes('UNREAD') })
      }
      return out
    },
    async ler(ownerId, { id }) {
      const d = await api(ownerId, `${GM}/messages/${encodeURIComponent(id)}?format=full`)
      const partes = []
      const andar = (p) => {
        if (!p) return
        if (p.mimeType === 'text/plain' && p.body?.data) partes.push(Buffer.from(p.body.data, 'base64url').toString('utf8'))
        for (const x of p.parts ?? []) andar(x)
      }
      andar(d.payload)
      return { id: d.id, de: cab(d, 'from'), para: cab(d, 'to'), assunto: cab(d, 'subject'), data: cab(d, 'date'), corpo: (partes.join('\n') || d.snippet || '').slice(0, 8000), mensagemId: cab(d, 'message-id'), conversa: d.threadId }
    },
    montar({ para, assunto, corpo, emRespostaA }) {
      const linhas = [`To: ${para}`, `Subject: =?UTF-8?B?${Buffer.from(assunto).toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit']
      if (emRespostaA) linhas.push(`In-Reply-To: ${emRespostaA}`, `References: ${emRespostaA}`)
      return Buffer.from(`${linhas.join('\r\n')}\r\n\r\n${corpo}`).toString('base64url')
    },
    async rascunho(ownerId, args) {
      const j = await api(ownerId, `${GM}/drafts`, { method: 'POST', body: JSON.stringify({ message: { raw: email.montar(args), ...(args.conversa ? { threadId: args.conversa } : {}) } }) })
      return { id: j.id }
    },
    async enviar(ownerId, args) {
      const j = await api(ownerId, `${GM}/messages/send`, { method: 'POST', body: JSON.stringify({ raw: email.montar(args), ...(args.conversa ? { threadId: args.conversa } : {}) }) })
      return { id: j.id }
    },
  }

  // ---- Drive
  const drive = {
    async buscar(ownerId, { consulta, max = 10 }) {
      const termo = String(consulta).replace(/['\\]/g, ' ')
      const p = new URLSearchParams({ q: `fullText contains '${termo}' and trashed = false`, pageSize: String(Math.min(max, 25)), fields: 'files(id,name,mimeType,modifiedTime,webViewLink)' })
      const j = await api(ownerId, `https://www.googleapis.com/drive/v3/files?${p}`)
      return (j.files ?? []).map((x) => ({ id: x.id, nome: x.name, tipo: x.mimeType, modificado: x.modifiedTime, link: x.webViewLink }))
    },
  }

  async function estado(ownerId) {
    const r = (await q(`SELECT conta, escopos, atualizada FROM integracoes WHERE owner_id = $1 AND provedor = 'google'`, [ownerId])).rows[0]
    return { configurado, conectado: Boolean(r), conta: r?.conta ?? '', escopos: r?.escopos ?? [] }
  }

  return { configurado, iniciar, concluir, desconectar, estado, conectado: async (o) => Boolean(await tokens(o).catch(() => null)), agenda, email, drive }
}
