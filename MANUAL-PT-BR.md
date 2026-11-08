# J.A.R.V.I.S. — manual em português

Assistente pessoal de voz para Windows, com o visual do Homem de Ferro. O cérebro é o
Claude (pela sua assinatura do Claude, sem chave de API); o que dá para resolver no
próprio PC é resolvido aqui, de graça e sem gastar o seu limite.

## Instalar

1. Extraia a pasta (ex.: `Documentos\jarvis`).
2. Dois cliques em **INSTALAR.bat** — confere o Node.js e o Claude Code, instala o que falta e pede o login do Claude.
3. Dois cliques em **INSTALAR-APP.bat** — põe o JARVIS no ícone ao lado do relógio e liga com o Windows.
4. Para remover: **DESINSTALAR-APP.bat** (tira o atalho de inicialização; a pasta e os seus dados ficam).

Atualizações: ícone do JARVIS → **Procurar atualização agora**. Seus dados nunca são sobrescritos.

## O que ele faz

| Área | Exemplos de voz | Gasta o Claude? |
|---|---|---|
| Conversa e pesquisa | “Jarvis, compare os planos de celular da Vivo e da Claro” | sim |
| Bom dia / digest | “bom dia” — hora, clima, agenda, e-mails de ação, tarefas do dia, notícias, foco do dia | não |
| Agenda (Google, só leitura) | “minha agenda”, “próximo compromisso”, “tenho algo na sexta?”, “tenho horário livre amanhã?” | não |
| Criar compromisso | “marca uma reunião com o cliente amanhã às 14h” → ele confirma e abre o Google Agenda preenchido | não |
| E-mails (Gmail, só leitura) | “meus e-mails”, “tem e-mail importante?”, “e-mails sobre o contrato” | só na triagem (1× por e-mail) |
| Tarefas | “adiciona tarefa revisar o edital pra sexta”, “minhas tarefas”, “conclui a tarefa do edital” | não |
| Lembretes | “me lembra de ligar pro banco às 15h”, “timer de 10 minutos” | não |
| Segundo cérebro | “anota que …”, “o que eu tinha decidido sobre …”, “procura no meu cérebro …”, “esquece a nota sobre …” | não |
| Rotinas | criadas no painel ⟳ Rotinas; “minhas rotinas”, “pausa a rotina bom dia” | não (só se o comando precisar) |
| Notícias e jornal | “notícias de inteligência artificial”, “lê o jornal” | não |
| Computador | “abre o LoL”, “abre a pasta Documentos”, “volume 30”, “bloqueia a tela” | não |
| Controle | “pausar”, “pare”, “minimiza tudo”, “abre a central”, “abre as configurações” | não |

## Painéis (barra à direita)

- 🧠 **Segundo cérebro** — grafo com as notas da sua vida; clique para editar.
- ◎ **Central de comando** — relógio, clima, compromissos, tarefas, lembretes, rotinas, status do sistema e últimos comandos. **PERSONALIZAR** esconde e reordena os módulos.
- 📅 **Agenda** · ✉ **E-mails** — linha do tempo e caixa triada em ação / info / ruído.
- ⟳ **Rotinas** — automações com nome, comando, frequência (todo dia, dias úteis, dias escolhidos, a cada X minutos), horário, condição (só se houver compromisso / e-mail de ação / tarefa), pausar, rodar agora, editar, excluir e histórico. Rodam no serviço local, mesmo com a janela escondida.
- ⚙ **Configurações** — GERAL (como ele te chama, cidade, assuntos das notícias, velocidade e volume da fala, intensidade das animações), AGENDA, E-MAILS e CÉREBRO (Haiku / Sonnet / Opus; bom dia automático).

O reator muda de cor com o estado: ciano ouvindo, violeta pensando, dourado executando, âmbar piscando em alerta (lembrete/rotina), vermelho em erro, cinza desligado.

## Segurança e privacidade

- Tudo fica **no seu PC**, na pasta do JARVIS, fora do GitHub: `segundo-cerebro.json`, `integracoes.json` (links das agendas e senhas de app), `tarefas.json`, `rotinas.json`, `historico.json`, `lembretes.json`, `triagem-emails.json`, `atalho-token.txt`.
- Links de agenda e senhas de app **nunca** voltam para a tela, não vão para o registro e não vão para a IA. O histórico apaga padrões de senha de app e links privados.
- E-mail e agenda são **só leitura** (IMAP `EXAMINE` + `BODY.PEEK`: nada é marcado como lido). O JARVIS não envia, não apaga e não responde e-mails.
- Apagar nota, apagar tarefa e criar compromisso **pedem confirmação** (“Confirma?” → “sim”).
- Conteúdo de e-mails, sites e notícias é tratado como **dado, nunca como ordem** (proteção contra prompt injection).
- A ponte só aceita conexões do próprio PC (127.0.0.1) e de origens permitidas; busca de imagens/páginas bloqueia endereços internos (proteção contra SSRF). Agenda só aceita links do Google; e-mail só servidores IMAP permitidos (Gmail, Outlook).
- O **modo ação** (o Claude abrir programas, mexer em arquivos) liga e desliga no ícone da bandeja. Rotinas nunca abrem programas.
- O atalho do iPhone exige a senha em `atalho-token.txt`.

## Variáveis e arquivos de configuração

`jarvis-config.json` (público, vai junto): cidade, coordenadas, nome de tratamento, temas, modelo padrão.
Variáveis de ambiente (opcionais): `JARVIS_MODEL`, `JARVIS_EFFORT`, `JARVIS_MAX_TURNS`, `JARVIS_ALLOW_WRITES=1` (modo ação), `JARVIS_DISABLE`, `JARVIS_LOCAL_STT=0` (desliga a audição local), `JARVIS_ALLOWED_ORIGINS`.
Voz natural opcional: `elevenlabs.txt` com a chave da ElevenLabs (menu da bandeja → Voz natural).

## Diagnóstico

Ícone do JARVIS → **Diagnostico**: abre uma página com o estado de cada parte (versão, audição, agenda, e-mails, modelo, memória). **Abrir registros** mostra o log detalhado.

## Limitações conhecidas

- **Criar/alterar/cancelar eventos direto na agenda** exigiria login OAuth do Google (projeto no Google Cloud). Hoje ele confirma e abre o Google Agenda já preenchido — você só clica em salvar.
- **Enviar e-mail ou criar rascunho** não está ligado (a senha de app é só leitura, de propósito). Para responder, peça o texto ao JARVIS e cole no Gmail.
- **Câmera e leitura de tela** estão desligadas por padrão (`JARVIS_DISABLE=camera,browser`).
- **Busca na memória** é por palavras (com acentos e plurais tolerados), não semântica por embeddings — funciona sem baixar outro modelo.
- E-mails: analisa os 20 mais recentes de cada conta (configurável em `integracoes.json`).
