# Migração do JARVIS 2.0 (PC) para o 3.0 (nuvem)

1. No PC, na pasta do JARVIS 2.0:
   ```bash
   node cloud/src/cli/exportar-local.mjs . > jarvis-pacote.json
   ```
   Entram: notas do segundo cérebro, tarefas abertas, rotinas e lembretes futuros.
   **Não entram**: `integracoes.json` (links das agendas, senhas de app), tokens, chaves,
   histórico de comandos. O importador também recusa qualquer pacote com cara de credencial.
2. No JARVIS 3.0: **Conta → Dados → escolher o arquivo**. Ele mostra uma simulação (quantas
   memórias, tarefas, rotinas e lembretes) e só grava depois do seu OK.
3. As rotinas chegam **pausadas**: revise o horário e ative.
4. Agenda e e-mail: no 3.0 eles usam a API oficial do Google (OAuth) em vez do link iCal e da
   senha de app — conecte em **Conta → Integrações**.

Para sair do 3.0 (ou trocar de servidor): **Conta → Dados → Exportar** baixa tudo em JSON, e
`./scripts/backup.sh` faz o backup completo do banco.
