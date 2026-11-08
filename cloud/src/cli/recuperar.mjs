#!/usr/bin/env node
/**
 * Recuperação de último recurso (perdeu o celular E os códigos de recuperação):
 * quem tem acesso ao servidor define uma senha nova e desliga o autenticador.
 * Todas as sessões são encerradas. Fica registrado na auditoria.
 *   docker compose exec api node src/cli/recuperar.mjs
 */
import { createInterface } from 'node:readline/promises'
import { abrirBanco, q, fecharBanco } from '../db.mjs'
import { hashSenha } from '../seguranca/cripto.mjs'
import { auditar } from '../seguranca/auditoria.mjs'

abrirBanco(process.env.DATABASE_URL)
const o = (await q('SELECT id, email FROM owners')).rows[0]
if (!o) {
  console.log('Não há proprietário. Use setup-token.mjs.')
  process.exit(1)
}
const rl = createInterface({ input: process.stdin, output: process.stdout })
const ok = await rl.question(`Redefinir a senha de ${o.email} e desligar o autenticador? Digite RECUPERAR: `)
if (ok.trim() !== 'RECUPERAR') process.exit(1)
const senha = await rl.question('Senha nova (mínimo 10 caracteres): ')
rl.close()
await q('UPDATE owners SET senha_hash = $2, totp_ativo = false, totp_cifrado = NULL WHERE id = $1', [o.id, await hashSenha(senha)])
await q('DELETE FROM codigos_recuperacao WHERE owner_id = $1', [o.id])
await q('UPDATE sessoes SET revogada = true WHERE owner_id = $1', [o.id])
await auditar(o.id, 'recuperacao_pelo_servidor', {})
console.log('Pronto. Entre com a senha nova e ative o autenticador de novo.')
await fecharBanco()
