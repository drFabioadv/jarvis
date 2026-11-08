import { create } from 'zustand'

/**
 * Os cartões de informação (clima, notícias, arquivos, briefing...).
 *
 * Ficam abertos numa grade ao lado do JARVIS; cada um pode ser minimizado
 * para a aba embaixo dele ou fechado. Sem nenhum aberto, o JARVIS volta para
 * o centro da tela.
 */
export type Card = {
  id: string
  kind: 'status' | 'clima' | 'noticia' | 'texto' | 'lista' | 'video'
  kicker?: string
  title?: string
  text?: string
  image?: string
  source?: string
  link?: string
  chips?: string[]
  active?: string
  transient?: boolean
  painel?: boolean
  lote?: string
  items?: { label: string; sub?: string }[]
  clima?: {
    cidade: string
    temp: number
    sensacao?: number
    umidade?: number
    vento?: number
    min?: number
    max?: number
    chuva?: number
    desc?: string
    icon?: string
  }
}

export type Slot = { card: Card; min: boolean; at: number }

type CardsState = {
  slots: Slot[]
  /** O cartão mais recente — ganha destaque. */
  latest: string | null
  push: (c: Card) => void
  minimize: (id: string) => void
  restore: (id: string) => void
  close: (id: string) => void
  minimizeAll: () => void
  restoreAll: () => void
}

/** Quantos ficam abertos ao mesmo tempo; os mais antigos vão para a aba. */
const MAX_OPEN = 7
const MAX_TOTAL = 16

export const useCards = create<CardsState>((set) => ({
  slots: [],
  latest: null,
  push: (c) =>
    set((s) => {
      let slots = s.slots
      // Um "status" transitório (ex.: "Atualizando o radar...") é trocado pelo
      // próximo cartão, não acumulado.
      slots = slots.filter((x) => !x.card.transient)
      // Painel inicial novo substitui o anterior.
      if (c.painel) slots = slots.filter((x) => !x.card.painel || x.card.lote === c.lote)
      // Mesmo tipo de clima: o novo substitui o velho.
      if (c.kind === 'clima') slots = slots.filter((x) => x.card.kind !== 'clima')
      slots = [...slots, { card: c, min: false, at: Date.now() }]
      const open = slots.filter((x) => !x.min)
      if (open.length > MAX_OPEN) {
        // O clima fica sempre aberto; os mais antigos dos outros vão para a aba.
        const candidatos = open.filter((x) => x.card.kind !== 'clima')
        const excess = new Set(candidatos.slice(0, open.length - MAX_OPEN).map((x) => x.card.id))
        slots = slots.map((x) => (excess.has(x.card.id) ? { ...x, min: true } : x))
      }
      return { slots: slots.slice(-MAX_TOTAL), latest: c.id }
    }),
  minimize: (id) => set((s) => ({ slots: s.slots.map((x) => (x.card.id === id ? { ...x, min: true } : x)) })),
  restore: (id) => set((s) => ({ slots: s.slots.map((x) => (x.card.id === id ? { ...x, min: false } : x)), latest: id })),
  close: (id) => set((s) => ({ slots: s.slots.filter((x) => x.card.id !== id) })),
  minimizeAll: () => set((s) => ({ slots: s.slots.map((x) => ({ ...x, min: true })) })),
  restoreAll: () =>
    set((s) => ({ slots: s.slots.map((x, i, a) => ({ ...x, min: i < a.length - MAX_OPEN })) })),
}))
