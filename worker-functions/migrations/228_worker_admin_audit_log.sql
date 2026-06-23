-- Migration 228: worker_admin_audit_log
-- Trilho de auditoria DETALHADO das edições administrativas de worker
-- (perfil, dados profissionais, endereço, conta-teste). Registra quem, o quê
-- (campo a campo, antes→depois), quando, de onde (IP/user-agent) e trace.
--
-- Decisão de produto (2026-06-23): grava VALORES COMPLETOS (incl. PII) por
-- exigência de rastreabilidade total da edição admin. O acesso à tabela deve
-- ser restrito (mesma base encriptada; tratar como dado sensível).
--
-- Segue o schema canônico de audit (ADR-007 / job_posting_audit_log) + as
-- colunas ip_address e user_agent específicas deste trilho.

CREATE TABLE IF NOT EXISTS worker_admin_audit_log (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id      UUID         NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  event_type     VARCHAR(30)  NOT NULL
    CHECK (event_type IN ('CREATED', 'UPDATED', 'DELETED', 'STATUS_CHANGED', 'DRAFT_CHANGED')),
  field_name     VARCHAR(80),
  changes        JSONB        NOT NULL,
  -- Sem FK pra users: o trilho de auditoria NUNCA pode falhar/perder registro
  -- por integridade referencial (ator pode não ter linha em users; accountability acima de tudo).
  actor_user_id  VARCHAR(128),
  actor_email    VARCHAR(255),
  actor_type     VARCHAR(20)  NOT NULL DEFAULT 'HUMAN'
    CHECK (actor_type IN ('HUMAN', 'SYSTEM', 'WEBHOOK', 'CLI')),
  actor_label    VARCHAR(80),
  ip_address     INET,
  user_agent     TEXT,
  trace_id       TEXT,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_admin_audit_worker
  ON worker_admin_audit_log (worker_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_admin_audit_actor
  ON worker_admin_audit_log (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

COMMENT ON TABLE worker_admin_audit_log IS
  'Auditoria detalhada de edições admin do worker (quem/o-quê/quando/de-onde). Contém PII em changes — acesso restrito.';
COMMENT ON COLUMN worker_admin_audit_log.changes IS
  'Diff do campo: { "before": <valor>, "after": <valor> }. Valores completos (incl. PII) por decisão de rastreabilidade.';
