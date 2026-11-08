import { useEffect, useState, type ReactNode } from 'react'
import { api, decidir, useNuvem } from '../lib/cloud'

/**
 * JARVIS 3.0 na nuvem: a porta de entrada (cadastro único do proprietário,
 * login com senha + autenticador ou passkey, ativação do segundo fator) e o
 * painel da conta (sessões, passkeys, computadores, notificações,
 * integrações, consumo de IA, exportar/importar dados).
 */

type Estado = { proprietario: boolean; logado: boolean; email?: string; nome?: string; totp?: boolean; passkeys?: number; mfaSessao?: boolean; exigirMfa?: boolean }

// ---- WebAuthn (passkeys): conversões base64url ↔ ArrayBuffer
const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0))
const deB = (b: ArrayBuffer | null) => (b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : undefined)

async function passkeyCriar(nome: string) {
  const { id, opcoes } = await api<{ id: string; opcoes: any }>('/api/auth/passkey/registro/opcoes', { method: 'POST', body: {} })
  const cred = (await navigator.credentials.create({
    publicKey: { ...opcoes, challenge: b64(opcoes.challenge), user: { ...opcoes.user, id: b64(opcoes.user.id) }, excludeCredentials: (opcoes.excludeCredentials ?? []).map((c: any) => ({ ...c, id: b64(c.id) })) },
  })) as PublicKeyCredential
  const r = cred.response as AuthenticatorAttestationResponse
  const resposta = { id: cred.id, rawId: deB(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), response: { clientDataJSON: deB(r.clientDataJSON), attestationObject: deB(r.attestationObject), transports: r.getTransports?.() ?? [] } }
  await api('/api/auth/passkey/registro/verificar', { method: 'POST', body: { id, resposta, nome } })
}

async function passkeyEntrar() {
  const { id, opcoes } = await api<{ id: string; opcoes: any }>('/api/auth/passkey/login/opcoes', { method: 'POST', body: {} })
  const cred = (await navigator.credentials.get({ publicKey: { ...opcoes, challenge: b64(opcoes.challenge), allowCredentials: (opcoes.allowCredentials ?? []).map((c: any) => ({ ...c, id: b64(c.id) })) } })) as PublicKeyCredential
  const r = cred.response as AuthenticatorAssertionResponse
  const resposta = { id: cred.id, rawId: deB(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), response: { clientDataJSON: deB(r.clientDataJSON), authenticatorData: deB(r.authenticatorData), signature: deB(r.signature), userHandle: deB(r.userHandle) } }
  await api('/api/auth/passkey/login/verificar', { method: 'POST', body: { id, resposta } })
}

// ---- PWA: service worker e notificações push
export async function registrarSw() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    // Versão nova do app: ativa sozinha e recarrega uma vez, sem perder dados.
    reg.addEventListener('updatefound', () => {
      const novo = reg.installing
      novo?.addEventListener('statechange', () => {
        if (novo.state === 'activated' && navigator.serviceWorker.controller) location.reload()
      })
    })
    return reg
  } catch {
    return null
  }
}

async function ativarPush() {
  const { ativo, chave } = await api<{ ativo: boolean; chave: string }>('/api/push/chave')
  if (!ativo) throw new Error('Notificações ainda não configuradas no servidor (chaves VAPID).')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permissão de notificação negada.')
  const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(chave) })
  await api('/api/push/inscrever', { method: 'POST', body: { inscricao: sub.toJSON() } })
  await api('/api/push/teste', { method: 'POST', body: {} })
}

function Caixa({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="np-fundo">
      <div className="np-caixa">
        <div className="np-logo">J.A.R.V.I.S.</div>
        <div className="np-tit">{titulo}</div>
        {children}
      </div>
    </div>
  )
}

function Entrar({ estado, aoEntrar }: { estado: Estado; aoEntrar: () => void }) {
  const [f, setF] = useState({ codigo: '', email: '', nome: '', senha: '', otp: '' })
  const [pedeOtp, setPedeOtp] = useState(false)
  const [msg, setMsg] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const up = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  const fazer = async (fn: () => Promise<void>) => {
    setOcupado(true)
    setMsg('')
    try {
      await fn()
    } catch (err) {
      setMsg((err as Error).message)
    } finally {
      setOcupado(false)
    }
  }
  if (!estado.proprietario)
    return (
      <Caixa titulo="Criar a conta do proprietário">
        <p className="np-ajuda">Primeira vez: use o código de configuração gerado no servidor (<code>npm run owner:setup-token</code>). Só existe uma conta.</p>
        <form onSubmit={(e) => (e.preventDefault(), fazer(async () => (await api('/api/auth/setup', { method: 'POST', body: f }), aoEntrar())))}>
          <input placeholder="Código de configuração" value={f.codigo} onChange={up('codigo')} autoComplete="one-time-code" />
          <input placeholder="Seu nome" value={f.nome} onChange={up('nome')} autoComplete="name" />
          <input placeholder="E-mail" type="email" value={f.email} onChange={up('email')} autoComplete="email" />
          <input placeholder="Senha (mínimo 10 caracteres)" type="password" value={f.senha} onChange={up('senha')} autoComplete="new-password" />
          <button disabled={ocupado}>Criar conta</button>
        </form>
        {msg && <div className="np-erro">{msg}</div>}
      </Caixa>
    )
  return (
    <Caixa titulo="Acesso exclusivo do proprietário">
      <form
        onSubmit={(e) => (
          e.preventDefault(),
          fazer(async () => {
            const r = await api<{ segundoFator?: boolean }>('/api/auth/login', { method: 'POST', body: { email: f.email, senha: f.senha, ...(pedeOtp ? { codigo: f.otp } : {}) } })
            if (r.segundoFator) setPedeOtp(true)
            else aoEntrar()
          })
        )}
      >
        <input placeholder="E-mail" type="email" value={f.email} onChange={up('email')} autoComplete="username webauthn" />
        <input placeholder="Senha" type="password" value={f.senha} onChange={up('senha')} autoComplete="current-password" />
        {pedeOtp && <input placeholder="Código do autenticador (ou de recuperação)" value={f.otp} onChange={up('otp')} inputMode="numeric" autoComplete="one-time-code" autoFocus />}
        <button disabled={ocupado}>{pedeOtp ? 'Confirmar' : 'Entrar'}</button>
      </form>
      {'PublicKeyCredential' in window && (
        <button className="np-sec" disabled={ocupado} onClick={() => fazer(async () => (await passkeyEntrar(), aoEntrar()))}>
          🔑 Entrar com passkey
        </button>
      )}
      {msg && <div className="np-erro">{msg}</div>}
    </Caixa>
  )
}

function SegundoFator({ estado, aoAtivar }: { estado: Estado; aoAtivar: () => void }) {
  const [totp, setTotp] = useState<{ segredo: string; uri: string } | null>(null)
  const [codigo, setCodigo] = useState('')
  const [recuperacao, setRecuperacao] = useState<string[] | null>(null)
  const [msg, setMsg] = useState('')
  if (recuperacao)
    return (
      <Caixa titulo="Guarde seus códigos de recuperação">
        <p className="np-ajuda">Cada um vale uma vez, se você perder o celular. Guarde num lugar seguro (fora deste computador).</p>
        <div className="np-codigos">{recuperacao.map((c) => <code key={c}>{c}</code>)}</div>
        <button onClick={aoAtivar}>Já guardei — continuar</button>
      </Caixa>
    )
  return (
    <Caixa titulo={estado.totp || estado.passkeys ? 'Entre de novo com o segundo fator' : 'Ative o segundo fator'}>
      {estado.totp || estado.passkeys ? (
        <>
          <p className="np-ajuda">Sua sessão atual entrou só com a senha. Saia e entre de novo com o código do autenticador ou a passkey.</p>
          <button onClick={async () => (await api('/api/auth/sair', { method: 'POST', body: {} }), location.reload())}>Sair e entrar de novo</button>
        </>
      ) : (
        <>
          <p className="np-ajuda">Para proteger o JARVIS, use um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password...) ou uma passkey.</p>
          {!totp ? (
            <button onClick={async () => setTotp(await api('/api/auth/totp/iniciar', { method: 'POST', body: {} }))}>Usar aplicativo autenticador</button>
          ) : (
            <>
              <p className="np-ajuda">
                No app, adicione uma conta com esta chave (ou abra o link no celular):
                <br />
                <code className="np-chave">{totp.segredo.match(/.{1,4}/g)?.join(' ')}</code>
                <br />
                <a href={totp.uri}>Abrir no aplicativo autenticador</a>
              </p>
              <input placeholder="Código de 6 dígitos" value={codigo} onChange={(e) => setCodigo(e.target.value)} inputMode="numeric" autoFocus />
              <button
                onClick={async () => {
                  try {
                    const r = await api<{ codigosRecuperacao: string[] }>('/api/auth/totp/confirmar', { method: 'POST', body: { codigo } })
                    setRecuperacao(r.codigosRecuperacao)
                  } catch (err) {
                    setMsg((err as Error).message)
                  }
                }}
              >
                Confirmar
              </button>
            </>
          )}
          {'PublicKeyCredential' in window && (
            <button className="np-sec" onClick={async () => { try { await passkeyCriar('Este aparelho'); aoAtivar() } catch (err) { setMsg((err as Error).message) } }}>
              🔑 Usar passkey deste aparelho
            </button>
          )}
        </>
      )}
      {msg && <div className="np-erro">{msg}</div>}
    </Caixa>
  )
}

/** Confirmações pendentes (enviar e-mail, apagar, criar evento...). */
function Pendentes() {
  const pend = useNuvem((s) => s.pendentes)
  if (!pend.length) return null
  return (
    <div className="np-pend">
      {pend.map((p) => (
        <div key={p.id} className="np-pend-item">
          <span>⚠ {p.resumo}</span>
          <button onClick={() => void decidir(p.id, true)}>Confirmar</button>
          <button className="np-sec" onClick={() => void decidir(p.id, false)}>Recusar</button>
        </div>
      ))}
    </div>
  )
}

type Sessao = { id: string; dispositivo: string; ip: string; ultima_atividade: string; atual: boolean }
type Disp = { id: string; nome: string; online: boolean; revogado: boolean; ultimo_contato: string | null; permissoes: string[] }

function Conta({ estado, fechar }: { estado: Estado; fechar: () => void }) {
  const [aba, setAba] = useState<'seguranca' | 'computadores' | 'integracoes' | 'uso' | 'dados'>('seguranca')
  const [sessoes, setSessoes] = useState<Sessao[]>([])
  const [disps, setDisps] = useState<Disp[]>([])
  const [integ, setInteg] = useState<any>(null)
  const [uso, setUso] = useState<any>(null)
  const [codigo, setCodigo] = useState('')
  const [msg, setMsg] = useState('')
  const carregar = async () => {
    try {
      if (aba === 'seguranca') setSessoes(await api('/api/auth/sessoes'))
      if (aba === 'computadores') setDisps(await api('/api/dispositivos'))
      if (aba === 'integracoes') setInteg(await api('/api/integracoes'))
      if (aba === 'uso') setUso(await api('/api/uso'))
    } catch (err) {
      setMsg((err as Error).message)
    }
  }
  useEffect(() => {
    setMsg('')
    void carregar()
  }, [aba])
  const tentar = (fn: () => Promise<unknown>, ok?: string) => async () => {
    try {
      await fn()
      if (ok) setMsg(ok)
      await carregar()
    } catch (err) {
      setMsg((err as Error).message)
    }
  }
  return (
    <div className="np-conta" onKeyDown={(e) => e.stopPropagation()}>
      <div className="np-conta-topo">
        <b>CONTA · {estado.nome}</b>
        <button onClick={fechar}>×</button>
      </div>
      <div className="np-abas">
        {(['seguranca', 'computadores', 'integracoes', 'uso', 'dados'] as const).map((a) => (
          <button key={a} className={aba === a ? 'on' : ''} onClick={() => setAba(a)}>
            {{ seguranca: 'Segurança', computadores: 'Computadores', integracoes: 'Integrações', uso: 'Consumo de IA', dados: 'Dados' }[a]}
          </button>
        ))}
      </div>
      <div className="np-conta-corpo">
        {aba === 'seguranca' && (
          <>
            <div className="np-linha">
              Autenticador: <b>{estado.totp ? 'ativo' : 'não'}</b> · Passkeys: <b>{estado.passkeys}</b>
              {'PublicKeyCredential' in window && <button onClick={tentar(() => passkeyCriar(navigator.userAgent.includes('Mobile') ? 'Celular' : 'Computador'), 'Passkey adicionada.')}>+ passkey</button>}
            </div>
            <div className="np-linha">
              <button onClick={tentar(ativarPush, 'Notificações ativadas — veja o teste chegar.')}>🔔 Ativar notificações neste aparelho</button>
            </div>
            <div className="np-sub">Sessões abertas</div>
            {sessoes.map((s) => (
              <div key={s.id} className="np-linha">
                <span className="np-flex">
                  {s.atual ? '● este aparelho' : s.dispositivo.slice(0, 60)} <small>· {s.ip} · {new Date(s.ultima_atividade).toLocaleString('pt-BR')}</small>
                </span>
                {!s.atual && <button onClick={tentar(() => api(`/api/auth/sessoes/${s.id}`, { method: 'DELETE' }))}>Encerrar</button>}
              </div>
            ))}
            <div className="np-linha">
              <button onClick={tentar(() => api('/api/auth/sessoes/encerrar-outras', { method: 'POST', body: {} }), 'Outras sessões encerradas.')}>Encerrar todas as outras</button>
              <button className="np-sec" onClick={async () => (await api('/api/auth/sair', { method: 'POST', body: {} }), location.reload())}>Sair</button>
            </div>
          </>
        )}
        {aba === 'computadores' && (
          <>
            <p className="np-ajuda">O agente local é opcional: com ele, o JARVIS abre programas, sites e pastas e controla o volume no seu PC quando ele estiver ligado. O PC é quem se conecta à nuvem — nada fica exposto na internet.</p>
            <div className="np-linha">
              <button onClick={tentar(async () => setCodigo((await api<{ codigo: string }>('/api/dispositivos/codigo', { method: 'POST', body: {} })).codigo))}>Gerar código de pareamento</button>
              {codigo && (
                <span>
                  Código: <code className="np-chave">{codigo}</code> (10 min) — rode <code>INSTALAR-AGENTE.bat</code> no PC
                </span>
              )}
            </div>
            {disps.map((d) => (
              <div key={d.id} className="np-linha">
                <span className="np-flex">
                  {d.online ? '🟢' : '⚪'} {d.nome} {d.revogado && <small>(revogado)</small>} <small>· {d.permissoes.join(', ')}</small>
                </span>
                {!d.revogado && <button onClick={tentar(() => api(`/api/dispositivos/${d.id}`, { method: 'DELETE' }), 'Computador desconectado.')}>Revogar</button>}
              </div>
            ))}
          </>
        )}
        {aba === 'integracoes' && integ && (
          <>
            <div className="np-linha">
              <span className="np-flex">
                Google (Agenda, Gmail, Drive): {integ.google.conectado ? <b>conectado {integ.google.conta}</b> : integ.google.configurado ? 'não conectado' : <small>o servidor ainda não tem GOOGLE_CLIENT_ID</small>}
              </span>
              {integ.google.configurado && !integ.google.conectado && <a className="np-btn" href="/api/integracoes/google/iniciar">Conectar</a>}
              {integ.google.conectado && <button onClick={tentar(() => api('/api/integracoes/google', { method: 'DELETE' }), 'Google desconectado e acesso revogado.')}>Desconectar</button>}
            </div>
            <div className="np-linha">Pesquisa na internet: {integ.busca.configurado ? 'ativa (SearXNG próprio)' : 'desligada'}</div>
            <div className="np-linha">GitHub: {integ.github.configurado ? 'ativo (só leitura)' : 'desligado'}</div>
            <div className="np-linha">Notificações push: {integ.push.configurado ? 'configuradas' : 'sem chaves VAPID'}</div>
          </>
        )}
        {aba === 'uso' && uso && (
          <>
            <div className="np-linha">
              Hoje: <b>US$ {uso.hoje.reduce((a: number, x: any) => a + (x.custo ?? 0), 0).toFixed(4)}</b> de US$ {uso.orcamento.diarioUsd} por dia
            </div>
            {uso.hoje.map((x: any) => (
              <div key={x.modelo + x.nivel} className="np-linha">
                <span className="np-flex">
                  {x.modelo} <small>({x.nivel})</small>
                </span>
                <small>
                  {x.chamadas} chamadas · {x.entrada + x.saida} tokens · {x.latencia} ms · {x.falhas} falhas
                </small>
              </div>
            ))}
          </>
        )}
        {aba === 'dados' && (
          <>
            <div className="np-linha">
              <a className="np-btn" href="/api/exportar">⬇ Exportar todos os meus dados (JSON)</a>
            </div>
            <div className="np-sub">Trazer do JARVIS 2.0 (PC)</div>
            <p className="np-ajuda">No PC, rode <code>node cloud/src/cli/exportar-local.mjs &gt; pacote.json</code> na pasta do JARVIS e escolha o arquivo. Senhas e tokens nunca entram no pacote.</p>
            <input
              type="file"
              accept="application/json"
              onChange={async (e) => {
                const arq = e.target.files?.[0]
                if (!arq) return
                try {
                  const pacote = JSON.parse(await arq.text())
                  const sim = await api<any>('/api/migracao/importar', { method: 'POST', body: { pacote, simular: true } })
                  if (!confirm(`Importar ${sim.contagem.memorias} memórias, ${sim.contagem.tarefas} tarefas, ${sim.contagem.rotinas} rotinas (pausadas) e ${sim.contagem.lembretes} lembretes?`)) return
                  await api('/api/migracao/importar', { method: 'POST', body: { pacote, simular: false } })
                  setMsg('Importado. As rotinas chegaram pausadas: revise e ative.')
                } catch (err) {
                  setMsg((err as Error).message)
                }
              }}
            />
          </>
        )}
        {msg && <div className="np-msg">{msg}</div>}
      </div>
    </div>
  )
}

export function NuvemPortao({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<Estado | null>(null)
  const [liberado, setLiberado] = useState(false)
  const [conta, setConta] = useState(false)
  const [erro, setErro] = useState('')
  const verificar = async () => {
    try {
      const e = await api<Estado>('/api/auth/estado')
      setEstado(e)
      if (!e.logado) return setLiberado(false)
      // Confere se a sessão já pode usar o JARVIS (segundo fator).
      try {
        await api('/api/tarefas')
        setLiberado(true)
      } catch (err) {
        if ((err as { status?: number }).status === 403) setLiberado(false)
        else throw err
      }
    } catch (err) {
      setErro(`Não consegui falar com o servidor do JARVIS: ${(err as Error).message}`)
    }
  }
  useEffect(() => {
    void verificar()
    void registrarSw()
    const p = new URLSearchParams(location.search)
    if (p.get('conversa')) useNuvem.getState().set({ conversaId: p.get('conversa') })
    if (p.get('integracao')) setConta(true)
  }, [])
  if (erro) return <Caixa titulo="Sem conexão">{<div className="np-erro">{erro}</div>}<button onClick={() => location.reload()}>Tentar de novo</button></Caixa>
  if (!estado) return <div className="np-fundo" />
  if (!estado.logado) return <Entrar estado={estado} aoEntrar={verificar} />
  if (!liberado) return <SegundoFator estado={estado} aoAtivar={verificar} />
  return (
    <>
      {children}
      <Pendentes />
      <button className="np-botao-conta" title="Conta e segurança" onClick={() => setConta(!conta)}>
        ⚿
      </button>
      {conta && <Conta estado={estado} fechar={() => setConta(false)} />}
    </>
  )
}
