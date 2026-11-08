#!/usr/bin/env node
// Aplica (up) ou desfaz a última (down) migração do banco.
import { abrirBanco, migrar, fecharBanco } from '../db.mjs'
const dir = process.argv[2] === 'down' ? 'down' : 'up'
abrirBanco(process.env.DATABASE_URL)
const feitas = await migrar(dir)
console.log(feitas.length ? `migrações ${dir === 'up' ? 'aplicadas' : 'desfeitas'}: ${feitas.join(', ')}` : 'banco já está em dia')
await fecharBanco()
