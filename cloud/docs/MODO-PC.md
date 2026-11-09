# Modo PC — o JARVIS inteiro no seu computador, sem custo

Sem servidor, sem provedor pago, sem Claude. Um processo só (`node cloud/src/pc.mjs`) com:

| Peça | No servidor | No modo PC |
|---|---|---|
| Banco | PostgreSQL + pgvector | **PGlite** (o mesmo PostgreSQL, embutido, num arquivo) + pgvector |
| Fila e agendador | Redis + BullMQ | no próprio processo, guardados no banco |
| Modelo | provedor / vLLM | **Ollama** na sua placa de vídeo |
| Celular | domínio + HTTPS | **Tailscale** (grátis, até 6 usuários e aparelhos ilimitados) |
| Audição | Whisper opcional | Whisper ligado, no próprio PC |

## Instalar

1. Já com o JARVIS 2.0 instalado (`INSTALAR.bat`), rode **`INSTALAR-JARVIS-PC.bat`**:
   instala o Ollama, baixa o **Qwen 2.5 14B** (~9 GB, cabe inteiro numa placa de 16 GB) e o
   **bge-m3** (memória), instala a plataforma, liga com o Windows e abre `http://localhost:8090`.
2. Crie a conta com o código que aparece e ative o aplicativo autenticador.
3. Reinicie o JARVIS da bandeja. Em `jarvis-config.json` fica `"cerebro": "pc"`: tudo que não
   é comando local vai para o modelo do seu PC. (Para voltar ao Claude: `"cerebro": "claude"`.)
4. Celular: instale o Tailscale no PC e no iPhone (mesma conta), ative HTTPS no painel do
   Tailscale e rode **`CONFIGURAR-CELULAR.bat`**. No Safari, abra o endereço que ele mostrar e
   "Adicionar à Tela de Início".

## Onde ficam as coisas

`%LOCALAPPDATA%\JARVIS\pc\`: `config.json` (chave mestra, chaves de notificação, token interno —
não compartilhe), `modelos.json` (troque de modelo aqui), `banco\` (seus dados) e
`codigo-de-cadastro.txt`. Log: `logs\cerebro-pc.log` na pasta do JARVIS.

Backup: copie a pasta `banco\` com o JARVIS desligado, ou use **Conta → Dados → Exportar**.

## Trocar de modelo

`ollama pull NOME` e mude o `modelos.json`. Com 16 GB de vídeo: modelos de 14B (Q4) cabem com
folga; os de 7–8B ficam mais rápidos. Use o mesmo modelo nos níveis rapido/principal/avancado
para a placa não ficar trocando de modelo.

## Limites

- PC desligado = JARVIS desligado (inclusive no celular). Lembretes e rotinas que venceram com
  o PC desligado rodam quando ele liga, se o atraso for de até 2 horas (lembretes: até 12 h).
- Notificações no celular dependem do PC ligado e do Tailscale.
