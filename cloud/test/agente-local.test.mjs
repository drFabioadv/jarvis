// O agente local só aceita comandos da lista e valida cada argumento.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMANDOS } from '../../agente-local/jarvis-agente.mjs'

const raiz = mkdtempSync(join(tmpdir(), 'jarvis-agente-'))
mkdirSync(join(raiz, 'Documentos'))
writeFileSync(join(raiz, 'Documentos', 'edital.pdf'), 'x')
const cfg = { pastas: [join(raiz, 'Documentos')] }

test('abrir: só http/https; pastas só dentro das liberadas', async () => {
  await assert.rejects(COMANDOS.abrir({ tipo: 'url', alvo: 'javascript:alert(1)' }, cfg), /http/)
  await assert.rejects(COMANDOS.abrir({ tipo: 'url', alvo: 'file:///C:/Windows' }, cfg), /http/)
  await assert.rejects(COMANDOS.abrir({ tipo: 'pasta', alvo: '/etc' }, cfg), /fora das liberadas/)
  await assert.rejects(COMANDOS.abrir({ tipo: 'pasta', alvo: join(raiz, 'Documentos', '..', '..') }, cfg), /fora das liberadas/)
  await assert.rejects(COMANDOS.abrir({ tipo: 'qualquer', alvo: 'x' }, cfg), /tipo inválido/)
})

test('listar: nomes de arquivos só nas pastas liberadas', async () => {
  const r = await COMANDOS.listar({ pasta: join(raiz, 'Documentos'), busca: 'edital' }, cfg)
  assert.deepEqual(r.itens, [{ nome: 'edital.pdf', pasta: false }])
  await assert.rejects(COMANDOS.listar({ pasta: '/' }, cfg), /fora das liberadas/)
})

test('sem shell remoto: só os comandos da lista existem', () => {
  assert.deepEqual(Object.keys(COMANDOS).sort(), ['abrir', 'listar', 'sistema'])
})
