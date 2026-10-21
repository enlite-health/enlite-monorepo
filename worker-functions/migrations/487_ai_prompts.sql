-- Migration 487: ai_prompts + ai_prompt_audit_log (spec 029 — prompts de IA editáveis)
--
-- CONTEXTO: hoje os textos enviados ao modelo (descrição de vaga no Talentum, perguntas de
-- prescreening de AT e de Cuidador) vivem em constante de código ou documento do Google Drive —
-- mudar exige deploy, ou depende de um caminho sem trilha de quem editou. `ai_prompts` guarda o
-- conteúdo editável pela tela de administração; `ai_prompt_audit_log` é a trilha append-only de
-- quem mudou o quê.
--
-- Schema exato: specs/029-prompts-ia-editaveis/data-model.md (este documento manda). Molde:
-- migrations/059_add_message_templates.sql (tabela de conteúdo) e
-- migrations/217_job_posting_audit_log.sql (trilha append-only).
--
-- Idempotente (IF NOT EXISTS em toda DDL). Sem BEGIN/COMMIT, sem DROP — aditiva.

CREATE TABLE IF NOT EXISTS ai_prompts (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(64)  UNIQUE NOT NULL
    CHECK (slug IN ('VACANCY_DESCRIPTION', 'PRESCREENING_AT', 'PRESCREENING_CAREGIVER')),
  body        TEXT         NOT NULL
    CHECK (length(btrim(body)) > 0),
  version     INTEGER      NOT NULL DEFAULT 1,
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_by  VARCHAR(128),
  updated_by  VARCHAR(128),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ai_prompts IS
  'Conteúdo editável dos prompts de IA da plataforma (spec 029). Conjunto de slugs FECHADO nos '
  'dois lados: CHECK aqui e união de tipos em domain/AiPromptSlug.ts (data-model.md). Não há '
  'coluna de nome nem de descrição: rótulo de aba e texto de apoio vivem no i18n do frontend, '
  'indexados pelo slug (princípio II da constituição — texto de interface não se grava no banco '
  'sem tradução).';

COMMENT ON COLUMN ai_prompts.version IS
  'Lock otimista: toda escrita exige a versão que o cliente leu; divergiu, responde conflito e '
  'NÃO grava (regra 1 de "Regras de escrita", data-model.md).';

CREATE TABLE IF NOT EXISTS ai_prompt_audit_log (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id      UUID         NOT NULL REFERENCES ai_prompts(id) ON DELETE CASCADE,
  event_type     VARCHAR(20)  NOT NULL
    CHECK (event_type IN ('CREATED', 'UPDATED', 'RESTORED')),
  field_name     VARCHAR(80)  NOT NULL DEFAULT 'body',
  changes        JSONB        NOT NULL DEFAULT '{}',
  -- ⚠️ actor_user_id SEM CHAVE ESTRANGEIRA — decisão deliberada (D440), NÃO esquecimento.
  -- O molde 217 (job_posting_audit_log) referencia users(firebase_uid) ON DELETE SET NULL: ao
  -- apagar o usuário, a autoria dos eventos antigos vira NULL em silêncio, destruindo
  -- retroativamente o "100% das alterações com autor identificável" do SC-003. Esta tabela é
  -- trilha de auditoria, não invariante referencial. NÃO adicionar FK aqui depois.
  actor_user_id  VARCHAR(128),
  actor_type     VARCHAR(20)  NOT NULL DEFAULT 'HUMAN'
    CHECK (actor_type IN ('HUMAN', 'SYSTEM', 'WEBHOOK', 'CLI')),
  actor_label    VARCHAR(80),
  trace_id       TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (actor_type <> 'HUMAN' OR actor_user_id IS NOT NULL),
  CHECK (actor_type = 'HUMAN' OR actor_label IS NOT NULL)
);

COMMENT ON TABLE ai_prompt_audit_log IS
  'Trilha append-only de ai_prompts (spec 029). A aplicação nunca faz UPDATE nem DELETE aqui: '
  'uma restauração é um evento RESTORED novo, não a reescrita do passado. changes.before/after '
  'guardam o conteúdo INTEGRAL do campo body, não a diferença (data-model.md, research.md D3). '
  'Escrita usa logEvent — nunca logEventSafe: se o evento não gravar, a escrita do conteúdo tem '
  'de abortar junto, porque aqui a trilha É a funcionalidade (FR-013, FR-014), não acessório.';

COMMENT ON COLUMN ai_prompt_audit_log.actor_user_id IS
  'uid de quem executou a ação, DE PROPÓSITO sem chave estrangeira (ver comentário acima da '
  'coluna na DDL, e D440). NULL permitido apenas quando actor_type <> ''HUMAN''.';

CREATE INDEX IF NOT EXISTS idx_ai_prompt_audit_log_prompt
  ON ai_prompt_audit_log (prompt_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_audit_log_actor_user
  ON ai_prompt_audit_log (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;
