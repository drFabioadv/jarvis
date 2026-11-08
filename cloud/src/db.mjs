/**
 * PostgreSQL: conexão, transações e migrações (arquivos NNN_nome.up.sql /
 * NNN_nome.down.sql em cloud/migrations, aplicadas em ordem e registradas).
 */
import pg from 'pg'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PASTA = fileURLToPath(new URL('../migrations', import.meta.url))
let pool = null

export function abrirBanco(url) {
  if (pool) return pool
  pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30000 })
  pool.on('error', (err) => console.error('[db] conexão ociosa falhou:', err.message))
  return pool
}

export function banco() {
  if (!pool) throw new Error('banco não aberto')
  return pool
}

export async function fecharBanco() {
  if (pool) await pool.end()
  pool = null
}

export const q = (texto, valores) => banco().query(texto, valores)

export async function transacao(fn) {
  const c = await banco().connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    c.release()
  }
}

function listar() {
  return readdirSync(PASTA)
    .map((f) => /^(\d+)_(.+)\.(up|down)\.sql$/.exec(f))
    .filter(Boolean)
    .reduce((acc, [arq, num, nome, dir]) => {
      const v = (acc[num] ??= { versao: Number(num), nome })
      v[dir] = join(PASTA, arq)
      return acc
    }, {})
}

export async function migrar(direcao = 'up', { ate } = {}) {
  await q('CREATE TABLE IF NOT EXISTS schema_migracoes (versao integer PRIMARY KEY, nome text NOT NULL, aplicada timestamptz NOT NULL DEFAULT now())')
  // Um migrador por vez (vários containers subindo juntos).
  await q('SELECT pg_advisory_lock(424242)')
  try {
    const feitas = new Set((await q('SELECT versao FROM schema_migracoes')).rows.map((r) => r.versao))
    const todas = Object.values(listar()).sort((a, b) => a.versao - b.versao)
    const aplicadas = []
    if (direcao === 'up') {
      for (const m of todas) {
        if (feitas.has(m.versao) || (ate && m.versao > ate)) continue
        await transacao(async (c) => {
          await c.query(readFileSync(m.up, 'utf8'))
          await c.query('INSERT INTO schema_migracoes (versao, nome) VALUES ($1, $2)', [m.versao, m.nome])
        })
        aplicadas.push(m.versao)
      }
    } else {
      const ultima = todas.filter((m) => feitas.has(m.versao)).pop()
      if (ultima) {
        if (!ultima.down) throw new Error(`migração ${ultima.versao} não tem volta (.down.sql)`)
        await transacao(async (c) => {
          await c.query(readFileSync(ultima.down, 'utf8'))
          await c.query('DELETE FROM schema_migracoes WHERE versao = $1', [ultima.versao])
        })
        aplicadas.push(ultima.versao)
      }
    }
    return aplicadas
  } finally {
    await q('SELECT pg_advisory_unlock(424242)')
  }
}
