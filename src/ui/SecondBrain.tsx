import { useEffect, useMemo, useRef, useState } from 'react'
import { AREA, useCerebro, type Nota } from '../cerebro'
import { sendCerebro } from '../lib/brain'

/**
 * O Segundo Cérebro: um grafo neural com as notas da sua vida.
 *
 * Núcleo pulsante no centro, um nó por nota na cor da área (maior quanto
 * mais ligado), arestas curvas com traços deslizando, raios do núcleo até
 * cada nó e pulsos de sinapse viajando pelas ligações. Clicar num nó edita;
 * o "+" cria. Tudo que está aqui entra em toda conversa com o JARVIS.
 */

const W = 1000
const H = 540
const CX = W / 2
const CY = H / 2

type Pos = { x: number; y: number; r: number; n: Nota; deg: number }

function layout(notas: Nota[], rel: [string, string][]) {
  // Agrupa por área para notas da mesma área ficarem vizinhas na elipse.
  const ordem = Object.keys(AREA)
  const ns = [...notas].sort((a, b) => ordem.indexOf(a.area) - ordem.indexOf(b.area))
  const deg = new Map<string, number>()
  for (const [a, b] of rel) {
    deg.set(a, (deg.get(a) ?? 0) + 1)
    deg.set(b, (deg.get(b) ?? 0) + 1)
  }
  const pos = new Map<string, Pos>()
  const N = Math.max(1, ns.length)
  ns.forEach((n, i) => {
    const ang = -Math.PI / 2 + (i / N) * Math.PI * 2
    // Alterna um pouco o raio para os rótulos não se encostarem.
    const k = ns.length > 10 ? (i % 2 ? 0.8 : 1) : 1
    const d = deg.get(n.id) ?? 0
    pos.set(n.id, {
      x: CX + Math.cos(ang) * 410 * k,
      y: CY + Math.sin(ang) * 205 * k,
      r: Math.min(24, 9 + d * 2.6),
      n,
      deg: d,
    })
  })
  return pos
}

/** Ponto de controle da curva: o meio da aresta puxado 35% para o centro. */
function ctrl(a: Pos, b: Pos) {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  return { x: mx + (CX - mx) * 0.35, y: my + (CY - my) * 0.35 }
}

function Editor({ nota, onClose }: { nota: Partial<Nota>; onClose: () => void }) {
  const [title, setTitle] = useState(nota.title ?? '')
  const [area, setArea] = useState(nota.area ?? 'meta')
  const [body, setBody] = useState(nota.body ?? '')
  const salvar = () => {
    if (!title.trim() && !body.trim()) return onClose()
    sendCerebro({ type: 'nota', nota: { id: nota.id, area, title: title.trim() || 'Nota', body: body.trim() } })
    onClose()
  }
  return (
    <div className="sb-editor-bg" onClick={onClose}>
      <div className="sb-editor" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div className="sb-editor-head">{nota.id ? 'EDITAR NOTA' : 'NOVA NOTA'}</div>
        <label>
          Título
          <input autoFocus value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} placeholder="1 ou 2 palavras" />
        </label>
        <label>
          Área
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            {Object.entries(AREA).map(([k, a]) => (
              <option key={k} value={k}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Conteúdo
          <textarea value={body} rows={5} maxLength={1200} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="sb-editor-btns">
          {nota.id && (
            <button
              className="sb-del"
              onClick={() => {
                sendCerebro({ type: 'nota-excluir', id: nota.id })
                onClose()
              }}
            >
              Excluir
            </button>
          )}
          <span />
          <button onClick={onClose}>Cancelar</button>
          <button className="sb-ok" onClick={salvar}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}

export function SecondBrain() {
  const notas = useCerebro((s) => s.notas)
  const rel = useCerebro((s) => s.rel)
  const flash = useCerebro((s) => s.flash)
  const flashAt = useCerebro((s) => s.flashAt)
  const abrir = useCerebro((s) => s.abrir)
  const [edit, setEdit] = useState<Partial<Nota> | null>(null)
  const pos = useMemo(() => layout(notas, rel), [notas, rel])
  const edges = useMemo(
    () =>
      rel
        .map(([a, b]) => [pos.get(a), pos.get(b)] as const)
        .filter((e): e is readonly [Pos, Pos] => Boolean(e[0] && e[1]))
        .map(([a, b]) => ({ a, b, c: ctrl(a, b) })),
    [rel, pos],
  )
  const areas = [...new Set(notas.map((n) => n.area))].filter((a) => AREA[a])

  // Pulsos de sinapse: pontos brancos viajando pelas arestas (e pelos raios,
  // quando ainda há poucas ligações).
  const dots = useRef<(SVGCircleElement | null)[]>([])
  useEffect(() => {
    const trilhas = edges.length
      ? edges
      : [...pos.values()].map((p) => ({ a: { x: CX, y: CY } as Pos, b: p, c: { x: (CX + p.x) / 2, y: (CY + p.y) / 2 } }))
    if (!trilhas.length) return
    const st = dots.current.map((_, i) => ({ e: (i * 7) % trilhas.length, t: Math.random(), v: 0.004 + Math.random() * 0.006, rev: i % 2 === 1 }))
    let raf = 0
    const tick = () => {
      st.forEach((s, i) => {
        const el = dots.current[i]
        if (!el) return
        s.t += s.v
        if (s.t >= 1) {
          s.t = 0
          s.e = Math.floor(Math.random() * trilhas.length)
          s.rev = Math.random() < 0.5
        }
        const { a, b, c } = trilhas[s.e]
        const [A, B] = s.rev ? [b, a] : [a, b]
        const t = s.t
        const x = (1 - t) ** 2 * A.x + 2 * (1 - t) * t * c.x + t * t * B.x
        const y = (1 - t) ** 2 * A.y + 2 * (1 - t) * t * c.y + t * t * B.y
        el.setAttribute('cx', x.toFixed(1))
        el.setAttribute('cy', y.toFixed(1))
        el.setAttribute('opacity', Math.sin(t * Math.PI).toFixed(2))
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [edges, pos])

  const piscando = flash && Date.now() - flashAt < 5000 ? flash : null

  return (
    <div className="sb">
      <div className="sb-top">
        <div className="sb-tit">
          <b>🧠 SEGUNDO CÉREBRO</b>
          <span>o contexto da sua vida, em toda conversa</span>
        </div>
        <div className="sb-acts">
          <span className="sb-count">
            {notas.length} notas · {areas.length} áreas
          </span>
          <button title="Nova nota" onClick={() => setEdit({ area: 'meta' })}>
            +
          </button>
          <button title="Recarregar" onClick={() => sendCerebro({ type: 'cerebro' })}>
            ↻
          </button>
          <button title="Fechar" onClick={() => abrir(false)}>
            ×
          </button>
        </div>
      </div>

      <div className="sb-graph">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="sb-edge" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#a855f7" />
              <stop offset="1" stopColor="#22d3ee" />
            </linearGradient>
            <radialGradient id="sb-core" cx="50%" cy="45%" r="60%">
              <stop offset="0" stopColor="#c4b5fd" />
              <stop offset="0.55" stopColor="#7c3aed" />
              <stop offset="1" stopColor="#3b0764" />
            </radialGradient>
            <filter id="sb-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="6" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {[...pos.values()].map((p) => (
            <line key={`r-${p.n.id}`} x1={CX} y1={CY} x2={p.x} y2={p.y} stroke={AREA[p.n.area]?.color ?? '#8a90a6'} strokeWidth={0.8} opacity={0.22} />
          ))}
          {edges.map(({ a, b, c }) => (
            <path
              key={`e-${a.n.id}-${b.n.id}`}
              className="sb-edge"
              d={`M${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`}
              stroke="url(#sb-edge)"
              fill="none"
            />
          ))}

          <g className="sb-core" filter="url(#sb-glow)">
            <circle cx={CX} cy={CY} r={46} fill="url(#sb-core)" />
            <text x={CX} y={CY + 11} textAnchor="middle" fontSize="32">
              🧠
            </text>
          </g>

          {[...pos.values()].map((p) => {
            const cor = AREA[p.n.area]?.color ?? '#8a90a6'
            return (
              <g
                key={p.n.id}
                className={`sb-node ${piscando === p.n.id ? 'flash' : ''}`}
                onClick={() => setEdit(p.n)}
                style={{ animationDelay: `${(p.x % 7) / 3}s` }}
              >
                <title>{p.n.body}</title>
                <circle className="sb-ring" cx={p.x} cy={p.y} r={p.r + 7} fill="none" stroke={cor} strokeWidth={1.4} />
                <circle cx={p.x} cy={p.y} r={p.r} fill={cor} fillOpacity={0.9} filter="url(#sb-glow)" />
                <text x={p.x} y={p.y + p.r + 18} textAnchor="middle" className="sb-label">
                  {p.n.title}
                </text>
              </g>
            )
          })}

          {Array.from({ length: 12 }, (_, i) => (
            <circle key={`d-${i}`} ref={(el) => (dots.current[i] = el)} r={2.6} fill="#fff" opacity={0} filter="url(#sb-glow)" />
          ))}
        </svg>
      </div>

      <div className="sb-legend">
        <div>
          {areas.map((a) => (
            <span key={a}>
              <i style={{ background: AREA[a].color }} />
              {AREA[a].label}
            </span>
          ))}
        </div>
        <b>✓ contexto injetado em todos os comandos do JARVIS</b>
      </div>

      {edit && <Editor nota={edit} onClose={() => setEdit(null)} />}
    </div>
  )
}
