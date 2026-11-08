import { useEffect, useState } from 'react'
import { useInteg, type AgendaCfg, type Config, type Email, type EmailCfg, type Evento } from '../integ'
import { sendCerebro } from '../lib/brain'
import { getVozPrefs, setVozPrefs, createSpeaker } from '../lib/tts'
import { getIntensidade, setIntensidade, type Intensidade } from './WireOrb'
import { Central, Rotinas } from './Central'

/**
 * Os painéis da Parte 2: AGENDA (todas as agendas numa linha do tempo),
 * E-MAILS (ação / info / ruído) e as configurações (⚙), onde você cola os
 * links das agendas e as senhas de app. Ficam no mesmo lugar do segundo
 * cérebro, embaixo da esfera.
 */

const hhmm = (t: number) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
const DIAS = ['DOMINGO', 'SEGUNDA', 'TERÇA', 'QUARTA', 'QUINTA', 'SEXTA', 'SÁBADO']

function relativo(t: number) {
  const min = Math.round((Date.now() - t) / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.round(h / 24)
  return `há ${d} dia${d > 1 ? 's' : ''}`
}

function falta(ms: number) {
  const min = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(min / 60)
  return h ? `em ${h}h ${String(min % 60).padStart(2, '0')}min` : `em ${min} min`
}

function useAgora(ms = 30000) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(id)
  }, [ms])
  return Date.now()
}

function Topo({ titulo, sub, children }: { titulo: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="sb-top">
      <div className="sb-tit">
        <b>{titulo}</b>
        {sub && <span>{sub}</span>}
      </div>
      <div className="sb-acts">
        {children}
        <button title="Fechar" onClick={() => useInteg.getState().set({ painel: null })}>
          ×
        </button>
      </div>
    </div>
  )
}

const Configurar = ({ texto }: { texto: string }) => (
  <div className="md-vazio">
    <p>{texto}</p>
    <button className="md-btn" onClick={() => useInteg.getState().set({ painel: 'config' })}>
      ⚙ Configurar
    </button>
  </div>
)

const Erros = ({ erros }: { erros: { nome: string; erro: string }[] }) =>
  erros.length ? (
    <div className="md-erros">
      {erros.map((e) => (
        <div key={e.nome}>
          ⚠ <b>{e.nome}</b>: {e.erro}
        </div>
      ))}
    </div>
  ) : null

// ------------------------------------------------------------------ AGENDA

function rotuloDia(t: number) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  const hoje = new Date()
  hoje.setHours(0, 0, 0, 0)
  const dif = Math.round((d.getTime() - hoje.getTime()) / 86400000)
  if (dif <= 0) return 'HOJE'
  if (dif === 1) return 'AMANHÃ'
  return `${DIAS[d.getDay()]} · ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`
}

function Agenda() {
  const { eventos, agendaErros, temAgenda, carregando, agendaAt } = useInteg()
  const agora = useAgora()
  const futuros = eventos.filter((e) => e.fim > agora || (e.diaTodo && e.fim > agora - 86400000))
  const prox = futuros.find((e) => !e.diaTodo && e.inicio > agora)
  const grupos = new Map<string, Evento[]>()
  for (const e of futuros) {
    const k = rotuloDia(Math.max(e.inicio, agora))
    grupos.set(k, [...(grupos.get(k) ?? []), e])
  }
  if (!grupos.has('HOJE')) grupos.set('HOJE', [])
  const ordem = ['HOJE', ...[...grupos.keys()].filter((k) => k !== 'HOJE')]
  return (
    <div className="sb md">
      <Topo titulo="📅 AGENDA" sub={agendaAt ? `atualizada ${relativo(agendaAt)}` : 'hoje e os próximos 7 dias'}>
        <button title="Atualizar" className={carregando.agenda ? 'girando' : ''} onClick={() => sendCerebro({ type: 'integ-atualizar', qual: 'agenda' })}>
          ↻
        </button>
        <button title="Configurar" onClick={() => useInteg.getState().set({ painel: 'config' })}>
          ⚙
        </button>
      </Topo>
      <div className="md-corpo">
        {!temAgenda ? (
          <Configurar texto="Nenhuma agenda conectada ainda. Cole o endereço secreto em formato iCal de cada agenda do Google." />
        ) : (
          <>
            <Erros erros={agendaErros} />
            {ordem.map((k) => (
              <div key={k} className={`md-dia ${k === 'HOJE' ? 'hoje' : ''}`}>
                <div className="md-dia-tit">{k}</div>
                {!grupos.get(k)!.length && <div className="md-livre">Agenda livre</div>}
                {grupos.get(k)!.map((e) => (
                  <div key={e.id} className={`md-ev ${prox?.id === e.id ? 'prox' : ''}`} style={{ borderLeftColor: e.cor }}>
                    <span className="md-hora">{e.diaTodo ? 'DIA TODO' : hhmm(e.inicio)}</span>
                    <div>
                      <b>{e.titulo}</b>
                      <small>
                        <i style={{ background: e.cor }} />
                        {[e.agenda, e.local].filter(Boolean).join(' · ')}
                      </small>
                    </div>
                    {prox?.id === e.id && <span className="md-falta">{falta(e.inicio - agora)}</span>}
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ E-MAILS

function ItemEmail({ e }: { e: Email }) {
  const [aberto, setAberto] = useState(false)
  return (
    <div className={`md-mail ${e.lido ? 'lido' : ''}`} onClick={() => setAberto(!aberto)}>
      <i style={{ background: e.cor }} title={e.conta} />
      <div>
        <div className="md-mail-top">
          <b>{e.de}</b>
          <span>{relativo(e.data)}</span>
        </div>
        <div className="md-mail-res">{e.resumo || e.assunto}</div>
        {aberto && (
          <div className="md-mail-trecho">
            <b>{e.assunto}</b>
            <br />
            {e.trecho || '(sem texto)'}
          </div>
        )}
      </div>
    </div>
  )
}

function Emails() {
  const { emails, emailErros, temEmail, carregando, emailsAt } = useInteg()
  useAgora(60000)
  const [ruido, setRuido] = useState(false)
  const balde = (b: string) => emails.filter((e) => e.balde === b)
  const local = emails.some((e) => e.por === 'local')
  return (
    <div className="sb md">
      <Topo titulo="✉ E-MAILS" sub={emailsAt ? `atualizado ${relativo(emailsAt)}${local ? ' · parte com triagem local' : ''}` : 'triados em ação · info · ruído'}>
        <button title="Atualizar" className={carregando.emails ? 'girando' : ''} onClick={() => sendCerebro({ type: 'integ-atualizar', qual: 'emails' })}>
          ↻
        </button>
        <button title="Configurar" onClick={() => useInteg.getState().set({ painel: 'config' })}>
          ⚙
        </button>
      </Topo>
      <div className="md-corpo">
        {!temEmail ? (
          <Configurar texto="Nenhuma conta de e-mail conectada ainda. Use o e-mail e uma senha de app do Google." />
        ) : (
          <>
            <Erros erros={emailErros} />
            <div className="md-balde acao">
              <div className="md-dia-tit">⚡ AÇÃO · {balde('acao').length}</div>
              {balde('acao').map((e) => <ItemEmail key={e.id + e.conta} e={e} />)}
              {!balde('acao').length && <div className="md-livre">Nada pedindo ação.</div>}
            </div>
            <div className="md-balde">
              <div className="md-dia-tit">INFO · {balde('info').length}</div>
              {balde('info').map((e) => <ItemEmail key={e.id + e.conta} e={e} />)}
            </div>
            <div className="md-balde ruido">
              <div className="md-dia-tit clicavel" onClick={() => setRuido(!ruido)}>
                RUÍDO · {balde('ruido').length} {ruido ? '▴' : '▾'}
              </div>
              {ruido && balde('ruido').map((e) => <ItemEmail key={e.id + e.conta} e={e} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ CONFIG

const CORES = ['#22d3ee', '#8b5cf6', '#10b981', '#f472b6', '#fbbf24', '#ff5547', '#38bdf8', '#f7931a']

function Config() {
  const config = useInteg((s) => s.config)
  const salvoAt = useInteg((s) => s.salvoAt)
  const [c, setC] = useState<Config | null>(null)
  const [aba, setAba] = useState<'geral' | 'agenda' | 'emails' | 'cerebro'>('geral')
  useEffect(() => {
    sendCerebro({ type: 'integ-config' })
  }, [])
  useEffect(() => {
    if (config && !c) setC(structuredClone(config))
  }, [config, c])
  const [msg, setMsg] = useState('')
  useEffect(() => {
    if (salvoAt) setMsg('Salvo. Buscando agenda e e-mails...')
  }, [salvoAt])
  if (!c) return <div className="sb md"><Topo titulo="⚙ CONFIGURAÇÕES" /><div className="md-corpo">Carregando...</div></div>

  const upA = (i: number, p: Partial<AgendaCfg>) => setC({ ...c, agendas: c.agendas.map((a, j) => (j === i ? { ...a, ...p } : a)) })
  const upE = (i: number, p: Partial<EmailCfg>) => setC({ ...c, emails: c.emails.map((a, j) => (j === i ? { ...a, ...p } : a)) })
  const salvar = () => {
    const mudouModelo = config && c.modelo !== config.modelo
    sendCerebro({ type: 'integ-salvar', config: c })
    useInteg.getState().set({ config: null })
    setC(null)
    if (mudouModelo) {
      setMsg('Salvo. Reiniciando a conversa com o novo cérebro...')
      setTimeout(() => location.reload(), 1200)
    }
  }
  const parar = (e: React.KeyboardEvent) => e.stopPropagation()

  return (
    <div className="sb md" onKeyDown={parar} onKeyUp={parar}>
      <Topo titulo="⚙ CONFIGURAÇÕES" sub="fica só no seu PC">
        {(['geral', 'agenda', 'emails', 'cerebro'] as const).map((a) => (
          <button key={a} className={`md-aba ${aba === a ? 'on' : ''}`} onClick={() => setAba(a)}>
            {a === 'geral' ? 'GERAL' : a === 'agenda' ? 'AGENDA' : a === 'emails' ? 'E-MAILS' : 'CÉREBRO'}
          </button>
        ))}
      </Topo>
      <div className="md-corpo md-cfg">
        {aba === 'geral' && <Geral />}
        {aba === 'agenda' && (
          <>
            <ol className="md-passos">
              <li>Abra o Google Agenda <b>no computador</b> → ⚙ Configurações.</li>
              <li>Clique na agenda, na lista à esquerda → <b>Integrar agenda</b>.</li>
              <li>Copie o <b>Endereço secreto em formato iCal</b> e cole aqui.</li>
            </ol>
            <div className="md-aviso">Este link dá acesso de leitura à sua agenda. Ele fica salvo só no seu PC e nunca é enviado para a IA.</div>
            {c.agendas.map((a, i) => (
              <div key={a.id} className="md-linha">
                <input type="color" value={a.cor} onChange={(e) => upA(i, { cor: e.target.value })} />
                <input className="md-nome" value={a.nome} placeholder="Nome" onChange={(e) => upA(i, { nome: e.target.value })} />
                <input
                  className="md-url"
                  type="password"
                  value={a.url}
                  placeholder={a.salvo && !a.apagarUrl ? '•••••• link salvo (cole outro para trocar)' : 'https://calendar.google.com/calendar/ical/.../basic.ics'}
                  onChange={(e) => upA(i, { url: e.target.value })}
                />
                <button title="Remover" onClick={() => setC({ ...c, agendas: c.agendas.filter((_, j) => j !== i) })}>
                  ×
                </button>
              </div>
            ))}
            <button className="md-btn" onClick={() => setC({ ...c, agendas: [...c.agendas, { id: `a${Date.now()}`, nome: `Agenda ${c.agendas.length + 1}`, cor: CORES[c.agendas.length % CORES.length], url: '' }] })}>
              + adicionar agenda
            </button>
          </>
        )}
        {aba === 'emails' && (
          <>
            <ol className="md-passos">
              <li>Ative a <b>verificação em 2 etapas</b> em myaccount.google.com/security (sem ela não existe senha de app).</li>
              <li>Depois, em <b>myaccount.google.com/apppasswords</b>, crie um app chamado “Jarvis” e copie a senha de 16 letras.</li>
              <li>Cole aqui o e-mail e essa senha de app (<b>não</b> é a sua senha normal do Gmail).</li>
            </ol>
            <div className="md-aviso">
              A senha de app fica salva só no seu PC e vai apenas até o Google. Para a triagem, remetente, assunto e um trecho de cada e-mail novo vão ao Claude (uma vez só). O JARVIS só LÊ: nunca envia, responde, apaga ou marca nada como lido.
            </div>
            {c.emails.map((e, i) => (
              <div key={e.id} className="md-linha">
                <input type="color" value={e.cor} onChange={(ev) => upE(i, { cor: ev.target.value })} />
                <input className="md-nome" value={e.apelido} placeholder="Apelido" onChange={(ev) => upE(i, { apelido: ev.target.value })} />
                <input className="md-url" value={e.usuario} placeholder="voce@gmail.com" onChange={(ev) => upE(i, { usuario: ev.target.value })} />
                <input
                  className="md-senha"
                  type="password"
                  value={e.senhaApp}
                  placeholder={e.salvo && !e.apagarSenha ? '•••• salva' : 'senha de app'}
                  onChange={(ev) => upE(i, { senhaApp: ev.target.value })}
                />
                <button title="Remover" onClick={() => setC({ ...c, emails: c.emails.filter((_, j) => j !== i) })}>
                  ×
                </button>
              </div>
            ))}
            <button className="md-btn" onClick={() => setC({ ...c, emails: [...c.emails, { id: `e${Date.now()}`, apelido: `Conta ${c.emails.length + 1}`, cor: CORES[(c.emails.length + 3) % CORES.length], usuario: '', senhaApp: '', host: 'imap.gmail.com' }] })}>
              + adicionar conta
            </button>
          </>
        )}
        {aba === 'cerebro' && (
          <>
            <label className="md-campo">
              Cérebro do JARVIS (quando precisa do Claude)
              <select value={c.modelo} onChange={(e) => setC({ ...c, modelo: e.target.value })}>
                {Object.entries(c.modelos).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <div className="md-aviso">
              Comandos de agenda, e-mails, notícias, clima e o “bom dia” são resolvidos no seu PC, sem gastar o Claude. A triagem de e-mails usa o Haiku, numa chamada só por lote, e nunca repete um e-mail já triado.
            </div>
            <label className="md-check">
              <input type="checkbox" checked={c.digestAuto} onChange={(e) => setC({ ...c, digestAuto: e.target.checked })} />
              Dar o bom dia sozinho na primeira vez que ligar, de manhã (5h às 13h)
            </label>
          </>
        )}
      </div>
      <div className="sb-legend">
        <div>{msg}</div>
        <button className="md-btn md-ok" onClick={salvar}>
          Salvar
        </button>
      </div>
    </div>
  )
}

function Geral() {
  const prefs = useInteg((s) => s.prefs)
  const msg = useInteg((s) => s.prefsMsg)
  const [p, setP] = useState<{ nome: string; cidade: string; temas: string } | null>(null)
  const [voz, setVoz] = useState(getVozPrefs)
  const [anim, setAnim] = useState<Intensidade>(getIntensidade)
  useEffect(() => {
    sendCerebro({ type: 'prefs' })
  }, [])
  useEffect(() => {
    if (prefs) setP({ nome: prefs.nome, cidade: prefs.cidade, temas: prefs.temas.join(', ') })
  }, [prefs])
  if (!p) return <div className="md-livre">Carregando…</div>
  return (
    <>
      <div className="md-linha">
        <label className="md-campo md-flex">
          Como ele chama você
          <input value={p.nome} maxLength={40} onChange={(e) => setP({ ...p, nome: e.target.value })} placeholder="senhor" />
        </label>
        <label className="md-campo md-flex">
          Sua cidade (clima)
          <input value={p.cidade} maxLength={60} onChange={(e) => setP({ ...p, cidade: e.target.value })} />
        </label>
      </div>
      <label className="md-campo">
        Assuntos do radar de notícias (separados por vírgula)
        <input value={p.temas} onChange={(e) => setP({ ...p, temas: e.target.value })} />
      </label>
      <div className="md-linha">
        <button
          className="md-btn md-ok"
          onClick={() => {
            useInteg.getState().set({ prefsMsg: 'Salvando…' })
            sendCerebro({ type: 'prefs-salvar', prefs: { nome: p.nome, cidade: p.cidade, temas: p.temas.split(',').map((x) => x.trim()).filter(Boolean) } })
          }}
        >
          Salvar preferências
        </button>
        <span className="md-livre">{msg}</span>
      </div>
      <div className="md-linha">
        <label className="md-campo md-flex">
          Velocidade da fala: {voz.velocidade.toFixed(2).replace('.', ',')}×
          <input type="range" min={0.7} max={1.5} step={0.05} value={voz.velocidade} onChange={(e) => { setVozPrefs({ velocidade: Number(e.target.value) }); setVoz(getVozPrefs()) }} />
        </label>
        <label className="md-campo md-flex">
          Volume: {Math.round(voz.volume * 100)}%
          <input type="range" min={0} max={1} step={0.05} value={voz.volume} onChange={(e) => { setVozPrefs({ volume: Number(e.target.value) }); setVoz(getVozPrefs()) }} />
        </label>
        <button
          className="md-btn"
          onClick={() => {
            const spk = createSpeaker()
            spk.say('Assim fica a minha voz, senhor.')
            void spk.end()
          }}
        >
          Testar
        </button>
      </div>
      <label className="md-campo">
        Intensidade das animações
        <select value={anim} onChange={(e) => { setIntensidade(e.target.value as Intensidade); setAnim(e.target.value as Intensidade) }}>
          <option value="baixa">Baixa — mais leve para o PC</option>
          <option value="media">Média</option>
          <option value="alta">Alta — máximo de detalhe</option>
        </select>
      </label>
      <div className="md-aviso">
        Palavra de ativação: <b>“Jarvis”</b> ou <b>“amigão”</b>. A voz troca com a tecla <b>V</b>. O <b>modo ação</b> (abrir programas, mexer em arquivos pelo Claude) liga e desliga no ícone do JARVIS, ao lado do relógio. Ações que apagam, enviam ou criam algo sempre pedem confirmação.
      </div>
    </>
  )
}

export function Modulos() {
  const painel = useInteg((s) => s.painel)
  if (painel === 'central') return <Central />
  if (painel === 'rotinas') return <Rotinas />
  if (painel === 'agenda') return <Agenda />
  if (painel === 'emails') return <Emails />
  if (painel === 'config') return <Config />
  return null
}
