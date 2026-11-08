#!/usr/bin/env node
// Gera o código de uso único (1 hora) para criar a conta do proprietário.
import { abrirBanco, migrar, fecharBanco } from '../db.mjs'
import { gerarCodigoSetup } from '../auth.mjs'
abrirBanco(process.env.DATABASE_URL)
await migrar('up')
try {
  const c = await gerarCodigoSetup()
  console.log(`\nCódigo de configuração (vale 1 hora, uma vez só):\n\n   ${c}\n\nAbra o JARVIS no navegador e use este código para criar a sua conta.\n`)
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
}
await fecharBanco()
