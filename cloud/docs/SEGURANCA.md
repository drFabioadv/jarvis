# Segurança do JARVIS 3.0

| Item | Como está feito |
|---|---|
| HTTPS | Caddy com Let's Encrypt; HSTS; cookies `Secure` quando `PUBLIC_URL` é https |
| Proprietário único | uma linha só em `owners` (índice único); cadastro com código de uso único (1 h) gerado no servidor; depois disso a rota recusa |
| Login | e-mail + senha (scrypt N=2¹⁵) + TOTP (RFC 6238) ou passkey (WebAuthn, verificação do usuário obrigatória) |
| Segundo fator obrigatório | `JARVIS_EXIGIR_MFA=1` (padrão): sem segundo fator, só as rotas de segurança da conta funcionam |
| Recuperação | 10 códigos de uso único (hash no banco). Último recurso, com acesso ao servidor: `node src/cli/recuperar.mjs` (senha nova, desliga o autenticador, encerra as sessões, fica na auditoria). O cadastro nunca reabre |
| Força bruta | 5 erros por conta e 20 por IP a cada 15 min; mesmo tempo de resposta com ou sem conta |
| Sessões | cookie `httpOnly`, `SameSite=Strict`; só o hash no banco; expiram em 30 dias ou 7 sem uso; lista de aparelhos com revogação; trocar a senha encerra as outras |
| CSRF | SameSite=Strict + cabeçalho `x-jarvis` obrigatório + conferência de `Origin` |
| XSS | CSP restritiva (`script-src 'self'`), `nosniff`, `frame-ancestors 'none'` |
| SSRF | `web.ler`/notícias resolvem o DNS e recusam qualquer IP privado, de loopback ou de metadados (169.254.169.254), portas não padrão, `file:` e credenciais na URL; cada redirecionamento é conferido |
| Rate limiting | Redis: 300 req/min por IP (30 nas rotas pesadas) |
| Segredos em repouso | TOTP e tokens OAuth cifrados com AES-256-GCM (`JARVIS_MASTER_KEY`); senhas e tokens de dispositivo só como hash |
| Rotação | `JARVIS_MASTER_KEY` nova exige recifrar (exporte, troque, reconecte as integrações e o autenticador); tokens de dispositivo: revogar e parear de novo; OAuth: desconectar/conectar |
| Logs | a API omite cookie, authorization, senha e código; a auditoria remove campos com nome de segredo |
| Auditoria | logins, falhas, bloqueios, sessões, passkeys, ações confirmadas/recusadas, ferramentas com efeito, comandos no PC, integrações, exportações |
| Prompt injection | todo conteúdo de fora (páginas, e-mails, notícias, GitHub) chega ao modelo embrulhado como `conteudo_externo` e o sistema manda nunca obedecer; mesmo que o modelo obedeça, ações com efeito exigem a sua confirmação |
| Ações sensíveis | categorias `externa` e `destrutiva` sempre pedem confirmação; não existe ferramenta financeira |
| Agentes | cada um só enxerga a sua lista de ferramentas; sem recursão |
| Agente local | conexão de saída; token por aparelho (hash no banco), revogável; só 3 comandos (abrir, sistema, listar), cada um validado; pastas limitadas; sem shell remoto |
| Frontend | nenhuma chave de modelo no navegador; o build da nuvem nem inclui o SDK da Anthropic |
| Backups | `pg_dump` + Redis, cifrados com `JARVIS_BACKUP_SENHA` (AES-256 + PBKDF2) |
| Atualizações | só por `implantar.sh <tag>` (você escolhe o que entra), com backup antes, health check depois e rollback da imagem |

## Limites honestos

- Só há um papel (o proprietário). O controle "por função" é o das permissões por agente e por
  aparelho; contas adicionais não existem nesta versão.
- O isolamento dos workers é o do container (usuário sem privilégios). As ferramentas não
  executam código arbitrário.
- Rotação automática da chave mestra não está implementada (o procedimento manual está acima).
