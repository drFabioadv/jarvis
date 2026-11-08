import { create } from 'zustand'

/**
 * Os cartões do briefing (layout do vídeo).
 *
 * O cartão mais novo aparece grande no centro; quando chega outro, o anterior
 * desce para a fileira de baixo. Um novo "bom dia" limpa a fileira.
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

type CardsState = {
  active: Card | null
  dock: Card[]
  push: (c: Card) => void
  clear: () => void
}

const MAX_DOCK = 8

export const useCards = create<CardsState>((set) => ({
  active: null,
  dock: [],
  push: (c) =>
    set((s) => {
      // Um novo briefing começa do zero.
      const fresh = c.kind === 'status'
      const dock = fresh ? [] : s.active && !s.active.transient ? [...s.dock, s.active] : s.dock
      return { active: c, dock: dock.slice(-MAX_DOCK) }
    }),
  clear: () => set({ active: null, dock: [] }),
}))
