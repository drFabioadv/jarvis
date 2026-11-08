import { create } from 'zustand'
import { useCerebro } from './cerebro'

/** Agenda, e-mails e configurações (⚙), vindos do cérebro (bridge). */
export type Evento = { id: string; titulo: string; local: string; inicio: number; fim: number; diaTodo: boolean; agenda: string; cor: string }
export type Email = {
  id: string; conta: string; cor: string; de: string; deEmail: string; assunto: string; data: number
  trecho: string; lido: boolean; balde: 'acao' | 'info' | 'ruido'; resumo: string; por: 'ia' | 'local'
}
export type Erro = { nome: string; erro: string }
export type AgendaCfg = { id: string; nome: string; cor: string; url: string; salvo?: boolean; apagarUrl?: boolean }
export type EmailCfg = { id: string; apelido: string; cor: string; usuario: string; senhaApp: string; host: string; salvo?: boolean; apagarSenha?: boolean }
export type Config = { agendas: AgendaCfg[]; emails: EmailCfg[]; modelo: string; digestAuto: boolean; modelos: Record<string, string> }
export type Painel = 'agenda' | 'emails' | 'config' | 'central' | 'rotinas' | null
export type Tarefa = { id: string; texto: string; prazo: number | null; prioridade: 'normal' | 'alta'; feita: boolean; criada: number; concluida?: number }
export type Rotina = {
  id: string; nome: string; descricao: string; comando: string
  frequencia: 'diaria' | 'dias-uteis' | 'semanal' | 'intervalo'; horario: string; dias: number[]; intervaloMin: number
  condicao: 'sempre' | 'tem-compromisso' | 'tem-email-acao' | 'tem-tarefa'; falar: boolean; ativa: boolean
  historico: { at: number; ok: boolean; resumo: string; motivo: string }[]; ultima: number
}
export type Atividade = { at: number; tipo: string; texto: string }
export type Diag = Record<string, string | number | boolean>
export type Prefs = { nome: string; cidade: string; temas: string[] }

type S = {
  eventos: Evento[]
  emails: Email[]
  agendaErros: Erro[]
  emailErros: Erro[]
  agendaAt: number
  emailsAt: number
  acao: number
  temAgenda: boolean
  temEmail: boolean
  carregando: { agenda: boolean; emails: boolean }
  config: Config | null
  salvoAt: number
  painel: Painel
  tarefas: Tarefa[]
  rotinas: Rotina[]
  historico: Atividade[]
  lembretes: { quando: number; texto: string }[]
  diag: Diag | null
  prefs: Prefs | null
  prefsMsg: string
  orgErro: string
  /** Dispara o morning digest (registrado pelo App). */
  digest: (() => void) | null
  set: (p: Partial<S>) => void
}

export const useInteg = create<S>((set) => ({
  eventos: [],
  emails: [],
  agendaErros: [],
  emailErros: [],
  agendaAt: 0,
  emailsAt: 0,
  acao: 0,
  temAgenda: false,
  temEmail: false,
  carregando: { agenda: false, emails: false },
  config: null,
  salvoAt: 0,
  painel: null,
  tarefas: [],
  rotinas: [],
  historico: [],
  lembretes: [],
  diag: null,
  prefs: null,
  prefsMsg: '',
  orgErro: '',
  digest: null,
  set: (p) => set(p),
}))

/** Abre um painel (ou o segundo cérebro); só um por vez. */
export function abrirPainel(p: Painel | 'cerebro') {
  const atual = useInteg.getState().painel
  if (p === 'cerebro') {
    useInteg.getState().set({ painel: null })
    useCerebro.getState().abrir(true)
    return
  }
  useCerebro.getState().abrir(false)
  useInteg.getState().set({ painel: p })
  void atual
}
