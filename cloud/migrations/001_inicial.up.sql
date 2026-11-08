-- J.A.R.V.I.S. 3.0 — esquema inicial. Proprietário único; tudo é ligado a owner_id.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  nome text NOT NULL,
  senha_hash text NOT NULL,
  totp_cifrado text,
  totp_ativo boolean NOT NULL DEFAULT false,
  criado timestamptz NOT NULL DEFAULT now()
);
-- Política de proprietário único: no máximo uma linha.
CREATE UNIQUE INDEX owners_unico ON owners ((true));

CREATE TABLE codigos_setup (hash text PRIMARY KEY, expira timestamptz NOT NULL, usado boolean NOT NULL DEFAULT false);
CREATE TABLE codigos_recuperacao (owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE, hash text NOT NULL, usado timestamptz, PRIMARY KEY (owner_id, hash));

CREATE TABLE passkeys (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  chave_publica bytea NOT NULL,
  contador bigint NOT NULL DEFAULT 0,
  transportes text[] NOT NULL DEFAULT '{}',
  nome text NOT NULL DEFAULT 'Passkey',
  criada timestamptz NOT NULL DEFAULT now(),
  ultimo_uso timestamptz
);

CREATE TABLE sessoes (
  id text PRIMARY KEY, -- sha256 do token do cookie
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  dispositivo text NOT NULL DEFAULT '',
  ip text NOT NULL DEFAULT '',
  mfa boolean NOT NULL DEFAULT false,
  criada timestamptz NOT NULL DEFAULT now(),
  ultima_atividade timestamptz NOT NULL DEFAULT now(),
  expira timestamptz NOT NULL,
  revogada boolean NOT NULL DEFAULT false
);
CREATE INDEX sessoes_owner ON sessoes (owner_id) WHERE NOT revogada;

CREATE TABLE desafios_webauthn (id text PRIMARY KEY, desafio text NOT NULL, owner_id uuid, tipo text NOT NULL, expira timestamptz NOT NULL);

CREATE TABLE tentativas_login (chave text NOT NULL, em timestamptz NOT NULL DEFAULT now());
CREATE INDEX tentativas_login_chave ON tentativas_login (chave, em);

CREATE TABLE auditoria (
  id bigserial PRIMARY KEY,
  owner_id uuid REFERENCES owners ON DELETE CASCADE,
  acao text NOT NULL,
  detalhes jsonb NOT NULL DEFAULT '{}',
  ip text NOT NULL DEFAULT '',
  em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auditoria_em ON auditoria (owner_id, em DESC);

CREATE TABLE config_owner (owner_id uuid PRIMARY KEY REFERENCES owners ON DELETE CASCADE, dados jsonb NOT NULL DEFAULT '{}');

-- Memória: fatos, preferências, projetos, conhecimentos, decisões e coisas temporárias.
CREATE TABLE memorias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('fato', 'preferencia', 'projeto', 'conhecimento', 'decisao', 'pessoa', 'temporario')),
  titulo text NOT NULL,
  conteudo text NOT NULL,
  embedding vector,
  importancia smallint NOT NULL DEFAULT 3 CHECK (importancia BETWEEN 1 AND 5),
  origem text NOT NULL DEFAULT 'usuario',
  expira_em timestamptz,
  criada timestamptz NOT NULL DEFAULT now(),
  atualizada timestamptz NOT NULL DEFAULT now(),
  busca tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', titulo || ' ' || conteudo)) STORED
);
CREATE INDEX memorias_owner ON memorias (owner_id, tipo);
CREATE INDEX memorias_busca ON memorias USING gin (busca);
CREATE INDEX memorias_titulo_trgm ON memorias USING gin (titulo gin_trgm_ops);

CREATE TABLE memoria_relacoes (
  a uuid NOT NULL REFERENCES memorias ON DELETE CASCADE,
  b uuid NOT NULL REFERENCES memorias ON DELETE CASCADE,
  tipo text NOT NULL DEFAULT 'relacionada',
  PRIMARY KEY (a, b)
);

CREATE TABLE conversas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  titulo text NOT NULL DEFAULT 'Conversa',
  resumo text,
  consolidada_ate bigint NOT NULL DEFAULT 0,
  criada timestamptz NOT NULL DEFAULT now(),
  atualizada timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversas_owner ON conversas (owner_id, atualizada DESC);

CREATE TABLE mensagens (
  id bigserial PRIMARY KEY,
  conversa_id uuid NOT NULL REFERENCES conversas ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  papel text NOT NULL CHECK (papel IN ('usuario', 'jarvis', 'ferramenta', 'sistema')),
  conteudo text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  criada timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mensagens_conversa ON mensagens (conversa_id, id);

CREATE TABLE tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  texto text NOT NULL,
  prazo timestamptz,
  prioridade text NOT NULL DEFAULT 'normal' CHECK (prioridade IN ('normal', 'alta')),
  feita boolean NOT NULL DEFAULT false,
  criada timestamptz NOT NULL DEFAULT now(),
  concluida timestamptz
);
CREATE INDEX tarefas_owner ON tarefas (owner_id, feita);

CREATE TABLE lembretes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  texto text NOT NULL,
  quando timestamptz NOT NULL,
  enviado boolean NOT NULL DEFAULT false,
  criado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lembretes_pendentes ON lembretes (quando) WHERE NOT enviado;

CREATE TABLE rotinas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  nome text NOT NULL,
  descricao text NOT NULL DEFAULT '',
  comando text NOT NULL,
  cron text NOT NULL,
  tz text NOT NULL,
  condicao text NOT NULL DEFAULT 'sempre',
  ativa boolean NOT NULL DEFAULT true,
  notificar boolean NOT NULL DEFAULT true,
  criada timestamptz NOT NULL DEFAULT now(),
  ultima timestamptz
);

-- Espelho das tarefas de fundo (o estado vivo fica no Redis/BullMQ).
CREATE TABLE trabalhos (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  tipo text NOT NULL,
  titulo text NOT NULL DEFAULT '',
  estado text NOT NULL DEFAULT 'na_fila' CHECK (estado IN ('na_fila', 'executando', 'concluido', 'falhou', 'cancelado')),
  prioridade smallint NOT NULL DEFAULT 5,
  dados jsonb NOT NULL DEFAULT '{}',
  resultado jsonb,
  erro text,
  tentativas smallint NOT NULL DEFAULT 0,
  profundidade smallint NOT NULL DEFAULT 0,
  cancelar boolean NOT NULL DEFAULT false,
  criado timestamptz NOT NULL DEFAULT now(),
  iniciado timestamptz,
  terminado timestamptz
);
CREATE INDEX trabalhos_owner ON trabalhos (owner_id, criado DESC);

CREATE TABLE uso_modelos (
  id bigserial PRIMARY KEY,
  owner_id uuid,
  provedor text NOT NULL,
  modelo text NOT NULL,
  nivel text NOT NULL,
  tokens_entrada integer NOT NULL DEFAULT 0,
  tokens_saida integer NOT NULL DEFAULT 0,
  custo_usd numeric(12, 6) NOT NULL DEFAULT 0,
  latencia_ms integer NOT NULL DEFAULT 0,
  ok boolean NOT NULL,
  erro text,
  em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uso_modelos_em ON uso_modelos (em);

CREATE TABLE acoes_pendentes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  ferramenta text NOT NULL,
  argumentos jsonb NOT NULL,
  resumo text NOT NULL,
  estado text NOT NULL DEFAULT 'aguardando' CHECK (estado IN ('aguardando', 'confirmada', 'recusada', 'expirada', 'falhou')),
  resultado jsonb,
  criada timestamptz NOT NULL DEFAULT now(),
  expira timestamptz NOT NULL
);

CREATE TABLE push_inscricoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  chaves jsonb NOT NULL,
  dispositivo text NOT NULL DEFAULT '',
  criada timestamptz NOT NULL DEFAULT now()
);

-- Computadores pareados (agente local).
CREATE TABLE dispositivos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  nome text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  permissoes text[] NOT NULL DEFAULT '{abrir,sistema,arquivos_leitura}',
  pareado timestamptz NOT NULL DEFAULT now(),
  ultimo_contato timestamptz,
  revogado boolean NOT NULL DEFAULT false
);
CREATE TABLE codigos_pareamento (hash text PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE, expira timestamptz NOT NULL);

-- Integrações (Google, GitHub): tokens cifrados com a chave mestra.
CREATE TABLE integracoes (
  owner_id uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  provedor text NOT NULL,
  dados_cifrados text NOT NULL,
  escopos text[] NOT NULL DEFAULT '{}',
  conta text NOT NULL DEFAULT '',
  criada timestamptz NOT NULL DEFAULT now(),
  atualizada timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, provedor)
);
CREATE TABLE oauth_estados (estado text PRIMARY KEY, owner_id uuid NOT NULL, provedor text NOT NULL, verificador text NOT NULL, expira timestamptz NOT NULL);
