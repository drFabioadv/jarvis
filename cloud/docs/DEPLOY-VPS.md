# Implantação numa VPS

## 1. O que você precisa

- Uma VPS Linux com **2 vCPU e 4 GB de RAM** (8 GB se ligar a audição Whisper no servidor),
  Docker e Docker Compose. Ubuntu 24.04 serve. Não precisa de GPU.
- Um domínio (ou subdomínio) apontando para o IP da VPS (registro A/AAAA).
- Um provedor de **modelos abertos** compatível com a API da OpenAI (veja [MODELOS.md](MODELOS.md)),
  ou um servidor GPU próprio ([GPU-VLLM.md](GPU-VLLM.md)).

> Custos: a VPS e o provedor de modelos são pagos à parte por você. Nada aqui contrata serviços.

## 2. Instalar

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/SEU-USUARIO/jarvis && cd jarvis/cloud
cp .env.exemplo .env
cp modelos.exemplo.json modelos.json
```

Preencha o `.env`:

| Variável | Como gerar / o que pôr |
|---|---|
| `DOMINIO`, `PUBLIC_URL` | `jarvis.seudominio.com.br` e `https://jarvis.seudominio.com.br` |
| `POSTGRES_PASSWORD` (e a mesma em `DATABASE_URL`) | `openssl rand -hex 24` |
| `JARVIS_MASTER_KEY` | `openssl rand -base64 32` — **guarde fora do servidor**; sem ela os segredos cifrados não abrem |
| `SEARXNG_SECRET` | `openssl rand -hex 16` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `docker run --rm node:22 npx -y web-push generate-vapid-keys` |
| `LLM_SERVERLESS_KEY` / `VLLM_API_KEY` | as chaves do seu provedor / do seu vLLM |
| `JARVIS_BACKUP_SENHA` | senha longa para cifrar os backups — guarde fora do servidor |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | opcional, veja abaixo |

Edite o `modelos.json` com os IDs dos modelos do seu provedor.

## 3. Subir

```bash
docker compose up -d --build
docker compose ps                     # tudo "healthy"
docker compose exec api node src/cli/setup-token.mjs
```

Abra `https://SEU-DOMINIO`, use o código para criar a conta, ative o aplicativo autenticador
(ou uma passkey) e guarde os códigos de recuperação. Pronto: o cadastro se fecha sozinho.

No celular: abra o endereço no Chrome/Safari → "Adicionar à tela de início". Em
**Conta → Segurança → Ativar notificações**, cada aparelho passa a receber lembretes e rotinas.

## 4. Google (opcional)

1. <https://console.cloud.google.com> → crie um projeto → **APIs e serviços** → ative Google
   Calendar API, Gmail API e Google Drive API.
2. **Tela de consentimento OAuth**: tipo Externo, modo de teste, adicione o seu e-mail como
   usuário de teste.
3. **Credenciais → Criar ID do cliente OAuth → Aplicativo da Web**. URI de redirecionamento:
   `https://SEU-DOMINIO/api/integracoes/google/retorno`.
4. Copie o ID e a chave secreta para o `.env` e rode `docker compose up -d`.
5. No JARVIS: **Conta → Integrações → Conectar**. Para revogar: **Desconectar** (o token é
   revogado no Google e apagado do banco).

## 5. Rotina de manutenção

```bash
./scripts/backup.sh                      # backup cifrado (agende no cron: 0 4 * * * ...)
./scripts/implantar.sh v3.0.1            # atualiza para uma tag verificada, com rollback
./scripts/restaurar.sh backups/arquivo   # restaura (pede confirmação)
docker compose --profile monitoramento up -d monitor   # painel Uptime Kuma (opcional)
```

Copie a pasta `backups/` para fora da VPS (rclone, por exemplo) — backup que mora só no
servidor some junto com ele.

## 6. Logs

Os containers usam o driver `json-file` com rotação (10 MB × 5). Os logs da API omitem cookies,
cabeçalhos de autorização, senhas e códigos. `docker compose logs -f api worker`.

## 7. Trocar de provedor ou de VPS

Tudo é portátil: copie o `.env`, o `modelos.json` e o último backup para a nova máquina,
suba com `docker compose up -d` e rode `./scripts/restaurar.sh`. Trocar de provedor de modelos
é só editar o `modelos.json`.
