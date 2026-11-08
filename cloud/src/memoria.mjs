/**
 * Memória persistente (o "segundo cérebro" no PostgreSQL).
 *
 * Tipos: fato, preferencia, projeto, conhecimento, decisao, pessoa e
 * temporario (este expira sozinho). Busca híbrida: semântica (pgvector, se
 * houver modelo de embeddings) + texto completo em português + semelhança de
 * título. Ao salvar, procura duplicatas e atualiza em vez de repetir.
 */
import { q } from './db.mjs'

export const TIPOS = ['fato', 'preferencia', 'projeto', 'conhecimento', 'decisao', 'pessoa', 'temporario']

const vetor = (v) => (v ? `[${v.map((x) => Number(x).toFixed(6)).join(',')}]` : null)

export function criarMemoria({ gateway }) {
  async function embutir(texto, ownerId) {
    if (!gateway?.temNivel('embeddings')) return null
    try {
      const [v] = (await gateway.embeddings([texto.slice(0, 2000)], { ownerId })) ?? []
      return v ?? null
    } catch (err) {
      console.warn('[memória] embeddings falharam, salvando sem vetor:', err.message)
      return null
    }
  }

  /** Acha uma memória que já diz a mesma coisa (mesmo título ou vetor muito próximo). */
  async function duplicata(ownerId, titulo, emb) {
    const porTitulo = await q(`SELECT * FROM memorias WHERE owner_id = $1 AND lower(titulo) = lower($2) LIMIT 1`, [ownerId, titulo])
    if (porTitulo.rows[0]) return porTitulo.rows[0]
    if (emb) {
      const r = await q(
        `SELECT *, embedding <=> $2::vector AS dist FROM memorias
         WHERE owner_id = $1 AND embedding IS NOT NULL AND vector_dims(embedding) = vector_dims($2::vector)
         ORDER BY embedding <=> $2::vector LIMIT 1`,
        [ownerId, vetor(emb)],
      )
      if (r.rows[0] && r.rows[0].dist < 0.08) return r.rows[0]
    }
    return null
  }

  async function salvar(ownerId, { tipo = 'fato', titulo, conteudo, importancia = 3, origem = 'usuario', expiraEm = null }) {
    if (!TIPOS.includes(tipo)) tipo = 'fato'
    titulo = String(titulo ?? '').trim().slice(0, 120)
    conteudo = String(conteudo ?? '').trim().slice(0, 4000)
    if (!titulo || !conteudo) throw new Error('memória precisa de título e conteúdo')
    if (tipo === 'temporario' && !expiraEm) expiraEm = new Date(Date.now() + 7 * 86400000)
    const emb = await embutir(`${titulo}\n${conteudo}`, ownerId)
    const dup = await duplicata(ownerId, titulo, emb)
    if (dup) {
      const r = await q(
        `UPDATE memorias SET tipo = $3, titulo = $4, conteudo = $5, embedding = COALESCE($6::vector, embedding),
           importancia = GREATEST(importancia, $7), expira_em = $8, atualizada = now()
         WHERE id = $1 AND owner_id = $2 RETURNING id, tipo, titulo, conteudo, importancia, origem, expira_em, criada, atualizada`,
        [dup.id, ownerId, tipo, titulo, conteudo, vetor(emb), importancia, expiraEm],
      )
      return { memoria: r.rows[0], atualizada: true }
    }
    const r = await q(
      `INSERT INTO memorias (owner_id, tipo, titulo, conteudo, embedding, importancia, origem, expira_em)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8)
       RETURNING id, tipo, titulo, conteudo, importancia, origem, expira_em, criada, atualizada`,
      [ownerId, tipo, titulo, conteudo, vetor(emb), importancia, origem, expiraEm],
    )
    return { memoria: r.rows[0], atualizada: false }
  }

  async function atualizar(ownerId, id, campos) {
    const atual = (await q('SELECT * FROM memorias WHERE id = $1 AND owner_id = $2', [id, ownerId])).rows[0]
    if (!atual) return null
    const titulo = campos.titulo ?? atual.titulo
    const conteudo = campos.conteudo ?? atual.conteudo
    const mudouTexto = titulo !== atual.titulo || conteudo !== atual.conteudo
    const emb = mudouTexto ? await embutir(`${titulo}\n${conteudo}`, ownerId) : null
    const r = await q(
      `UPDATE memorias SET tipo = $3, titulo = $4, conteudo = $5, importancia = $6,
         embedding = CASE WHEN $7::boolean THEN $8::vector ELSE embedding END, atualizada = now()
       WHERE id = $1 AND owner_id = $2 RETURNING id, tipo, titulo, conteudo, importancia, origem, expira_em, criada, atualizada`,
      [id, ownerId, TIPOS.includes(campos.tipo) ? campos.tipo : atual.tipo, titulo, conteudo, campos.importancia ?? atual.importancia, mudouTexto, vetor(emb)],
    )
    return r.rows[0]
  }

  async function excluir(ownerId, id) {
    const r = await q('DELETE FROM memorias WHERE id = $1 AND owner_id = $2', [id, ownerId])
    return r.rowCount > 0
  }

  /** Busca por linguagem natural: vetor + texto completo + título parecido. */
  async function buscar(ownerId, consulta, { k = 6, tipos } = {}) {
    consulta = String(consulta ?? '').trim()
    if (!consulta) return []
    const emb = await embutir(consulta, ownerId)
    const filtroTipo = tipos?.length ? 'AND tipo = ANY($4::text[])' : ''
    const r = await q(
      `WITH c AS (
         SELECT id, tipo, titulo, conteudo, importancia, atualizada,
           CASE WHEN $3::vector IS NOT NULL AND embedding IS NOT NULL AND vector_dims(embedding) = vector_dims($3::vector)
                THEN 1 - (embedding <=> $3::vector) ELSE 0 END AS sem,
           ts_rank(busca, websearch_to_tsquery('portuguese', $2)) AS txt,
           similarity(titulo, $2) AS tit
         FROM memorias
         WHERE owner_id = $1 AND (expira_em IS NULL OR expira_em > now()) ${filtroTipo}
       )
       SELECT *, (sem * 0.6 + LEAST(txt, 1) * 0.3 + tit * 0.3 + importancia * 0.02) AS nota
       FROM c WHERE sem > 0.35 OR txt > 0 OR tit > 0.25
       ORDER BY nota DESC LIMIT ${Math.min(Math.max(1, k), 30)}`,
      tipos?.length ? [ownerId, consulta, vetor(emb), tipos] : [ownerId, consulta, vetor(emb)],
    )
    return r.rows
  }

  async function listar(ownerId, { tipo, limite = 200 } = {}) {
    const r = await q(
      `SELECT id, tipo, titulo, conteudo, importancia, origem, expira_em, criada, atualizada FROM memorias
       WHERE owner_id = $1 AND (expira_em IS NULL OR expira_em > now()) ${tipo ? 'AND tipo = $2' : ''}
       ORDER BY importancia DESC, atualizada DESC LIMIT ${Math.min(limite, 1000)}`,
      tipo ? [ownerId, tipo] : [ownerId],
    )
    return r.rows
  }

  async function relacionar(ownerId, a, b, tipo = 'relacionada') {
    const ok = await q('SELECT count(*)::int AS n FROM memorias WHERE owner_id = $1 AND id = ANY($2::uuid[])', [ownerId, [a, b]])
    if (ok.rows[0].n !== 2) return false
    await q('INSERT INTO memoria_relacoes (a, b, tipo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [a, b, tipo])
    return true
  }

  async function relacoes(ownerId) {
    const r = await q(`SELECT r.a, r.b, r.tipo FROM memoria_relacoes r JOIN memorias m ON m.id = r.a WHERE m.owner_id = $1`, [ownerId])
    return r.rows
  }

  /** O que entra no contexto de cada conversa: preferências + o que tem a ver com o pedido. */
  async function contexto(ownerId, pedido) {
    const prefs = (await q(`SELECT tipo, titulo, conteudo FROM memorias WHERE owner_id = $1 AND tipo = 'preferencia' AND (expira_em IS NULL OR expira_em > now()) ORDER BY importancia DESC, atualizada DESC LIMIT 8`, [ownerId])).rows
    const rel = pedido ? await buscar(ownerId, pedido, { k: 6 }) : []
    const vistos = new Set()
    return [...prefs, ...rel].filter((m) => (vistos.has(m.titulo) ? false : vistos.add(m.titulo)))
  }

  async function limparExpiradas() {
    const r = await q('DELETE FROM memorias WHERE expira_em IS NOT NULL AND expira_em < now()')
    return r.rowCount
  }

  return { salvar, atualizar, excluir, buscar, listar, relacionar, relacoes, contexto, limparExpiradas }
}

/**
 * Consolidação: lê as mensagens novas de uma conversa e pede ao modelo rápido
 * só o que vale guardar. Conversa comum NÃO vira fato: só entra o que o
 * modelo marcar com importância ≥ 4; coisas passageiras viram "temporario".
 */
export async function consolidarConversa({ gateway, memoria, ownerId, conversaId }) {
  const conv = (await q('SELECT * FROM conversas WHERE id = $1 AND owner_id = $2', [conversaId, ownerId])).rows[0]
  if (!conv) return { salvas: 0 }
  const msgs = (await q(`SELECT id, papel, conteudo FROM mensagens WHERE conversa_id = $1 AND id > $2 AND papel IN ('usuario','jarvis') ORDER BY id LIMIT 80`, [conversaId, conv.consolidada_ate])).rows
  if (msgs.length < 2) return { salvas: 0 }
  const texto = msgs.map((m) => `${m.papel === 'usuario' ? 'USUÁRIO' : 'JARVIS'}: ${m.conteudo.slice(0, 600)}`).join('\n')
  const r = await gateway.conversar({
    nivel: 'rapido',
    ownerId,
    formatoJson: true,
    temperatura: 0,
    maxTokens: 700,
    mensagens: [
      {
        role: 'system',
        content:
          'Você extrai MEMÓRIAS DURÁVEIS sobre o usuário a partir de uma conversa. Só o que o USUÁRIO afirmou sobre si, suas preferências, projetos, decisões e pessoas próximas. ' +
          'Ignore perguntas gerais, conversa fiada e o que o assistente disse. Nunca extraia senhas, números de documentos ou dados bancários. ' +
          'Responda SÓ com JSON: {"resumo":"uma frase sobre a conversa","memorias":[{"tipo":"fato|preferencia|projeto|decisao|pessoa|temporario","titulo":"2 a 5 palavras","conteudo":"frase curta","importancia":1-5}]}. ' +
          'importancia 5 = essencial e duradouro; 1 = trivial. Se nada valer guardar, memorias = [].',
      },
      { role: 'user', content: texto },
    ],
  })
  let j = {}
  try {
    j = JSON.parse(/\{[\s\S]*\}/.exec(r.content ?? '')?.[0] ?? '{}')
  } catch {
    j = {}
  }
  let salvas = 0
  for (const m of Array.isArray(j.memorias) ? j.memorias.slice(0, 10) : []) {
    const imp = Math.max(1, Math.min(5, Number(m.importancia) || 1))
    if (!m.titulo || !m.conteudo) continue
    if (m.tipo === 'temporario') {
      if (imp < 3) continue
    } else if (imp < 4) continue
    if (/senha|cpf|cart[aã]o|conta banc|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/i.test(`${m.titulo} ${m.conteudo}`)) continue
    await memoria.salvar(ownerId, { tipo: TIPOS.includes(m.tipo) ? m.tipo : 'fato', titulo: m.titulo, conteudo: m.conteudo, importancia: imp, origem: 'consolidacao' })
    salvas++
  }
  await q('UPDATE conversas SET consolidada_ate = $2, resumo = COALESCE($3, resumo) WHERE id = $1', [conversaId, msgs[msgs.length - 1].id, typeof j.resumo === 'string' ? j.resumo.slice(0, 400) : null])
  return { salvas }
}
