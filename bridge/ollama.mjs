/**
 * A IA local do JARVIS — um modelo de linguagem rodando no próprio PC, pelo
 * Ollama (https://ollama.com), sem gastar nada do Claude e sem internet.
 *
 * É o segundo degrau da economia:
 *   1. o cérebro local (local.mjs) resolve o que é comando conhecido;
 *   2. a IA local responde conversa e perguntas de conhecimento geral;
 *   3. o Claude só entra quando precisa de internet, de agir no computador,
 *      ou quando você pede ("pergunta pro Claude ...").
 *
 * Fica ligada sozinha quando o Ollama está instalado e o modelo baixado
 * (INSTALAR-IA-LOCAL.bat). Sem ele, tudo segue direto para o Claude.
 */

const BASE = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'

let cache = { at: 0, ok: false, models: [] }

/** O Ollama está rodando e com o modelo pedido? (consulta no máx. a cada 30 s) */
export async function ollamaReady(model) {
  if (Date.now() - cache.at > 30000) {
    try {
      const r = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(1200) })
      const j = await r.json()
      cache = { at: Date.now(), ok: true, models: (j.models ?? []).map((m) => m.name) }
    } catch {
      cache = { at: Date.now(), ok: false, models: [] }
    }
  }
  if (!cache.ok) return false
  return cache.models.some((m) => m === model || m.split(':')[0] === model.split(':')[0])
}

/**
 * Esse pedido precisa do Claude? Internet, ações no computador, documentos,
 * coisas de hoje — sim. Conversa e conhecimento geral — não.
 */
export function needsClaude(text) {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  if (/\b(pergunta (pro|para o|ao) claude|usa o claude|use o claude|com o claude|modo claude)\b/.test(t)) return true
  return /\b(pesquis|procur|busca|internet|site|link|abre|abra|abrir|clica|clique|digita|manda|envia|enviar|mensagem|email|e-mail|whatsapp|planilha|arquivo|pasta|documento|pdf|cria|criar|escreve um|escreva um|salva|salvar|instala|baixa|baixar|imagem|foto|desenha|gera|gerar|hoje|agora|atual|atualmente|ultim[oa]s?|recente|cotacao|preco|quanto custa|placar|jogo de|resultado d|previsao|noticia|edital|licitac|tela|camera|mostra|mostre|youtube|video|computador|pc)\b/.test(
    t,
  )
}

/**
 * Responde com a IA local, em fluxo. `onDelta` recebe cada pedaço de texto.
 * `history` é a conversa recente (mensagens {role, content}).
 */
export async function ollamaChat({ model, text, history, cfg, onDelta, signal }) {
  const now = new Date()
  const system =
    `Você é o JARVIS, o assistente pessoal do ${cfg.nome === 'senhor' ? 'usuário' : cfg.nome}, ` +
    'no estilo do mordomo do Homem de Ferro: educado, seco, um pouco irônico, nunca bajulador. ' +
    'Responda SEMPRE em português do Brasil, como numa conversa falada: sem listas, sem markdown, sem emojis. ' +
    'Conversa casual: até três frases. Se ele pedir opinião, sugestão ou explicação, opine com clareza e ' +
    'justifique em até oito frases. Não devolva perguntas nem peça confirmação: assuma o mais provável e responda. ' +
    'Chame-o de "senhor" às vezes. ' +
    'Escreva números e horas por extenso. Se não souber algo ou se for algo que muda com o tempo, ' +
    'diga que precisa consultar a internet. ' +
    `Agora são ${now.toLocaleString('pt-BR')} e ele está em ${cfg.cidade}.` +
    (cfg.cerebro ?? '')
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      keep_alive: '30m',
      options: { temperature: 0.7, num_predict: 450 },
      messages: [{ role: 'system', content: system }, ...history.slice(-8), { role: 'user', content: text }],
    }),
  })
  if (!res.ok || !res.body) throw new Error(`Ollama respondeu ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const j = JSON.parse(line)
        const piece = j.message?.content ?? ''
        if (piece) {
          full += piece
          onDelta(piece)
        }
      } catch {
        /* linha incompleta */
      }
    }
  }
  return full.trim()
}
