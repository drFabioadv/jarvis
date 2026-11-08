// Tarefas, rotinas, histórico, memória e agenda avançada (cérebro local).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as org from '../bridge/organizador.mjs'
import { iniciarCerebro, salvarNota, excluirNota, cerebro } from '../bridge/cerebro.mjs'
import { handleLocal, loadConfig, horaDoTexto, diaDoTexto, horariosLivres, conflitos } from '../bridge/local.mjs'

const dir = mkdtempSync(join(tmpdir(), 'jarvis-org-'))
org.iniciarOrganizador(dir, { semRelogio: true, executar: async () => ({ ok: true, resumo: 'feito' }) })
iniciarCerebro(dir)
const H = 3600000
const hoje = (h, m = 0) => new Date(new Date().setHours(h, m, 0, 0)).getTime()
const amanha = (h) => hoje(h) + 24 * H
const eventos = [
  { titulo: 'Reunião A', inicio: amanha(9), fim: amanha(10), diaTodo: false },
  { titulo: 'Reunião B', inicio: amanha(9.5), fim: amanha(11), diaTodo: false },
  { titulo: 'Almoço', inicio: amanha(12), fim: amanha(13), diaTodo: false },
]
const aberturas = []
const state = {}
const ctx = () => ({
  config: loadConfig(dir),
  state,
  open: (x) => aberturas.push(x),
  salvarNota,
  excluirNota,
  integ: { estado: () => ({ temAgenda: true, temEmail: true, eventos, emails: [{ de: 'Maria', conta: 'Pessoal', assunto: 'Contrato de honorários', resumo: 'Pede a minuta do contrato', trecho: '', data: Date.now(), balde: 'acao', lido: false }], acao: 1 }) },
  org: { ...org, avisarOrg: () => {} },
})
const ask = async (t) => (await handleLocal(t, ctx()))?.map((s) => s.say).join(' ') ?? null

test('tarefas: adicionar com prazo, listar, sem duplicar, concluir', async () => {
  assert.match(await ask('jarvis adiciona tarefa revisar o edital do pregão pra sexta'), /Tarefa anotada, para/)
  assert.match(await ask('adiciona tarefa revisar o edital do pregão'), /já estava na lista/)
  await ask('adiciona tarefa comprar toner urgente')
  assert.equal(org.listarTarefas().length, 2)
  assert.equal(org.listarTarefas().find((t) => /toner/.test(t.texto)).prioridade, 'alta')
  assert.match(await ask('minhas tarefas'), /duas tarefas pendentes/)
  assert.match(await ask('conclui a tarefa do edital'), /Feito: Revisar o edital/)
  assert.equal(org.listarTarefas().length, 1)
  assert.ok(JSON.parse(readFileSync(join(dir, 'tarefas.json'), 'utf8')).length >= 2, 'persistiu no disco')
})

test('apagar tarefa e nota pede confirmação', async () => {
  assert.match(await ask('apaga a tarefa do toner'), /Confirma\?/)
  assert.equal(org.listarTarefas().length, 1, 'não apaga antes de confirmar')
  assert.match(await ask('sim'), /removida/)
  assert.equal(org.listarTarefas().length, 0)
  salvarNota({ area: 'metas', title: 'CNH', body: 'Renovar a carteira de motorista até março' })
  assert.match(await ask('esquece a nota sobre carteira de motorista'), /Confirma\?/)
  assert.match(await ask('não'), /cancelado/)
  assert.ok(cerebro().notas.some((n) => n.title === 'CNH'))
})

test('memória: busca por linguagem natural', async () => {
  salvarNota({ area: 'projetos', title: 'Radar', body: 'Decidi usar o PNCP como fonte principal das licitações' })
  assert.match(await ask('o que eu tinha decidido sobre licitações'), /PNCP/)
  assert.match(await ask('procura no meu cérebro carteira de motorista'), /Renovar a carteira/)
  assert.match(await ask('procura no meu cérebro astronomia'), /Não encontrei/)
  assert.equal(await ask('o que você sabe sobre buracos negros'), null, 'pergunta geral vai para o Claude')
})

test('agenda: hora e dia, livres, conflitos, criar com confirmação', async () => {
  assert.deepEqual(horaDoTexto('as 14 horas'), { h: 14, min: 0 })
  assert.deepEqual(horaDoTexto('as 9 e meia'), { h: 9, min: 30 })
  assert.deepEqual(horaDoTexto('as 2 da tarde'), { h: 14, min: 0 })
  assert.equal(diaDoTexto('amanha'), 1)
  assert.equal(conflitos(eventos).length, 1)
  const livres = horariosLivres(eventos, 1)
  assert.equal(new Date(livres[0][0]).getHours(), 8)
  assert.equal(new Date(livres[1][0]).getHours(), 11)
  assert.match(await ask('tenho algum compromisso amanhã'), /Reunião A.*se sobrepõem/)
  const r = await ask('marca uma reunião com o cliente amanhã às 9 horas')
  assert.match(r, /Reunião com o cliente, amanhã às nove.*choca com Reunião A/)
  assert.equal(aberturas.length, 0, 'nada abre antes da confirmação')
  assert.match(await ask('confirmo'), /Google Agenda/)
  assert.match(aberturas[0], /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Reuni%C3%A3o%20com%20o%20cliente/)
})

test('e-mails: busca por assunto', async () => {
  assert.match(await ask('procura os e-mails sobre o contrato'), /Maria/)
  assert.match(await ask('e-mails sobre viagem a paris'), /Não achei/)
})

test('rotinas: horário, dias úteis, intervalo, pausa e histórico', async () => {
  const r = org.salvarRotina({ nome: 'Bom dia', comando: 'bom dia', frequencia: 'dias-uteis', horario: '07:30' })
  const seg = new Date(2026, 10, 9, 7, 31).getTime() // segunda
  const sab = new Date(2026, 10, 14, 7, 31).getTime()
  assert.equal(org.venceu(r, seg), true)
  assert.equal(org.venceu(r, sab), false)
  assert.equal(org.venceu(r, new Date(2026, 10, 9, 7, 0).getTime()), false, 'antes do horário')
  assert.equal(org.venceu(r, new Date(2026, 10, 9, 11, 0).getTime()), false, 'atraso grande demais')
  r.ultima = seg
  assert.equal(org.venceu(r, seg + 60000), false, 'não repete no mesmo dia')
  const i = org.salvarRotina({ nome: 'E-mails', comando: 'tem e-mail importante', frequencia: 'intervalo', intervaloMin: 30 })
  assert.equal(org.venceu(i, Date.now()), true)
  org.pausarRotina(i.id, false)
  assert.equal(org.venceu(i, Date.now()), false)
  await org.rodarAgora(r.id)
  assert.equal(org.listarRotinas().find((x) => x.id === r.id).historico[0].ok, true)
  assert.throws(() => org.salvarRotina({ nome: 'x', comando: '' }), /comando/)
  assert.match(await ask('minhas rotinas'), /duas rotinas/)
})

test('histórico não guarda senha de app nem link privado', () => {
  org.registrar('pedido', 'minha senha é abcd efgh ijkl mnop e o link https://calendar.google.com/calendar/ical/x/private-123/basic.ics')
  const h = org.listarHistorico(1)[0].texto
  assert.doesNotMatch(h, /abcd efgh/)
  assert.doesNotMatch(h, /private-123/)
})
