-- ============================================================
-- Migration 292: mensagem por etapa do funil (DEC-12 / PEND-14, planning 26/08)
-- lex 29/08 CONDICIONADO C3, C7, C10, C11 — travas no DDL
--
-- Hoje arrastar a tarjeta no Kanban grava a etapa e a auditoria, mas NÃO
-- emite evento — o único gatilho de mensagem por etapa é o webhook da
-- Talentum (QUALIFIED). Marcel (ata 26/08 ~496/~577): "passa de um lado ao
-- outro, manda essa mensagem".
--
-- 1) funnel_stage_messages: UMA linha por (país, etapa): qual template
--    aprovado da Twilio sai quando a tarjeta entra na etapa, ligado/desligado,
--    quem configurou. Nasce TUDO DESLIGADO ("religar com uma etapa, medir").
--    QUALIFIED é built-in (convite de entrevista, QualifiedInterviewHandler).
--    country NOT NULL sem default (plano F1 / lex C10).
-- 2) funnel_stage_messages_audit: cada alteração da config (quem, o quê, quando) — lex C7.
-- 3) funnel_stage_message_log: cada disparo (ou pulo) com AUTORIA — quem moveu,
--    quando, qual template — é a trilha de medição Luz × humano. Só ids +
--    motivo; sem telefone, sem texto.
-- Aditiva.
-- ============================================================

CREATE TABLE IF NOT EXISTS funnel_stage_messages (
  country        CHAR(2) NOT NULL CHECK (country IN ('AR', 'BR')),
  stage          TEXT NOT NULL CHECK (stage IN (
    'INVITED', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED', 'QUALIFIED',
    'IN_DOUBT', 'CONFIRMED', 'SELECTED', 'REJECTED'
  )),
  template_slug  TEXT NULL REFERENCES message_templates(slug) ON DELETE SET NULL,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  -- REQ-24: o canal é atributo da etapa; hoje só WhatsApp (canal oficial, nunca Periskope).
  channel        TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  -- Etapa cujo disparo é código, não configuração (QUALIFIED → convite de entrevista).
  builtin        TEXT NULL,
  updated_by     VARCHAR(128) NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (country, stage)
);

COMMENT ON TABLE funnel_stage_messages IS
  'Mensagem automática por etapa do Kanban (DEC-12). enabled=false por padrão; só templates ativos, categoria UTILITY, '
  'fora da deny-list de lembrete/cobrança e ELEGÍVEIS (placeholders que o sistema preenche) — ver StageTemplateEligibility. '
  'QUALIFIED é built-in. Edição: só admin, auditada em funnel_stage_messages_audit (lex 29/08 C5-C7).';

INSERT INTO funnel_stage_messages (country, stage, builtin) VALUES
  ('AR', 'INVITED', NULL), ('AR', 'PRE_SCREENING', NULL), ('AR', 'IN_PROGRESS', NULL), ('AR', 'COMPLETED', NULL),
  ('AR', 'QUALIFIED', 'interview_invite'), ('AR', 'IN_DOUBT', NULL), ('AR', 'CONFIRMED', NULL), ('AR', 'SELECTED', NULL), ('AR', 'REJECTED', NULL)
ON CONFLICT (country, stage) DO NOTHING;

CREATE TABLE IF NOT EXISTS funnel_stage_messages_audit (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country        CHAR(2) NOT NULL,
  stage          TEXT NOT NULL,
  template_slug  TEXT NULL,
  enabled        BOOLEAN NOT NULL,
  actor_uid      VARCHAR(128) NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE funnel_stage_messages_audit IS
  'Quem ligou/desligou/trocou o template de cada etapa, e quando (lex 29/08 C7). Append-only.';

CREATE TABLE IF NOT EXISTS funnel_stage_message_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       UUID NULL REFERENCES workers(id) ON DELETE CASCADE,
  job_posting_id  UUID NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  stage           TEXT NOT NULL,
  template_slug   TEXT NULL,
  -- Quem moveu a tarjeta (uid do staff) ou 'talentum' / 'system'.
  actor_uid       VARCHAR(128) NULL,
  source          TEXT NOT NULL CHECK (source IN ('kanban', 'talentum', 'system')),
  outbox_id       UUID NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'skipped')),
  skip_reason     TEXT NULL CHECK (skip_reason IS NULL OR skip_reason IN (
    'DISABLED', 'NO_TEMPLATE', 'TEMPLATE_INACTIVE', 'TEMPLATE_NOT_ALLOWED', 'WORKER_NOT_FOUND', 'WORKER_DISABLED',
    'OPT_OUT', 'ALREADY_SENT', 'VACANCY_NOT_FOUND', 'SOURCE_NOT_HUMAN', 'COUNTRY_BLOCKED'
  )),
  country         CHAR(2) NOT NULL CHECK (country IN ('AR', 'BR')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE funnel_stage_message_log IS
  'Trilha da mensagem por etapa: cada movimento de tarjeta que enfileirou (queued) ou pulou (skipped, com motivo) um template. '
  'Autoria = quem moveu. Só ids + motivo. Para OPT_OUT/WORKER_DISABLED o painel expõe contagem, nunca lista acionável. '
  'RETENÇÃO: 180 dias, apagada por archive_old_funnel_stage_logs().';

CREATE INDEX IF NOT EXISTS idx_funnel_stage_message_log_worker_job
  ON funnel_stage_message_log(worker_id, job_posting_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_stage_message_log_created
  ON funnel_stage_message_log(created_at);

-- Função própria de retenção (não toca archive_old_messages — outra branch a redefine).
CREATE OR REPLACE FUNCTION archive_old_funnel_stage_logs(p_retention_days INT DEFAULT 180)
RETURNS BIGINT AS $$
DECLARE
  v_deleted BIGINT;
BEGIN
  DELETE FROM funnel_stage_message_log
  WHERE created_at < NOW() - (p_retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;
