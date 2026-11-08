# Servidor GPU dedicado (vLLM)

A VPS do JARVIS **não** precisa de GPU. Quando você quiser inferência própria (privacidade
total, custo fixo), suba um servidor GPU separado com vLLM e aponte o nível `principal` para ele.
Se a GPU estiver desligada, o gateway passa para o próximo modelo da lista (por exemplo, o
serverless) — o JARVIS continua no ar.

## 1. No servidor GPU

```bash
# NVIDIA com drivers + nvidia-container-toolkit instalados
docker run -d --name vllm --gpus all -p 8000:8000 --ipc=host \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  -e VLLM_API_KEY=troque-por-uma-chave-longa \
  vllm/vllm-openai:latest \
  --model ID-DO-MODELO-NO-HUGGINGFACE \
  --max-model-len 32768 \
  --enable-auto-tool-choice --tool-call-parser hermes
```

- `--tool-call-parser` depende da família do modelo (veja a documentação do vLLM: `hermes`
  para muitos Qwen, `llama3_json` para Llama 3.x, entre outros).
- **Não exponha a porta 8000 na internet aberta.** Ligue a VPS e a GPU por uma rede privada
  (WireGuard/Tailscale, ou a rede privada do provedor) e use a chave `VLLM_API_KEY`.

## 2. No JARVIS

`modelos.json`:

```json
"provedores": {
  "gpu": { "baseUrl": "http://IP-PRIVADO-DA-GPU:8000/v1", "chaveEnv": "VLLM_API_KEY" },
  "serverless": { "baseUrl": "https://SEU-PROVEDOR/v1", "chaveEnv": "LLM_SERVERLESS_KEY" }
},
"niveis": {
  "principal": [
    { "provedor": "gpu", "modelo": "ID-DO-MODELO-NO-HUGGINGFACE", "timeoutMs": 45000 },
    { "provedor": "serverless", "modelo": "ID-NO-PROVEDOR" }
  ]
}
```

E no `.env`: `VLLM_API_KEY=` (a mesma do servidor). `docker compose up -d` e pronto — o
painel **Conta → Consumo de IA** mostra qual modelo respondeu, a latência e as falhas.

## 3. Embeddings na GPU (opcional)

Um segundo container vLLM com um modelo de embeddings (`--task embed`) e o nível
`embeddings` apontando para ele. Atenção: se trocar o modelo de embeddings, as memórias antigas
ficam com vetores de outro tamanho — elas continuam achadas pela busca textual, e você pode
regerar os vetores reimportando a exportação.
