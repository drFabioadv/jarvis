# J.A.R.V.I.S. 3.0 — plataforma pessoal na nuvem

Assistente pessoal privado, disponível 24 horas, **sem nenhuma dependência da Anthropic**
(nem API, nem Claude Code, nem login, nem SDK). A inteligência vem de **modelos abertos**
(Qwen, Llama, DeepSeek...) por qualquer servidor compatível com a API da OpenAI: um provedor
serverless, um vLLM na sua GPU ou um Ollama.

| Peça | O que é | Onde |
|---|---|---|
| API | Fastify: autenticação, conversa (SSE), memória, tarefas, integrações, PWA | `src/server.mjs` |
| Motor de IA | Gateway de modelos (fallback, orçamento, métricas, streaming, tool calling) | `src/llm/gateway.mjs` |
| Orquestrador | Intenção → contexto → plano → agentes com permissões → validação → histórico | `src/agentes/` |
| Memória | PostgreSQL + pgvector, busca híbrida, deduplicação, consolidação | `src/memoria.mjs` |
| Worker/agendador | BullMQ + Redis: tarefas de fundo, lembretes, rotinas (cron com fuso), manutenção | `src/worker.mjs`, `src/filas.mjs` |
| Segurança | Proprietário único, senha scrypt + TOTP + passkeys, sessões revogáveis, CSRF, SSRF, auditoria | `src/auth.mjs`, `src/seguranca/` |
| Integrações | Google Agenda/Gmail/Drive (OAuth 2.0 + PKCE), GitHub, SearXNG, Open-Meteo, Google Notícias | `src/integracoes/`, `src/ferramentas/` |
| Agente local | Opcional: o PC conecta na nuvem e executa só comandos permitidos | `../agente-local/` |
| Interface | O mesmo HUD do JARVIS, como PWA instalável (desktop e celular) | `../src` (build `--mode cloud`) |

## Subir em 10 minutos (VPS)

Veja **[docs/DEPLOY-VPS.md](docs/DEPLOY-VPS.md)**. Resumo:

```bash
git clone https://github.com/SEU-USUARIO/jarvis && cd jarvis/cloud
cp .env.exemplo .env           # preencha (openssl rand -base64 32 para as chaves)
cp modelos.exemplo.json modelos.json   # aponte para o seu provedor de modelos abertos
docker compose up -d --build
docker compose exec api node src/cli/setup-token.mjs   # código para criar a sua conta
```

Abra `https://SEU-DOMINIO`, crie a conta com o código, ative o autenticador e pronto.

## Testar no próprio PC (sem domínio)

```bash
cd cloud && cp .env.exemplo .env && cp modelos.exemplo.json modelos.json
# no modelos.json, use o provedor "ollama" (http://ollama:11434/v1) com qwen2.5:3b
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
docker compose exec ollama ollama pull qwen2.5:3b
docker compose exec api node src/cli/setup-token.mjs
# abra http://localhost:8080
```

## Comandos

| | |
|---|---|
| `npm test` | testes de unidade e integração (precisam de Postgres com pgvector e Redis; veja `test/apoio.mjs`) |
| `npm run lint` | linter |
| `npm run migrate` / `npm run migrate:down` | aplicar / desfazer a última migração |
| `npm run owner:setup-token` | código de uso único para criar a conta do proprietário |
| `./scripts/backup.sh` · `./scripts/restaurar.sh` · `./scripts/implantar.sh <tag>` | backup cifrado, restauração, atualização com rollback |

## Documentação

- [Arquitetura e decisões](docs/ARQUITETURA.md)
- [Implantação numa VPS](docs/DEPLOY-VPS.md)
- [Escolha de modelos abertos](docs/MODELOS.md)
- [Servidor GPU dedicado (vLLM)](docs/GPU-VLLM.md)
- [Segurança](docs/SEGURANCA.md)
- [Migração do JARVIS 2.0](docs/MIGRACAO.md)
