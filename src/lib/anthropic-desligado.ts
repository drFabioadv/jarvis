/**
 * No build da nuvem (JARVIS 3.0) o caminho "direct" da Anthropic não existe:
 * este arquivo substitui src/lib/anthropic.ts (alias no vite.config.ts), e
 * assim o SDK da Anthropic nem entra no pacote do navegador.
 */
export type Msg = { role: 'user' | 'assistant'; content: unknown }
export type AskHandlers = { onText: (delta: string) => void; onTool: (name: string) => void }
const desligado = () => {
  throw new Error('caminho direto desativado no JARVIS 3.0')
}
export const ask = async (_m: Msg[], _h: AskHandlers): Promise<{ text: string; tools: string[] }> => desligado()
export const cancel = (): void => {}
export const connectedLabels = (): string[] => []
