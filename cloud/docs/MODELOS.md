# Escolha de modelos abertos

O JARVIS não escolhe um modelo por você: ele usa **níveis** e você aponta cada nível para o
modelo que quiser em `modelos.json`. Cada nível aceita uma lista — se o primeiro falhar, o
próximo assume.

| Nível | Para quê | O que priorizar |
|---|---|---|
| `rapido` | classificação, consolidação da memória | baixa latência e custo; seguir JSON |
| `principal` | conversa e tarefas com ferramentas | português, tool calling confiável, contexto ≥ 32k |
| `avancado` | planejamento de pedidos com várias etapas | raciocínio, saída JSON estável |
| `visao` | imagens e documentos fotografados (futuro) | multimodal |
| `embeddings` | busca semântica na memória | multilíngue (português) |

## Como comparar (faça com os SEUS pedidos)

Os nomes e versões mudam rápido e cada provedor publica IDs próprios; por isso a configuração
não fixa nenhum. Antes de escolher, teste 10–20 pedidos reais seus em cada candidato e compare:

1. **Português brasileiro** — naturalidade, sem "portunhol", gírias e datas certas.
2. **Tool calling** — chama a ferramenta certa, com argumentos válidos (o JARVIS valida com zod
   e devolve o erro ao modelo; modelo fraco aqui gasta rodadas).
3. **Seguir instruções** — respostas curtas quando é por voz; não inventar.
4. **Contexto** — 32k tokens bastam para o JARVIS; mais só ajuda em documentos longos.
5. **Latência** — para voz, o primeiro pedaço da resposta deve chegar em menos de ~1,5 s.
6. **Custo** — coloque os preços em `precos` para o orçamento diário funcionar.
7. **Licença** — Apache 2.0 e MIT são as mais livres; licenças "community" têm condições
   (por exemplo, limites de uso ou de região) — leia antes.
8. **Memória/GPU** (se for hospedar) — regra prática: pesos em 4 bits ≈ 0,6 GB por bilhão de
   parâmetros, mais o cache de contexto.

## Pontos de partida (verifique as versões atuais)

- **Famílias Qwen** (Alibaba): costumam ir bem em português e em tool calling; muitas versões
  sob Apache 2.0, em vários tamanhos (dá para usar um pequeno no `rapido` e um médio no
  `principal`).
- **Famílias Llama** (Meta): boas em instruções; licença comunitária com condições próprias.
- **DeepSeek**: fortes em raciocínio (bons para o `avancado`); confira tamanho e licença.
- **Embeddings multilíngues**: modelos da família BGE-M3 ou multilingual-e5 funcionam bem em
  português.

Uma comparação de 2026 entre famílias abertas (licença, contexto e hardware) está em
<https://wavect.io/blog/open-weight-llm-comparison-2026.md>. Ela não traz ranking de tool
calling nem de português; para isso, vale o teste com os seus próprios pedidos.

## Testado neste repositório

Os testes de integração rodaram com **Qwen2.5 0.5B** e **all-MiniLM** pelo Ollama, só para
provar o caminho ponta a ponta (conversa, streaming, embeddings no pgvector). São pequenos
demais para uso diário: no dia a dia, use um modelo médio ou grande no `principal`.
