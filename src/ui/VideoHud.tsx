import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type Phase } from '../store'
import { useCards, type Card } from '../cards'
import { BRIDGE_HTTP_URL } from '../config'
import { Blades } from './Blades'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { WireOrb } from './WireOrb'

/**
 * O layout do vídeo: grade azul, a esfera de fios no centro, o status no topo,
 * o cartão do momento grande no meio e os anteriores enfileirados embaixo.
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

function Icon({ name }: { name: string }) {
  const map: Record<string, string> = {
    sol: '☀', 'nuvem-sol': '⛅', nuvem: '☁', chuva: '🌧', tempestade: '⛈',
    clima: '✳', noticia: '◉', texto: '▣', lista: '▤', video: '▶', status: '◈',
  }
  return <span className="vh-icon">{map[name] ?? '◈'}</span>
}

function CardHead({ c }: { c: Card }) {
  return (
    <div className="vh-head">
      <Icon name={c.kind} />
      <div>
        {c.kicker && <div className="vh-kicker">{c.kicker}</div>}
        {c.title && c.kind !== 'status' && <div className="vh-title">{c.title}</div>}
      </div>
      {c.source && <span className="vh-tag">{c.source.toUpperCase().slice(0, 18)}</span>}
    </div>
  )
}

function CardBody({ c, big }: { c: Card; big: boolean }) {
  if (c.kind === 'status') {
    return (
      <div className="vh-status">
        <div className="vh-kicker center">{c.kicker}</div>
        <div className="vh-mono">{c.title}</div>
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
    )
  }
  if (c.kind === 'clima' && c.clima) {
    const w = c.clima
    return (
      <div className="vh-weather">
        <div className="vh-w-main">
          <Icon name={w.icon ?? 'sol'} />
          <div>
            <div className="vh-temp">{fmt(w.temp)}°</div>
            <div className="vh-sub">{w.desc}</div>
          </div>
          {big && (
            <div className="vh-w-cols">
              <div><span>MÍNIMA</span>{fmt(w.min)}°</div>
              <div><span>MÁXIMA</span>{fmt(w.max)}°</div>
              <div><span>SENSAÇÃO</span>{fmt(w.sensacao, 0)}°</div>
            </div>
          )}
        </div>
        {big && (
          <div className="vh-w-side">
            <div><span>UMIDADE</span>{fmt(w.umidade, 0)}%</div>
            <div><span>CHUVA</span>{fmt(w.chuva, 0)}%</div>
            <div><span>VENTO</span>{fmt(w.vento)} km/h</div>
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="vh-body">
      {c.image && (big || c.kind === 'video') && <img className="vh-img" src={img(c.image)} alt="" referrerPolicy="no-referrer" />}
      {c.image && !big && c.kind !== 'video' && <img className="vh-thumb" src={img(c.image)} alt="" referrerPolicy="no-referrer" />}
      {c.text && <div className="vh-text">{c.text}</div>}
      {c.items && (
        <ul className="vh-list">
          {c.items.slice(0, big ? 8 : 3).map((it, i) => (
            <li key={i}>
              <b>{it.label}</b>
              {it.sub && big && <span>{it.sub}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="vh-side-panel">
      <div className="vh-kicker">SISTEMA · HOJE</div>
      <div className="vh-clock">{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
      <div className="vh-sub">{now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      <div className="vh-meter"><i style={{ width: '82%' }} /></div>
      <div className="vh-mini"><span>CÉREBRO LOCAL</span><b>ATIVO</b></div>
      <div className="vh-mini"><span>CLAUDE</span><b>SOB DEMANDA</b></div>
    </div>
  )
}

export function VideoHud() {
  const phase = useStore((s) => s.phase)
  const caption = useStore((s) => s.caption)
  const error = useStore((s) => s.error)
  const turns = useStore((s) => s.turns)
  const active = useCards((s) => s.active)
  const dock = useCards((s) => s.dock)
  const last = turns[turns.length - 1]
  const line = caption || (phase === 'speaking' && last?.role === 'jarvis' ? last.text.split(/(?<=[.!?])\s/).slice(-1)[0] : '')

  return (
    <div className="vh">
      <div className="vh-grid" />
      <WireOrb />

      <div className="vh-top">
        <div className="vh-pills">
          <span>◉ PERSONALIZADO · SINCRONIZADO</span>
          <span>▣ GERENCIAR HUD</span>
        </div>
        <div className={`vh-phase vh-phase-${phase}`}>{STATUS[phase]}</div>
        <div className="vh-dots" />
      </div>

      <Clock />

      <div className="vh-stage">
        <AnimatePresence mode="popLayout">
          {active && (
            <motion.div
              key={active.id}
              layoutId={active.id}
              className={`vh-card vh-card-${active.kind} big`}
              initial={{ opacity: 0, y: 30, scale: 0.94, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: 40, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 220, damping: 26 }}
            >
              {active.kind !== 'status' && <CardHead c={active} />}
              <CardBody c={active} big />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="vh-dock">
        <AnimatePresence>
          {dock.map((c) => (
            <motion.div
              key={c.id}
              layoutId={c.id}
              className={`vh-card vh-card-${c.kind} small`}
              initial={{ opacity: 0, y: -40 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 240, damping: 28 }}
            >
              <CardHead c={c} />
              <CardBody c={c} big={false} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {line && <div className="vh-caption">{line}</div>}
      {error && <div className="vh-error">{error}</div>}
      <div className="vh-foot">
        diga <b>“ei jarvis”</b> · <kbd>Espaço</kbd> para falar · <kbd>D</kbd> diagnóstico
      </div>

      <Blades />
      <Effects />
      <Pointer />
    </div>
  )
}
