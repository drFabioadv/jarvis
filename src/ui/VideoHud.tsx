import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type Phase } from '../store'
import { useCards, type Card } from '../cards'
import { BRIDGE_HTTP_URL } from '../config'
import { requestPainel, sendCerebro } from '../lib/brain'
import { useCerebro } from '../cerebro'
import { SecondBrain } from './SecondBrain'
import { Blades } from './Blades'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { WireOrb, setOrbLayout } from './WireOrb'
import { currentVoiceName } from '../lib/tts'

/**
 * O layout: fundo preto com grade, a esfera de fios e os cartões.
 *
 * Sem cartões abertos, a esfera fica no centro. Com cartões, ela sobe para o
 * canto superior esquerdo e os cartões ocupam a direita da tela. Cada cartão
 * pode ser minimizado (vai para a aba embaixo da esfera) ou fechado.
 */

const STATUS: Record<Phase, string> = {
  offline: 'DESLIGADO',
  boot: 'INICIALIZANDO',
  dormant: 'EM ESPERA',
  waking: 'ATIVANDO',
  listening: 'OUVINDO',
  thinking: 'PENSANDO',
  tooling: 'TRABALHANDO',
  speaking: 'FALANDO',
}

const img = (src?: string) =>
  !src ? '' : /^https?:\/\//.test(src) ? `${BRIDGE_HTTP_URL}/img?url=${encodeURIComponent(src)}` : src

const fmt = (n?: number, dec = 1) =>
  n == null ? '—' : n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: dec })

const ICON: Record<string, string> = {
  sol: '☀', 'nuvem-sol': '⛅', nuvem: '☁', chuva: '🌧', tempestade: '⛈',
  clima: '✳', noticia: '◉', texto: '▣', lista: '▤', video: '▶', status: '◈',
}
/** Grupos da barra lateral. */
const GRUPOS = [
  { id: 'clima', nome: 'Clima', icone: '☀' },
  { id: 'noticias', nome: 'Notícias', icone: '📰' },
  { id: 'lembretes', nome: 'Lembretes', icone: '⏰' },
  { id: 'arquivos', nome: 'Arquivos', icone: '📁' },
  { id: 'midia', nome: 'Mídia', icone: '▶' },
  { id: 'outros', nome: 'Outros', icone: '◈' },
]
function grupoDe(c: Card): string {
  if (c.kind === 'clima') return 'clima'
  if (c.kind === 'noticia' || /JORNAL|MANCHETE|RADAR|POLÍTICA|INTELIG/.test(c.kicker ?? '')) return 'noticias'
  if (/LEMBRETE/.test(c.kicker ?? '')) return 'lembretes'
  if (/ARQUIVOS/.test(c.kicker ?? '')) return 'arquivos'
  if (c.kind === 'video') return 'midia'
  return 'outros'
}

const Icon = ({ name }: { name: string }) => <span className="vh-icon">{ICON[name] ?? '◈'}</span>

function CardView({ c, big }: { c: Card; big: boolean }) {
  const cards = useCards.getState()
  const open = () => {
    if (c.link) window.open(c.link, '_blank', 'noopener')
  }
  return (
    <>
      <div className="vh-head">
        <Icon name={c.kind === 'clima' ? 'clima' : c.kind} />
        <div onClick={open} style={{ cursor: c.link ? 'pointer' : 'default' }}>
          {c.kicker && <div className="vh-kicker">{c.kicker}</div>}
          {c.title && <div className="vh-title">{c.title}</div>}
        </div>
        <div className="vh-btns">
          <button title="Minimizar" onClick={() => cards.minimize(c.id)}>–</button>
          <button title="Fechar" onClick={() => cards.close(c.id)}>×</button>
        </div>
      </div>
      {c.kind === 'status' && (
        <div className="vh-status">
          {c.text && <div className="vh-sub">{c.text}</div>}
          {c.chips && (
            <div className="vh-chips">
              {c.chips.map((ch) => (
                <span key={ch} className={ch === c.active ? 'on' : ''}>
                  {ch}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {c.kind === 'clima' && c.clima && (
        <div className="vh-weather">
          <div className="vh-w-main">
            <span className="vh-wicon">{ICON[c.clima.icon ?? 'sol'] ?? '☀'}</span>
            <div>
              <div className="vh-temp">{fmt(c.clima.temp)}°</div>
              <div className="vh-sub">{c.clima.desc}</div>
            </div>
            <div className="vh-w-cols">
              <div><span>MÍN</span>{fmt(c.clima.min)}°</div>
              <div><span>MÁX</span>{fmt(c.clima.max)}°</div>
              <div><span>SENSAÇÃO</span>{fmt(c.clima.sensacao, 0)}°</div>
            </div>
          </div>
          <div className="vh-w-side">
            <div><span>UMIDADE</span>{fmt(c.clima.umidade, 0)}%</div>
            <div><span>CHUVA</span>{fmt(c.clima.chuva, 0)}%</div>
            <div><span>VENTO</span>{fmt(c.clima.vento)} km/h</div>
          </div>
        </div>
      )}
      {c.kind !== 'status' && c.kind !== 'clima' && (
        <div className="vh-body" onClick={open} style={{ cursor: c.link ? 'pointer' : 'default' }}>
          {c.image && <img className={big ? 'vh-img' : 'vh-thumb'} src={img(c.image)} alt="" referrerPolicy="no-referrer" />}
          {c.text && <div className="vh-text">{c.text}</div>}
          {c.items && (
            <ul className="vh-list">
              {c.items.slice(0, 8).map((it, i) => (
                <li key={i}>
                  <b>{it.label}</b>
                  {it.sub && <span>{it.sub}</span>}
                </li>
              ))}
            </ul>
          )}
          {c.source && <div className="vh-src">{c.source.toUpperCase().slice(0, 24)}</div>}
        </div>
      )}
    </>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="vh-clock-mini">
      <b>{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b>
      <span>{now.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
    </div>
  )
}

export function VideoHud() {
  const phase = useStore((s) => s.phase)
  const caption = useStore((s) => s.caption)
  const error = useStore((s) => s.error)
  const turns = useStore((s) => s.turns)
  const slots = useCards((s) => s.slots)
  const latest = useCards((s) => s.latest)
  const open = slots.filter((x) => !x.min)
  const hasOpen = open.length > 0
  const last = turns[turns.length - 1]
  const line = caption || (phase === 'speaking' && last?.role === 'jarvis' ? last.text.split(/(?<=[.!?])\s/).slice(-1)[0] : '')

  const cerebroAberto = useCerebro((s) => s.aberto)
  useEffect(() => setOrbLayout(cerebroAberto ? 'cerebro' : hasOpen), [hasOpen, cerebroAberto])

  // Tela de inicialização: o nome, "sincronizando dados...", por ~2,2 s.
  const [bootando, setBootando] = useState(true)
  useEffect(() => {
    const id = setTimeout(() => setBootando(false), 2200)
    return () => clearTimeout(id)
  }, [])
  const mostraBoot = phase === 'boot' || (bootando && phase !== 'offline')

  // Nota nova gravada pela memória viva: aparece um cartão, se o grafo
  // estiver fechado (o "anota que..." local já manda o seu).
  const flashAt = useCerebro((s) => s.flashAt)
  useEffect(() => {
    if (!flashAt) return
    const st = useCerebro.getState()
    const n = st.notas.find((x) => x.id === st.flash)
    if (!n || st.aberto) return
    const ja = useCards.getState().slots.some((x) => x.card.title === n.title && (x.card.kicker ?? '').startsWith('SEGUNDO') && Date.now() - x.at < 4000)
    if (!ja) useCards.getState().push({ id: `cb-${flashAt}`, kind: 'texto', kicker: 'SEGUNDO CÉREBRO · NOTA SALVA', title: n.title, text: n.body })
  }, [flashAt])

  // O painel inicial: assim que ele fica pronto, e de novo a cada 30 minutos.
  const [painelPedido, setPainelPedido] = useState(false)
  useEffect(() => {
    if (painelPedido || phase === 'offline' || phase === 'boot') return
    setPainelPedido(true)
    requestPainel()
    sendCerebro({ type: 'cerebro' })
    const id = setInterval(requestPainel, 30 * 60 * 1000)
    return () => clearInterval(id)
  }, [phase, painelPedido])

  return (
    <div className={`vh ${hasOpen ? 'vh-open' : 'vh-closed'} ${cerebroAberto ? 'vh-cerebro' : ''}`}>
      <div className="vh-grid" />
      <WireOrb />

      <div className="vh-top">
        <div className="vh-pills">
          <span>◉ PERSONALIZADO · SINCRONIZADO</span>
          <span className="vh-pill-btn" onClick={() => (hasOpen ? useCards.getState().minimizeAll() : useCards.getState().restoreAll())}>
            ▣ {hasOpen ? 'MINIMIZAR TUDO' : 'MOSTRAR PAINEL'}
          </span>
        </div>
        <div className={`vh-phase vh-phase-${phase}`}>{STATUS[phase]}</div>
        <div className="vh-dots" />
      </div>
      <Clock />

      <div className="vh-panel">
        <AnimatePresence mode="popLayout">
          {open.map(({ card }) => {
            const big = card.id === latest && (card.kind === 'noticia' || card.kind === 'clima' || card.kind === 'lista')
            return (
              <motion.div
                key={card.id}
                layout
                layoutId={card.id}
                className={`vh-card vh-card-${card.kind} ${big ? 'destaque' : ''}`}
                initial={{ opacity: 0, y: 24, scale: 0.95, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.85, y: 20 }}
                transition={{ type: 'spring', stiffness: 230, damping: 26 }}
              >
                <CardView c={card} big={big} />
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>

      <div className="vh-rail">
        <button
          className={`vh-rail-btn ${cerebroAberto ? 'on' : ''}`}
          title="Segundo cérebro"
          onClick={() => useCerebro.getState().abrir()}
        >
          <span>🧠</span>
          <i>Cérebro</i>
        </button>
        {slots.length > 0 && (
          <button
            className={`vh-rail-btn vh-rail-all ${hasOpen ? 'on' : ''}`}
            title={hasOpen ? 'Minimizar tudo' : 'Mostrar todas as informações'}
            onClick={() => (hasOpen ? useCards.getState().minimizeAll() : useCards.getState().restoreAll())}
          >
            <span>{hasOpen ? '▣' : '▤'}</span>
            <b>{slots.length}</b>
          </button>
        )}
          {GRUPOS.map((g) => {
            const itens = slots.filter((x) => grupoDe(x.card) === g.id)
            if (!itens.length) return null
            const abertos = itens.some((x) => !x.min)
            return (
              <button
                key={g.id}
                className={`vh-rail-btn ${abertos ? 'on' : ''}`}
                title={`${g.nome}: ${itens.map((x) => x.card.title ?? '').join(' · ').slice(0, 200)}`}
                onClick={() => {
                  const st = useCards.getState()
                  if (abertos) itens.forEach((x) => st.minimize(x.card.id))
                  else itens.forEach((x) => st.restore(x.card.id))
                }}
              >
                <span>{g.icone}</span>
                <i>{g.nome}</i>
                {itens.length > 1 && <b>{itens.length}</b>}
              </button>
            )
          })}
      </div>

      {cerebroAberto && <SecondBrain />}

      {line && <div className="vh-caption">{line}</div>}
      {error && <div className="vh-error">{error}</div>}
      <div className="vh-foot">
        diga <b>“Jarvis”</b> ou <b>“amigão”</b> · <b>“pausar”</b> para parar de ouvir · <kbd>Espaço</kbd> para falar · <kbd>V</kbd> voz:{' '}
        {currentVoiceName().replace(/^Microsoft\s+/, '').replace(/\s*-.*$/, '')} · <kbd>D</kbd> diagnóstico
      </div>

      <AnimatePresence>
      {mostraBoot && (
        <motion.div className="vh-boot" key="boot" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.7 }}>
          <div className="vh-boot-name">J.A.R.V.I.S.</div>
          <hr />
          <div className="vh-boot-sync">SINCRONIZANDO DADOS...</div>
          <div className="vh-boot-ver">v5.0 · REBUILD</div>
        </motion.div>
      )}
      </AnimatePresence>

      <Blades />
      <Effects />
      <Pointer />
    </div>
  )
}
