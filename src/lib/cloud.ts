/**
 * O cérebro do JARVIS 3.0 na nuvem, visto pelo navegador.
 *
 * Toda a conversa passa pela API própria (/api/conversa, em streaming SSE),
 * com o cookie de sessão. Nenhuma chave de modelo chega ao navegador: quem
 * fala com os modelos é o servidor.
 */
import { create } from 'zustand'
import type { AskHandlers } from './anthropic'

export type Pendente = { id: string; ferramenta: string; resumo: string }

export const useNuvem = create<{
  pendentes: Pendente[]
  conversaId: string | null
  online: boolean
  erro: string
  set: (p: Partial<{ pendentes: Pendente[]; conversaId: string | null; online: boolean; erro: string }>) => void
}>((set) => ({ pendentes: [], conversaId: null, online: true, erro: '', set: (p) => set(p) }))

/** Chamada à API com cookie e o cabeçalho anti-CSRF. */
export async function api<T = unknown>(caminho: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const r = await fetch(caminho, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: { 'x-jarvis': '1', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  })
  const j = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text()
  if (!r.ok) throw Object.assign(new Error((j as { erro?: string })?.erro ?? `erro ${r.status}`), { status: r.status, dados: j })
  return j as T
}

let ativo: AbortController | null = null

const SIM = /^(sim|confirmo|confirma|pode|pode sim|isso|ok|okay|beleza|manda|faz|fa[cç]a|claro|positivo)\b/i
const NAO = /^(n[aã]o|cancela|deixa|recuso|nega|negativo|para)\b/i

/** Decide uma ação pendente (botão ou voz). */
export async function decidir(id: string, confirmar: boolean): Promise<string> {
  const r = await api<{ estado: string; erro?: string }>(`/api/acoes/${id}`, { method: 'POST', body: { confirmar } })
  useNuvem.getState().set({ pendentes: useNuvem.getState().pendentes.filter((p) => p.id !== id) })
  if (r.estado === 'confirmada') return 'Feito, senhor.'
  if (r.estado === 'recusada') return 'Cancelado.'
  if (r.estado === 'expirada') return 'Essa confirmação expirou; peça de novo.'
  return `Não consegui: ${r.erro ?? r.estado}.`
}

export async function ask(prompt: string, handlers: AskHandlers): Promise<{ text: string; tools: string[] }> {
  // "Sim"/"não" logo depois de uma ação pendente: decide sem gastar modelo.
  const pend = useNuvem.getState().pendentes
  const limpo = prompt.trim().replace(/^(jarvis|amig[aã]o)[,\s]*/i, '')
  if (pend.length && (SIM.test(limpo) || NAO.test(limpo)) && limpo.split(/\s+/).length <= 4) {
    const t = await decidir(pend[0].id, SIM.test(limpo)).catch((e) => `Não consegui: ${e.message}`)
    handlers.onText(t)
    return { text: t, tools: [] }
  }

  ativo?.abort()
  const ctrl = new AbortController()
  ativo = ctrl
  const ferramentas: string[] = []
  let texto = ''
  try {
    const r = await fetch('/api/conversa', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-jarvis': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ texto: prompt, conversaId: useNuvem.getState().conversaId ?? undefined, canal: 'voz' }),
      signal: ctrl.signal,
    })
    if (r.status === 401 || r.status === 403) {
      location.reload()
      return { text: '', tools: [] }
    }
    if (!r.ok || !r.body) throw new Error(`a nuvem respondeu ${r.status}`)
    useNuvem.getState().set({ online: true, erro: '' })
    const leitor = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await leitor.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const bloco = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (!bloco.startsWith('data: ')) continue
        const e = JSON.parse(bloco.slice(6))
        if (e.tipo === 'inicio' && e.conversaId) useNuvem.getState().set({ conversaId: e.conversaId })
        else if (e.tipo === 'texto') {
          texto += e.delta
          handlers.onText(e.delta)
        } else if (e.tipo === 'ferramenta') {
          ferramentas.push(e.nome)
          handlers.onTool(e.nome)
        } else if (e.tipo === 'fim') {
          if (!texto && e.texto) {
            texto = e.texto
            handlers.onText(e.texto)
          }
          if (e.pendentes?.length) useNuvem.getState().set({ pendentes: [...e.pendentes, ...useNuvem.getState().pendentes] })
        } else if (e.tipo === 'erro' && !texto) {
          texto = e.mensagem
          handlers.onText(e.mensagem)
        }
      }
    }
  } catch (err) {
    if (ctrl.signal.aborted) return { text: texto, tools: ferramentas }
    useNuvem.getState().set({ online: false, erro: String((err as Error).message) })
    const msg = 'Não consegui falar com a nuvem agora, senhor. Confira a conexão.'
    handlers.onText(msg)
    return { text: msg, tools: ferramentas }
  } finally {
    if (ativo === ctrl) ativo = null
  }
  return { text: texto, tools: ferramentas }
}

export function cancel(): void {
  ativo?.abort()
  ativo = null
}

export const isConnected = () => useNuvem.getState().online
