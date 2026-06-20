-- Migration 217: tabela imutável de auditoria de vagas (job_posting_audit_log).
--
-- CONTEXTO: rastreia toda mutação em job_postings com actor, campo e diff.
-- NÃO é domain_events (fila de integração) nem outbox (at-least-once delivery);
-- é um append-only log de auditoria humana/operacional.
--
-- Semântica da coluna `changes` (JSONB):
--   CREATED       → { "before": null, "after": <snapshot completo da vaga> }
--   DELETED       → { "before": <snapshot completo da vaga>, "after": null }
--   UPDATED       → uma linha por campo alterado: { "before": <valor_anterior>, "after": <valor_novo> }
--   STATUS_CHANGED → igual a UPDATED mas garante rastreamento dedicado de transições de status
--   DRAFT_CHANGED  → igual a UPDATED mas rastreia mudança de is_draft (publicação/despublicação)
--
-- Semântica de actor_type:
--   HUMAN   → usuário autenticado via Firebase (actor_user_id preenchido)
--   SYSTEM  → job/cron interno (actor_label indica o componente, ex: 'clickup-sync')
--   WEBHOOK → evento externo recebido via webhook (Talentum, ClickUp, etc.)
--   CLI     → script administrativo ou import manual
--
-- Idempotente: IF NOT EXISTS em todas as DDLs.

CREATE TABLE IF NOT EXISTS job_posting_audit_log (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id   UUID         NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  event_type       VARCHAR(30)  NOT NULL
    CHECK (event_type IN ('CREATED','UPDATED','DELETED','STATUS_CHANGED','DRAFT_CHANGED')),
  field_name       VARCHAR(80)  NULL,
  changes          JSONB        NOT NULL DEFAULT '{}',
  actor_user_id    VARCHAR(128) NULL REFERENCES users(firebase_uid) ON DELETE SET NULL,
  actor_type       VARCHAR(20)  NOT NULL DEFAULT 'HUMAN'
    CHECK (actor_type IN ('HUMAN','SYSTEM','WEBHOOK','CLI')),
  actor_label      VARCHAR(80)  NULL,
  trace_id         TEXT         NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE job_posting_audit_log IS
  'Append-only audit log de mutações em job_postings. '
  'NÃO confundir com domain_events (fila de integração) nem outbox (at-least-once delivery). '
  'Cada linha é imutável e registra um evento discreto de mudança.';

COMMENT ON COLUMN job_posting_audit_log.event_type IS
  'Tipo do evento: CREATED | UPDATED | DELETED | STATUS_CHANGED | DRAFT_CHANGED. '
  'UPDATED: 1 linha por campo alterado. CREATED/DELETED: snapshot completo em changes.';

COMMENT ON COLUMN job_posting_audit_log.field_name IS
  'Nome da coluna alterada (apenas para UPDATED, STATUS_CHANGED e DRAFT_CHANGED). '
  'NULL para CREATED e DELETED.';

COMMENT ON COLUMN job_posting_audit_log.changes IS
  'Diff em JSONB. '
  'CREATED: { before: null, after: <snapshot> }. '
  'DELETED: { before: <snapshot>, after: null }. '
  'UPDATED/STATUS_CHANGED/DRAFT_CHANGED: { before: <valor_anterior>, after: <valor_novo> }.';

COMMENT ON COLUMN job_posting_audit_log.actor_user_id IS
  'firebase_uid do usuário que executou a ação (FK para users). '
  'NULL quando a ação é automatizada (SYSTEM, WEBHOOK, CLI).';

COMMENT ON COLUMN job_posting_audit_log.actor_type IS
  'HUMAN: usuário Firebase autenticado. '
  'SYSTEM: job/cron interno. '
  'WEBHOOK: evento de sistema externo (Talentum, ClickUp). '
  'CLI: script administrativo ou import manual.';

COMMENT ON COLUMN job_posting_audit_log.actor_label IS
  'Label livre para identificar o componente ator quando actor_type != HUMAN. '
  'Ex: "clickup-sync", "talentum-webhook", "seed-script".';

COMMENT ON COLUMN job_posting_audit_log.trace_id IS
  'ID de rastreamento da requisição HTTP ou job que originou o evento. '
  'Correlaciona com jsonPayload.traceId no Cloud Logging.';

CREATE INDEX IF NOT EXISTS idx_jpal_job_posting
  ON job_posting_audit_log(job_posting_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jpal_actor_user
  ON job_posting_audit_log(actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jpal_event_type
  ON job_posting_audit_log(event_type, created_at DESC);
