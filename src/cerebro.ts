import { create } from 'zustand'

/** O Segundo Cérebro: as notas da sua vida, vindas do cérebro (bridge). */
export type Nota = { id: string; area: string; title: string; body: string; at?: number }

export const AREA: Record<string, { label: string; color: string }> = {
  metas: { label: 'Metas', color: '#fbbf24' },
  trabalho: { label: 'Carreira', color: '#ff5547' },
  projetos: { label: 'Projetos', color: '#8b7cff' },
  financas: { label: 'Finanças', color: '#f7931a' },
  aprendizado: { label: 'Aprendizado', color: '#2dd4ff' },
  saude: { label: 'Saúde', color: '#10b981' },
  relacoes: { label: 'Relações', color: '#ec4899' },
  meta: { label: 'Você', color: '#8a90a6' },
}

type S = {
  notas: Nota[]
  rel: [string, string][]
  flash: string | null
  flashAt: number
  aberto: boolean
  set: (m: { notas?: Nota[]; rel?: [string, string][]; flash?: string | null }) => void
  abrir: (v?: boolean) => void
}

export const useCerebro = create<S>((set) => ({
  notas: [],
  rel: [],
  flash: null,
  flashAt: 0,
  aberto: false,
  set: (m) =>
    set((s) => ({
      notas: m.notas ?? s.notas,
      rel: m.rel ?? s.rel,
      flash: m.flash ?? null,
      flashAt: m.flash ? Date.now() : s.flashAt,
    })),
  abrir: (v) => set((s) => ({ aberto: v ?? !s.aberto })),
}))
