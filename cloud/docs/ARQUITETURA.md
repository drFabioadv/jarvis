# Arquitetura do JARVIS 3.0

```
 celular / PC (PWA)            VPS (Docker)                                   fora
 ┌──────────────┐   HTTPS   ┌───────┐   ┌──────────┐   ┌──────────────┐   ┌─────────────────────┐
 │ HUD + voz no │──────────▶│ Caddy │──▶│   API    │──▶│ Gateway de   │──▶│ modelos abertos:    │
 │ aparelho     │◀──SSE─────│ (TLS) │   │ Fastify  │   │ modelos      │   │ serverless / vLLM / │
 └──────────────┘           └───────┘   └────┬─────┘   └──────────────┘   │ Ollama              │
                                             │                             └─────────────────────┘
 ┌──────────────┐  WSS (saída)               │  ┌──────────┐  ┌──────────┐
 │ agente local │────────────────────────────┘  │PostgreSQL│  │  Redis   │◀── Worker (BullMQ):
 │ (opcional)   │                               │+pgvector │  │  (AOF)   │    tarefas, lembretes,
 └──────────────┘                               └──────────┘  └──────────┘    rotinas, manutenção
                                                 SearXNG (busca própria) · Google/GitHub (OAuth)
```

## As seis camadas pedidas

| Camada | Implementação | Por quê |
|---|---|---|
| A. Núcleo cloud | `api` + `worker` + `postgres` + `redis` + `caddy` no Docker Compose | Roda numa VPS comum, barata, 24 h; não depende de GPU nem do PC |
| B. Motor de inteligência | `llm/gateway.mjs` + `agentes/orquestrador.mjs` | Interface única (chat, streaming, tools, embeddings) sobre a API compatível com OpenAI — o padrão que vLLM, Ollama, llama.cpp e quase todos os provedores de modelos abertos falam |
| C. Memória | `memoria.mjs` (PostgreSQL + pgvector + tsvector português + pg_trgm) | Um banco só para tudo; busca semântica e textual juntas; backup simples |
| D. Agentes e automações | `filas.mjs` + `worker.mjs` (BullMQ) | Fila persistente no Redis com prioridade, retentativa, recuperação de travados e agendador com cron+fuso (horário de verão incluído) |
| E. Interface | O frontend existente, compilado com `vite build --mode cloud` | Preserva o HUD; troca o "cérebro" por `src/lib/cloud.ts` (só a API própria) e remove o SDK da Anthropic do pacote |
| F. Agente local | `agente-local/` | Conexão de saída autenticada; o núcleo não depende dele |

## Decisões técnicas

- **Serviços pedidos × containers.** Autenticação, armazenamento e monitoramento não viraram
  containers separados: a autenticação é um módulo da API (proprietário único — um serviço à
  parte só adicionaria latência e superfície de ataque); o armazenamento é o PostgreSQL (dados) +
  volumes Docker (modelos) + backups cifrados; o monitoramento são os health checks do Docker, a
  rota `/api/saude`, o consumo em `/api/uso` e o Uptime Kuma opcional (`--profile monitoramento`).
  O **scheduler** é o agendador de jobs do BullMQ dentro do worker: os agendamentos ficam no
  Redis e não duplicam mesmo com vários workers.
- **Sem MCP obrigatório.** As ferramentas são um registro próprio (`ferramentas/registro.mjs`):
  zod → JSON Schema → tool calling. Um adaptador MCP pode ser acrescentado depois sem mudar o
  orquestrador, mas o núcleo não precisa dele.
- **Sem acoplamento a fornecedor.** Provedores, modelos, preços e orçamento estão em
  `modelos.json`. Trocar de provedor é editar o arquivo — o código não muda.
- **Limites contra loops.** Por pedido: até 5 etapas de plano, 6 rodadas de ferramentas,
  2 minutos (10 em tarefas de fundo) e 40 mil tokens; orçamento diário em dólares. Agentes não
  criam agentes nem tarefas (profundidade máxima 1).
- **Agentes com permissões próprias.** Cada agente tem a sua lista fechada de ferramentas
  (`agentes/agentes.mjs`). O orquestrador recusa — e audita — qualquer chamada fora da lista.
- **Confirmação no servidor.** Ferramentas externas e destrutivas viram `acoes_pendentes`; só
  executam quando o proprietário confirma na interface (ou diz "sim"), com os argumentos
  guardados — o modelo não pode trocar o que vai ser feito depois da confirmação.
- **Memória que não vira lixo.** Conversa não vira fato automaticamente: a consolidação (worker,
  3h da manhã) pede ao modelo rápido só o que é durável e só salva importância ≥ 4; coisas
  passageiras viram `temporario` e expiram. Duplicatas (mesmo título ou vetor muito próximo) são
  mescladas.
- **Voz.** Reconhecimento: no aparelho (navegador) ou no servidor (Whisper aberto, opcional,
  `JARVIS_STT_NUVEM=1`). Síntese: no aparelho (vozes do sistema ou Kokoro em WebAssembly).
  A palavra de ativação só funciona com o app aberto e o microfone autorizado — uma página
  fechada ou um PC desligado não escuta; as rotinas e lembretes da nuvem, sim, continuam.

## O que roda com o PC desligado

Conversa (web e celular), memória, tarefas, lembretes (push), rotinas, tarefas de fundo,
pesquisa, Google Agenda/Gmail/Drive. Só o controle do computador (`pc.*`) precisa do PC ligado.
