#!/usr/bin/env node
/**
 * Exporta os dados do JARVIS 2.0 (pasta do PC) para importar na nuvem.
 * Uso: node cloud/src/cli/exportar-local.mjs [pasta-do-jarvis] > jarvis-pacote.json
 * Não inclui credenciais: integracoes.json, senhas e tokens ficam de fora.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const pasta = resolve(process.argv[2] ?? '.')
const ler = (n, p) => {
  try {
    return existsSync(join(pasta, n)) ? JSON.parse(readFileSync(join(pasta, n), 'utf8')) : p
  } catch {
    return p
  }
}
const cerebro = ler('segundo-cerebro.json', { notas: [] })
const pacote = {
  formato: 'jarvis-2-pacote',
  versao: 1,
  notas: (cerebro.notas ?? []).map(({ area, title, body }) => ({ area, title, body })),
  tarefas: ler('tarefas.json', []).map(({ texto, prazo, prioridade, feita }) => ({ texto, prazo: prazo ?? null, prioridade, feita })),
  rotinas: ler('rotinas.json', []).map(({ nome, comando, frequencia, horario, dias, intervaloMin, ativa }) => ({ nome, comando, frequencia, horario, dias, intervaloMin, ativa })),
  lembretes: ler('lembretes.json', []).map(({ quando, texto }) => ({ quando, texto: texto ?? '' })),
}
process.stdout.write(JSON.stringify(pacote, null, 2))
process.stderr.write(`\n${pacote.notas.length} notas, ${pacote.tarefas.length} tarefas, ${pacote.rotinas.length} rotinas, ${pacote.lembretes.length} lembretes — sem credenciais.\n`)
