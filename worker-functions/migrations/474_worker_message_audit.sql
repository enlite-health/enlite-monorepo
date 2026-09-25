-- Migration 474: worker_message_audit — auditoria de decisão de disparo de mensageria (PR1)
--
-- Caso real: "por que essa prestadora recebeu pedido de documento?" levou 4 rodadas de
-- investigação porque nenhuma das 3 trilhas de mensageria hoje existentes (messaging_outbox,
-- whatsapp_bulk_dispatch_logs, funnel_stage_message_log) grava o ESTADO do worker no MOMENTO
-- da decisão — só se lê o status de hoje, que já pode ter mudado.
--
-- Aditiva. Convive com messaging_outbox, whatsapp_bulk_dispatch_logs e
-- funnel_stage_message_log (nenhuma é alterada) — ver design.md Decisão 6.
-- Sem PII: só worker_id, ids, enums. missing_documents é slug, nunca prosa.
--
-- Ver openspec/changes/log-auditoria-mensageria/{proposal,design}.md.
-- ============================================================

CREATE TABLE IF NOT EXISTS worker_message_audit (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Quem e em que contexto
  worker_id                     UUID NULL REFERENCES workers(id) ON DELETE SET NULL,
  job_posting_id                UUID NULL REFERENCES job_postings(id) ON DELETE SET NULL,
  template_slug                 TEXT NOT NULL,
  channel                       TEXT NULL
    CHECK (channel IS NULL OR channel IN ('twilio', 'periskope')),
  source                        TEXT NOT NULL
    CHECK (source IN ('bulk', 'individual', 'outbox', 'kanban', 'talentum', 'system')),
  actor_uid                     VARCHAR(128) NULL,
  trace_id                      TEXT NULL,

  -- Snapshot no instante da DECISÃO — o motivo de existir esta tabela
  worker_status_at_dispatch     TEXT NULL
    CHECK (worker_status_at_dispatch IS NULL OR worker_status_at_dispatch IN (
      'REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED'
    )),
  documents_status_at_dispatch  TEXT NULL
    CHECK (documents_status_at_dispatch IS NULL OR documents_status_at_dispatch IN (
      'pending', 'incomplete', 'submitted', 'under_review', 'approved', 'rejected'
    )),
  missing_documents             TEXT[] NOT NULL DEFAULT '{}'
    CHECK (missing_documents <@ ARRAY[
      'identity_document', 'identity_document_back', 'criminal_record',
      'resume_cv', 'at_certificate', 'monotributo_certificate',
      'liability_insurance', 'professional_registration'
    ]::text[]),

  -- O que aconteceu
  outcome                       TEXT NOT NULL
    CHECK (outcome IN ('queued', 'sent', 'skipped', 'failed')),
  skip_reason                   TEXT NULL,  -- livre: vocabulário do guard que decidiu (ver design.md)

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE worker_message_audit IS
  'Auditoria de DECISÃO de disparo de mensageria — não de entrega (isso é messaging_outbox / '
  'whatsapp_bulk_dispatch_logs / funnel_stage_message_log). Responde "por que este worker recebeu '
  '(ou não) esta mensagem", com o estado dele NO INSTANTE da decisão. Append-only. Sem PII: só '
  'worker_id, ids, enums.';

COMMENT ON COLUMN worker_message_audit.worker_status_at_dispatch IS
  'Snapshot de workers.status no momento em que o template foi escolhido — não é lido de volta de '
  'worker_status_history (populado por caminho diferente, sem vínculo confiável por timestamp).';

COMMENT ON COLUMN worker_message_audit.missing_documents IS
  'Slugs de workerDocumentPolicy.getRequiredSlugs() que estavam NULL no instante da decisão. '
  'NUNCA prosa (evita dado pessoal sobre documentos específicos de uma pessoa).';

COMMENT ON COLUMN worker_message_audit.skip_reason IS
  'Código do motivo de pulo/falha, no vocabulário do guard que decidiu (VacancyInviteGuard.code, '
  'StageSkipReason, InviteSkipReason, etc). Sem CHECK — vocabulário aberto entre os vários guards.';

-- "todas as mensagens desse worker, mais recentes primeiro"
CREATE INDEX IF NOT EXISTS idx_worker_message_audit_worker
  ON worker_message_audit(worker_id, created_at DESC)
  WHERE worker_id IS NOT NULL;

-- "quem recebeu template X nas últimas 48h" — outcome filtra fora os skips/failed
-- (mesma forma que VacancyInviteGuard.resendCooldownUntilSql usa status='sent')
CREATE INDEX IF NOT EXISTS idx_worker_message_audit_template_recent
  ON worker_message_audit(template_slug, created_at DESC)
  WHERE outcome IN ('queued', 'sent');

-- Retenção — mesmo padrão de funnel_stage_message_log (migration 292), 180 dias por
-- não ter PII (diferente do padrão de dado clínico, que teria retenção mais curta).
CREATE OR REPLACE FUNCTION archive_old_worker_message_audit(p_retention_days INT DEFAULT 180)
RETURNS BIGINT AS $$
DECLARE
  v_deleted BIGINT;
BEGIN
  DELETE FROM worker_message_audit
  WHERE created_at < NOW() - (p_retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;
