import { useEffect, useState } from 'react'
import { useInteg, abrirPainel, type Rotina } from '../integ'
import { useCards } from '../cards'
import { sendCerebro } from '../lib/brain'

/**
 * CENTRAL DE COMANDO: o essencial do dia num lugar só — relógio, clima,
 * próximos compromissos, tarefas, lembretes, rotinas, saúde do sistema e os
 * últimos comandos. Cada módulo pode ser escondido e reordenado (fica salvo).
 *
 * ROTINAS: as automações (nome, comando, frequência, horário, condição),
 * com pausar, editar, rodar agora, excluir e histórico.
 */

const MODULOS = [
  { id: 'relogio', nome: 'Relógio' },
  { id: 'clima', nome: 'Clima' },
  { id: 'agenda', nome: 'Próximos compromissos' },
  { id: 'tarefas', nome: 'Tarefas' },
  { id: 'lembretes', nome: 'Lembretes' },
  { id: 'rotinas', nome: 'Rotinas' },
  { id: 'sistema', nome: 'Status do sistema' },
  { id: 'historico', nome: 'Histórico de comandos' },
] as const
type ModId = (typeof MODULOS)[number]['id']

function lerLayout(): { ordem: ModId[]; ocultos: ModId[] } {
  try {
    const v = JSON.parse(localStorage.getItem('jarvis-central') ?? '')
    const ordem = (v.ordem as ModId[]).filter((x) => MODULOS.some((m) => m.id === x))
    for (const m of MODULOS) if (!ordem.includes(m.id)) ordem.push(m.id)
    return { ordem, ocultos: v.ocultos ?? [] }
  } catch {
    return { ordem: MODULOS.map((m) => m.id), ocultos: [] }
  }
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
const quando = (t: number) => {
  const d = new Date(t)
  const hoje = new Date()
  const amanha = new Date(Date.now() + 86400000)
  if (d.toDateString() === hoje.toDateString()) return `hoje ${hhmm(t)}`
  if (d.toDateString() === amanha.toDateString()) return `amanhã ${hhmm(t)}`
  return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ' ' + hhmm(t)
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

function Relogio() {
  const [agora, set] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => set(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="ct-relogio">
      <b>{agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b>
      <span>{agora.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
    </div>
  )
}

function Tarefas() {
  const tarefas = useInteg((s) => s.tarefas)
  const [nova, setNova] = useState('')
  const abertas = tarefas.filter((t) => !t.feita).sort((a, b) => Number(b.prioridade === 'alta') - Number(a.prioridade === 'alta') || (a.prazo ?? 9e15) - (b.prazo ?? 9e15))
  const feitasHoje = tarefas.filter((t) => t.feita && (t.concluida ?? 0) > new Date().setHours(0, 0, 0, 0))
  const add = () => {
    if (!nova.trim()) return
    sendCerebro({ type: 'tarefa', tarefa: { texto: nova.trim() } })
    setNova('')
  }
  return (
    <>
      <div className="ct-add" onKeyDown={(e) => e.stopPropagation()}>
        <input value={nova} placeholder="Nova tarefa… (ou diga “adiciona tarefa…”)" onChange={(e) => setNova(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button onClick={add}>+</button>
      </div>
      {!abertas.length && <div className="md-livre">Nada pendente.</div>}
      {abertas.map((t) => (
        <div key={t.id} className={`ct-tarefa ${t.prazo && t.prazo < Date.now() ? 'atrasada' : ''}`}>
          <input type="checkbox" checked={false} onChange={() => sendCerebro({ type: 'tarefa', tarefa: { id: t.id, feita: true } })} title="Concluir" />
          <span>
            {t.prioridade === 'alta' && <i className="ct-alta">!</i>}
            {t.texto}
            {t.prazo && <small> · até {new Date(t.prazo).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</small>}
          </span>
          <button
            title={t.prioridade === 'alta' ? 'Prioridade normal' : 'Prioridade alta'}
            onClick={() => sendCerebro({ type: 'tarefa', tarefa: { id: t.id, prioridade: t.prioridade === 'alta' ? 'normal' : 'alta' } })}
          >
            !
          </button>
          <button title="Apagar" onClick={() => confirm(`Apagar a tarefa "${t.texto}"?`) && sendCerebro({ type: 'tarefa', tarefa: { id: t.id, remover: true } })}>
            ×
          </button>
        </div>
      ))}
      {feitasHoje.length > 0 && <div className="md-livre">✓ {feitasHoje.length} concluída{feitasHoje.length > 1 ? 's' : ''} hoje</div>}
    </>
  )
}

function Modulo({ id }: { id: ModId }) {
  const s = useInteg()
  const clima = useCards((c) => c.slots.find((x) => x.card.kind === 'clima')?.card.clima)
  switch (id) {
    case 'relogio':
      return <Relogio />
    case 'clima':
      return clima ? (
        <div className="ct-clima">
          <b>{Math.round(clima.temp)}°</b>
          <span>
            {clima.cidade} · {clima.desc}
            <br />
            mín {Math.round(clima.min ?? 0)}° · máx {Math.round(clima.max ?? 0)}° · chuva {Math.round(clima.chuva ?? 0)}%
          </span>
        </div>
      ) : (
        <div className="md-livre">Diga “como está o tempo?”.</div>
      )
    case 'agenda': {
      const prox = s.eventos.filter((e) => e.fim > Date.now()).slice(0, 4)
      if (!s.temAgenda) return <div className="md-livre">Agenda não conectada — ⚙ Configurações.</div>
      return (
        <>
          {!prox.length && <div className="md-livre">Nada nos próximos dias.</div>}
          {prox.map((e) => (
            <div key={e.id} className="ct-linha" style={{ borderLeftColor: e.cor }}>
              <span className="md-hora">{e.diaTodo ? 'DIA TODO' : quando(e.inicio)}</span> {e.titulo}
            </div>
          ))}
        </>
      )
    }
    case 'tarefas':
      return <Tarefas />
    case 'lembretes':
      return s.lembretes.length ? (
        <>
          {s.lembretes
            .slice()
            .sort((a, b) => a.quando - b.quando)
            .slice(0, 5)
            .map((l, i) => (
              <div key={i} className="ct-linha">
                <span className="md-hora">{quando(l.quando)}</span> {l.texto || 'timer'}
              </div>
            ))}
        </>
      ) : (
        <div className="md-livre">Nenhum lembrete. Diga “me lembra de… às…”.</div>
      )
    case 'rotinas':
      return (
        <>
          {!s.rotinas.length && <div className="md-livre">Nenhuma rotina ainda.</div>}
          {s.rotinas.slice(0, 5).map((r) => (
            <div key={r.id} className="ct-linha">
              <span className={`ct-dot ${r.ativa ? 'on' : ''}`} /> {r.nome} <small>· {descreverFreq(r)}</small>
            </div>
          ))}
          <button className="md-btn" onClick={() => abrirPainel('rotinas')}>
            Gerenciar rotinas
          </button>
        </>
      )
    case 'sistema': {
      const d = s.diag
      if (!d) return <div className="md-livre">Verificando…</div>
      const itens: [string, string, boolean][] = [
        ['Cérebro', String(d.modelo), true],
        ['Audição', String(d.audicao), d.audicao === 'pronta' || d.audicao === 'navegador'],
        ['Agenda', String(d.agenda), !String(d.agenda).includes('erro')],
        ['E-mails', String(d.emails), !String(d.emails).includes('erro')],
        ['Modo ação', d.modoAcao ? 'ligado' : 'desligado', true],
        ['Memória', `${d.memoriaMb} MB`, Number(d.memoriaMb) < 900],
      ]
      return (
        <div className="ct-sis">
          {itens.map(([k, v, ok]) => (
            <div key={k}>
              <span className={`ct-dot ${ok ? 'on' : 'mal'}`} />
              <b>{k}</b> {v}
            </div>
          ))}
        </div>
      )
    }
    case 'historico': {
      const hs = s.historico.filter((h) => h.tipo === 'pedido').slice(0, 6)
      return hs.length ? (
        <>
          {hs.map((h, i) => (
            <div key={i} className="ct-linha">
              <span className="md-hora">{hhmm(h.at)}</span> {h.texto}
            </div>
          ))}
        </>
      ) : (
        <div className="md-livre">Sem comandos ainda.</div>
      )
    }
  }
}

export function Central() {
  const [lay, setLay] = useState(lerLayout)
  const [editar, setEditar] = useState(false)
  useEffect(() => {
    sendCerebro({ type: 'org' })
    sendCerebro({ type: 'diagnostico' })
    const id = setInterval(() => sendCerebro({ type: 'diagnostico' }), 30000)
    return () => clearInterval(id)
  }, [])
  const salvar = (l: typeof lay) => {
    setLay(l)
    try {
      localStorage.setItem('jarvis-central', JSON.stringify(l))
    } catch {}
  }
  const mover = (id: ModId, d: number) => {
    const o = [...lay.ordem]
    const i = o.indexOf(id)
    const j = i + d
    if (j < 0 || j >= o.length) return
    ;[o[i], o[j]] = [o[j], o[i]]
    salvar({ ...lay, ordem: o })
  }
  const visiveis = lay.ordem.filter((id) => editar || !lay.ocultos.includes(id))
  return (
    <div className="sb md">
      <Topo titulo="◎ CENTRAL DE COMANDO" sub="o essencial do seu dia">
        <button className={`md-aba ${editar ? 'on' : ''}`} onClick={() => setEditar(!editar)} title="Escolher e ordenar os módulos">
          {editar ? 'PRONTO' : 'PERSONALIZAR'}
        </button>
      </Topo>
      <div className="md-corpo ct-grade">
        {visiveis.map((id) => {
          const m = MODULOS.find((x) => x.id === id)!
          const oculto = lay.ocultos.includes(id)
          return (
            <section key={id} className={`ct-mod ct-${id} ${oculto ? 'oculto' : ''}`}>
              <div className="ct-mod-tit">
                <span>{m.nome.toUpperCase()}</span>
                {editar && (
                  <span className="ct-edit">
                    <button onClick={() => mover(id, -1)} title="Subir">↑</button>
                    <button onClick={() => mover(id, 1)} title="Descer">↓</button>
                    <button onClick={() => salvar({ ...lay, ocultos: oculto ? lay.ocultos.filter((x) => x !== id) : [...lay.ocultos, id] })} title={oculto ? 'Mostrar' : 'Esconder'}>
                      {oculto ? '◌' : '●'}
                    </button>
                  </span>
                )}
              </div>
              {!oculto && <Modulo id={id} />}
            </section>
          )
        })}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ ROTINAS

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const COND: Record<Rotina['condicao'], string> = {
  sempre: 'sempre',
  'tem-compromisso': 'só se houver compromisso hoje',
  'tem-email-acao': 'só se houver e-mail pedindo ação',
  'tem-tarefa': 'só se houver tarefa aberta',
}
function descreverFreq(r: Rotina) {
  if (r.frequencia === 'intervalo') return `a cada ${r.intervaloMin} min`
  if (r.frequencia === 'dias-uteis') return `dias úteis às ${r.horario}`
  if (r.frequencia === 'semanal') return `${r.dias.map((d) => DIAS[d]).join(', ')} às ${r.horario}`
  return `todo dia às ${r.horario}`
}

const MODELOS: Partial<Rotina>[] = [
  { nome: 'Bom dia', descricao: 'Briefing da manhã: clima, agenda, e-mails e notícias', comando: 'bom dia', frequencia: 'dias-uteis', horario: '07:30' },
  { nome: 'E-mails importantes', descricao: 'Avisa quando algum e-mail pede ação', comando: 'tem e-mail importante?', frequencia: 'intervalo', intervaloMin: 60, condicao: 'tem-email-acao' },
  { nome: 'Agenda de amanhã', descricao: 'No fim do dia, o que vem amanhã', comando: 'o que eu tenho amanhã', frequencia: 'dias-uteis', horario: '18:30' },
  { nome: 'Tarefas pendentes', descricao: 'Revisão das tarefas abertas', comando: 'minhas tarefas', frequencia: 'diaria', horario: '09:00', condicao: 'tem-tarefa' },
]

const vazia = (): Partial<Rotina> => ({ nome: '', descricao: '', comando: '', frequencia: 'diaria', horario: '08:00', dias: [1, 2, 3, 4, 5], intervaloMin: 60, condicao: 'sempre', falar: true, ativa: true })

function Form({ r, onFim }: { r: Partial<Rotina>; onFim: () => void }) {
  const [f, setF] = useState<Partial<Rotina>>({ ...vazia(), ...r })
  const up = (p: Partial<Rotina>) => setF({ ...f, ...p })
  const ok = Boolean(f.nome?.trim() && f.comando?.trim())
  return (
    <div className="rt-form" onKeyDown={(e) => e.stopPropagation()}>
      <div className="md-linha">
        <input className="md-nome" placeholder="Nome" value={f.nome} onChange={(e) => up({ nome: e.target.value })} />
        <input className="md-url" placeholder="O que ele deve fazer (o mesmo que você falaria): ex. “bom dia”" value={f.comando} onChange={(e) => up({ comando: e.target.value })} />
      </div>
      <input className="rt-desc" placeholder="Descrição (opcional)" value={f.descricao} onChange={(e) => up({ descricao: e.target.value })} />
      <div className="md-linha rt-quando">
        <select value={f.frequencia} onChange={(e) => up({ frequencia: e.target.value as Rotina['frequencia'] })}>
          <option value="diaria">Todo dia</option>
          <option value="dias-uteis">Dias úteis</option>
          <option value="semanal">Dias escolhidos</option>
          <option value="intervalo">A cada X minutos</option>
        </select>
        {f.frequencia === 'intervalo' ? (
          <label>
            a cada <input type="number" min={15} max={1440} value={f.intervaloMin} onChange={(e) => up({ intervaloMin: Number(e.target.value) })} /> min
          </label>
        ) : (
          <input type="time" value={f.horario} onChange={(e) => up({ horario: e.target.value })} />
        )}
        <select value={f.condicao} onChange={(e) => up({ condicao: e.target.value as Rotina['condicao'] })}>
          {Object.entries(COND).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {f.frequencia === 'semanal' && (
        <div className="rt-dias">
          {DIAS.map((d, i) => (
            <button key={d} className={f.dias?.includes(i) ? 'on' : ''} onClick={() => up({ dias: f.dias?.includes(i) ? f.dias.filter((x) => x !== i) : [...(f.dias ?? []), i].sort() })}>
              {d}
            </button>
          ))}
        </div>
      )}
      <label className="md-check">
        <input type="checkbox" checked={f.falar} onChange={(e) => up({ falar: e.target.checked })} /> Falar o resultado em voz alta
      </label>
      <div className="md-linha">
        <button
          className="md-btn md-ok"
          disabled={!ok}
          onClick={() => {
            sendCerebro({ type: 'rotina', rotina: f })
            onFim()
          }}
        >
          Salvar rotina
        </button>
        <button className="md-btn" onClick={onFim}>
          Cancelar
        </button>
      </div>
    </div>
  )
}

export function Rotinas() {
  const rotinas = useInteg((s) => s.rotinas)
  const erro = useInteg((s) => s.orgErro)
  const [edit, setEdit] = useState<Partial<Rotina> | null>(null)
  const [hist, setHist] = useState<string | null>(null)
  useEffect(() => {
    sendCerebro({ type: 'org' })
  }, [])
  return (
    <div className="sb md">
      <Topo titulo="⟳ ROTINAS" sub="rodam sozinhas, mesmo com a janela escondida">
        <button className="md-aba" onClick={() => setEdit(vazia())}>
          + NOVA
        </button>
      </Topo>
      <div className="md-corpo">
        {erro && <div className="md-erros">⚠ {erro}</div>}
        {edit && <Form r={edit} onFim={() => setEdit(null)} />}
        {!rotinas.length && !edit && (
          <div className="md-vazio">
            <p>Nenhuma rotina ainda. Comece por uma destas:</p>
            <div className="rt-modelos">
              {MODELOS.map((m) => (
                <button key={m.nome} className="md-btn" onClick={() => setEdit({ ...vazia(), ...m })}>
                  {m.nome}
                </button>
              ))}
            </div>
          </div>
        )}
        {rotinas.map((r) => (
          <div key={r.id} className={`rt-item ${r.ativa ? '' : 'pausada'}`}>
            <div className="rt-top">
              <span className={`ct-dot ${r.ativa ? 'on' : ''}`} />
              <b>{r.nome}</b>
              <small>
                {descreverFreq(r)} · {COND[r.condicao]}
              </small>
              <span className="rt-acts">
                <button title="Rodar agora" onClick={() => sendCerebro({ type: 'rotina', rotina: { id: r.id, rodar: true } })}>▶</button>
                <button title={r.ativa ? 'Pausar' : 'Ativar'} onClick={() => sendCerebro({ type: 'rotina', rotina: { id: r.id, ativa: !r.ativa } })}>
                  {r.ativa ? '❚❚' : '●'}
                </button>
                <button title="Editar" onClick={() => setEdit(r)}>✎</button>
                <button title="Histórico" onClick={() => setHist(hist === r.id ? null : r.id)}>☰</button>
                <button title="Excluir" onClick={() => confirm(`Excluir a rotina "${r.nome}"?`) && sendCerebro({ type: 'rotina', rotina: { id: r.id, excluir: true } })}>
                  ×
                </button>
              </span>
            </div>
            <div className="rt-cmd">
              “{r.comando}”{r.descricao ? ` — ${r.descricao}` : ''}
            </div>
            {hist === r.id && (
              <div className="rt-hist">
                {!r.historico.length && <div className="md-livre">Ainda não rodou.</div>}
                {r.historico.map((h, i) => (
                  <div key={i}>
                    <span className="md-hora">{quando(h.at)}</span> {h.ok ? '✓' : '⚠'} {h.resumo || (h.ok ? 'executada' : 'falhou')}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
