// Agenda (.ics), e-mails (IMAP), memória viva ([[SAVE]]) e configurações.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventosDoIcs, decodeMimeWords, lerFetch, triagemLocal, iniciarIntegracoes, salvarConfig, configPublica, buscarEmails } from '../bridge/integracoes.mjs'
import { iniciarCerebro, filtroSave, extrairSaves, cerebro, salvarNota } from '../bridge/cerebro.mjs'

const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:1
DTSTART;TZID=America/Sao_Paulo:20260105T090000
DTEND;TZID=America/Sao_Paulo:20260105T100000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
EXDATE;TZID=America/Sao_Paulo:20261111T090000
SUMMARY:Aula de inglês com uma linha muito longa que
  continua aqui
BEGIN:VALARM
SUMMARY:alarme
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:2
DTSTART;VALUE=DATE:20261110
DTEND;VALUE=DATE:20261111
SUMMARY:Feriado
END:VEVENT
BEGIN:VEVENT
UID:3
DTSTART:20261109T170000Z
DTEND:20261109T180000Z
SUMMARY:Reunião\\, SECULT
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
UID:4
DTSTART:20261110T170000Z
SUMMARY:Cancelado
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:5
DTSTART:20261108T130000Z
RRULE:FREQ=MONTHLY;BYDAY=2TU
SUMMARY:Mensal
END:VEVENT
BEGIN:VEVENT
UID:1
RECURRENCE-ID;TZID=America/Sao_Paulo:20261109T090000
DTSTART;TZID=America/Sao_Paulo:20261109T110000
DTEND;TZID=America/Sao_Paulo:20261109T120000
SUMMARY:Aula remarcada
END:VEVENT
END:VCALENDAR`

test('ics: fusos, dia inteiro, repetição, exceções, remarcação e cancelamento', () => {
  const de = Date.UTC(2026, 10, 8, 3)
  const evs = eventosDoIcs(ICS, de, de + 9 * 86400000).sort((a, b) => a.inicio - b.inicio)
  const t = evs.map((e) => e.titulo)
  assert.deepEqual(t, ['Aula remarcada', 'Reunião, SECULT', 'Feriado', 'Mensal', 'Aula de inglês com uma linha muito longa que continua aqui'])
  assert.equal(evs[0].inicio, Date.UTC(2026, 10, 9, 14), '11h em São Paulo = 14h UTC')
  assert.equal(evs[2].diaTodo, true)
  assert.equal(new Date(evs[3].inicio).getUTCDate(), 10, 'segunda terça de novembro')
})

test('mime e imap: assuntos codificados, multipart, base64 e html', () => {
  assert.equal(decodeMimeWords('=?UTF-8?B?UmV1bmnDo28gZGU=?= =?UTF-8?Q?_amanh=C3=A3?='), 'Reunião de amanhã')
  const h1 = 'From: =?UTF-8?Q?Jo=C3=A3o_Silva?= <joao@x.com>\r\nSubject: =?UTF-8?B?UHJhem8gZG8gY29udHJhdG8=?=\r\nMessage-ID: <a1@x>\r\nContent-Type: multipart/alternative; boundary="BB"\r\n\r\n'
  const t1 = '--BB\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nOl=C3=A1, preciso da resposta at=C3=A9 amanh=C3=A3.\r\n--BB\r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n--BB--\r\n'
  const h2 = 'From: news@loja.com\r\nSubject: Oferta\r\nMessage-ID: <b2@x>\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'
  const t2 = Buffer.from('<html><style>a{}</style><b>50% OFF</b> hoje</html>').toString('base64') + '\r\n'
  const L = (s) => Buffer.byteLength(s, 'latin1')
  const raw = Buffer.from(
    `* 1 FETCH (UID 5 FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM SUBJECT)] {${L(h1)}}\r\n${h1} BODY[TEXT]<0> {${L(t1)}}\r\n${t1})\r\n` +
      `* 2 FETCH (UID 6 FLAGS () BODY[HEADER.FIELDS (FROM SUBJECT)] {${L(h2)}}\r\n${h2} BODY[TEXT]<0> {${L(t2)}}\r\n${t2})\r\nJ3 OK done\r\n`,
    'latin1',
  )
  const [a, b] = lerFetch(raw)
  assert.equal(a.de, 'João Silva')
  assert.equal(a.assunto, 'Prazo do contrato')
  assert.equal(a.trecho, 'Olá, preciso da resposta até amanhã.')
  assert.equal(a.lido, true)
  assert.equal(b.trecho, '50% OFF hoje')
  assert.equal(b.lido, false)
  assert.equal(triagemLocal(b), 'ruido')
  assert.equal(triagemLocal({ ...a, deEmail: 'joao@x.com' }), 'acao')
})

test('imap: só servidores permitidos', async () => {
  await assert.rejects(buscarEmails({ host: 'evil.example.com', usuario: 'a', senhaApp: 'b' }), /não permitido/)
})

test('configurações: segredos nunca voltam para a tela e são mantidos se em branco', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-integ-'))
  iniciarIntegracoes(dir, { semRelogio: true })
  salvarConfig({ agendas: [{ id: 'a1', nome: 'Pessoal', cor: '#22d3ee', url: 'https://calendar.google.com/x/private-abc/basic.ics' }], emails: [{ id: 'e1', apelido: 'P', cor: '#38bdf8', usuario: 'a@gmail.com', senhaApp: 'abcd efgh ijkl mnop' }], modelo: 'sonnet' })
  const pub = configPublica()
  assert.equal(pub.agendas[0].url, '')
  assert.equal(pub.agendas[0].salvo, true)
  assert.equal(pub.emails[0].senhaApp, '')
  assert.equal(pub.emails[0].salvo, true)
  salvarConfig({ ...pub, modelo: 'opus' })
  const disco = JSON.parse(readFileSync(join(dir, 'integracoes.json'), 'utf8'))
  assert.equal(disco.agendas[0].url, 'https://calendar.google.com/x/private-abc/basic.ics')
  assert.equal(disco.emails[0].senhaApp, 'abcdefghijklmnop')
  assert.equal(disco.modelo, 'opus')
  salvarConfig({ ...pub, modelo: 'gpt-qualquer', emails: [{ ...pub.emails[0], host: 'evil.com' }] })
  const d2 = JSON.parse(readFileSync(join(dir, 'integracoes.json'), 'utf8'))
  assert.equal(d2.modelo, 'opus', 'modelo inválido ignorado')
  assert.equal(d2.emails[0].host, 'imap.gmail.com', 'servidor inválido trocado pelo Gmail')
})

test('memória viva: [[SAVE]] vira nota e nunca é falado, mesmo em pedaços', () => {
  iniciarCerebro(mkdtempSync(join(tmpdir(), 'jarvis-cb-')))
  let fala = ''
  const salvas = []
  const f = filtroSave((d) => (fala += d), (n) => salvas.push(n))
  for (const d of ['Boa sorte ', 'na [prova].\n[', '[SAVE:aprend', 'izado|Inglês|Estuda inglês às terças]]', ' Até mais.']) f.push(d)
  f.flush()
  assert.equal(fala, 'Boa sorte na [prova].\n Até mais.')
  assert.equal(salvas[0].title, 'Inglês')
  assert.equal(extrairSaves('Ok. [[SAVE:metas|Inglês|Fluente até 2027]]'), 'Ok.')
  assert.equal(cerebro().notas.filter((n) => n.title === 'Inglês').length, 1, 'mesmo título atualiza, não duplica')
  salvarNota({ area: 'xyz', title: 'T', body: 'b' })
  assert.equal(cerebro().notas.find((n) => n.title === 'T').area, 'meta', 'área inválida vira "Você"')
})
