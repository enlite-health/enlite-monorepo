-- 595 — spec 095: o webhook do Talentum como fonte única (T-095-10).
--   1. talentum_status_precedence(text): a ordem do status do espelho (spec §3.1), fonte única; o upsert (T-095-11) só
--      grava o novo status se precedência(novo) >= precedência(atual).
--   2. EXPIRED no CHECK de talentum_prescreenings.status; TALENTUM_EXPIRED nos CHECKs de
--      encuadres.rejection_reason_category e worker_job_application_stage_history.reason_category.
--   3. talentum_webhook_inbox: a trilha de "o que o Talentum nos mandou e quando" (spec §3.2); corpo cifrado (payload_enc).
--   4. talentum_webhook_alarm_state: dedup do sino (spec §3.5).
--
-- Um dono por conceito (modelar-dado): a inbox é dona de "o que chegou e quando"; talentum_prescreenings continua dona
-- do status do espelho; ninguém lê a inbox para decidir etapa (só quem processa e quem alarma).
--
-- Privilégios: GRANT explícito por tabela (sem ALTER DEFAULT PRIVILEGES), molde 443/548. Sem RLS (tabela de integração,
-- como talentum_prescreenings e anacare_sync_run: sem policy por país). Roda como `enlite_app` (dono): NENHUM REVOKE
-- no próprio dono; REVOKE só de PUBLIC. Sem SECURITY DEFINER. Idempotente (2x). Sem BEGIN/COMMIT (o runner envolve).
--
-- Rollback (par): DROP TABLE talentum_webhook_alarm_state, talentum_webhook_inbox; DROP FUNCTION talentum_status_precedence(text);
--   e recriar os 3 CHECKs sem o valor novo (listas de 129 / 117 / 478), depois de provar que nenhuma linha usa o valor.

-- ── 1. Precedência do status do espelho (molde funnel_stage_precedence, 477) ─────────────────────────────
CREATE OR REPLACE FUNCTION talentum_status_precedence(status text)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE status
    WHEN 'INITIATED'     THEN 0
    WHEN 'IN_PROGRESS'   THEN 1
    WHEN 'COMPLETED'     THEN 2
    WHEN 'ANALYZED'      THEN 3
    WHEN 'PENDING'       THEN 3
    WHEN 'QUALIFIED'     THEN 4
    WHEN 'NOT_QUALIFIED' THEN 4
    WHEN 'IN_DOUBT'      THEN 4
    WHEN 'EXPIRED'       THEN 4
    ELSE -1
  END;
$$;

COMMENT ON FUNCTION talentum_status_precedence(text) IS
  'Ordem do status de talentum_prescreenings (spec 095 §3.1): o status nunca regride. Desconhecido = -1. Empate grava o novo (veredito -> veredito).';

-- ── 2. CHECKs: só o valor novo entra (lista atual copiada da última migration que a define) ──────────────
-- talentum_prescreenings_status_check (última: 129) + EXPIRED
ALTER TABLE talentum_prescreenings DROP CONSTRAINT IF EXISTS talentum_prescreenings_status_check;
ALTER TABLE talentum_prescreenings ADD CONSTRAINT talentum_prescreenings_status_check
  CHECK (status IN ('INITIATED', 'IN_PROGRESS', 'COMPLETED', 'ANALYZED', 'QUALIFIED', 'NOT_QUALIFIED', 'IN_DOUBT', 'PENDING', 'EXPIRED'));

-- encuadres_rejection_reason_category_check (última: 117) + TALENTUM_EXPIRED
ALTER TABLE encuadres DROP CONSTRAINT IF EXISTS encuadres_rejection_reason_category_check;
ALTER TABLE encuadres ADD CONSTRAINT encuadres_rejection_reason_category_check
  CHECK (rejection_reason_category IN (
    'DISTANCE', 'SCHEDULE_INCOMPATIBLE', 'INSUFFICIENT_EXPERIENCE',
    'SALARY_EXPECTATION', 'WORKER_DECLINED', 'OVERQUALIFIED',
    'DEPENDENCY_MISMATCH', 'TALENTUM_NOT_QUALIFIED', 'TALENTUM_EXPIRED', 'OTHER'
  ));

-- wjash_reason_category_check (última: 478) + TALENTUM_EXPIRED
ALTER TABLE worker_job_application_stage_history DROP CONSTRAINT IF EXISTS wjash_reason_category_check;
ALTER TABLE worker_job_application_stage_history ADD CONSTRAINT wjash_reason_category_check CHECK (
  reason_category IS NULL OR reason_category IN (
    'ENCUADRE_ANTECIPADO','REAPROVEITADO_DE_OUTRA_VAGA','INDICACAO_DA_EQUIPE',
    'DISTANCE','SCHEDULE_INCOMPATIBLE','INSUFFICIENT_EXPERIENCE','SALARY_EXPECTATION','WORKER_DECLINED',
    'OVERQUALIFIED','DEPENDENCY_MISMATCH','TALENTUM_NOT_QUALIFIED','TALENTUM_EXPIRED',
    'REAVALIACAO','REJEITADO_POR_ENGANO',
    'OTHER'
  )
);

-- ── 3. Inbox do webhook ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS talentum_webhook_inbox (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  body_hash                TEXT         NOT NULL UNIQUE,
  action                   TEXT         NOT NULL,
  subtype                  TEXT         NULL,
  status_label             TEXT         NULL,
  talentum_prescreening_id TEXT         NULL,
  talentum_profile_id      TEXT         NULL,
  environment              TEXT         NOT NULL,
  ingress_host             TEXT         NULL,
  state                    TEXT         NOT NULL
    CONSTRAINT talentum_webhook_inbox_state_check
    CHECK (state IN ('RECEIVED','PROCESSED','FAILED','REJECTED_SCHEMA','UNSUPPORTED')),
  attempts                 INTEGER      NOT NULL DEFAULT 0
    CONSTRAINT talentum_webhook_inbox_attempts_check CHECK (attempts >= 0),
  processed_at             TIMESTAMPTZ  NULL,
  error_code               TEXT         NULL,
  payload_enc              TEXT         NULL
);

CREATE INDEX IF NOT EXISTS idx_talentum_webhook_inbox_key
  ON talentum_webhook_inbox (talentum_prescreening_id, talentum_profile_id, received_at);
CREATE INDEX IF NOT EXISTS idx_talentum_webhook_inbox_pending
  ON talentum_webhook_inbox (received_at) WHERE state <> 'PROCESSED';

COMMENT ON TABLE talentum_webhook_inbox IS
  'O que o Talentum nos mandou e quando (spec 095 §3.2). Dona só de "chegou"; o status do espelho é de talentum_prescreenings e ninguém lê esta tabela para decidir etapa. '
  'payload_enc = corpo cifrado (KMS), PII; nulo depois da poda (7 dias após PROCESSED); metadados por 90 dias. error_code sem PII (code/constraint do pg).';

-- ── 4. Estado de dedup do alarme (sino) ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS talentum_webhook_alarm_state (
  alarme          TEXT         PRIMARY KEY,
  aberto_desde    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ultimo_aviso_em TIMESTAMPTZ  NULL,
  quantidade      INTEGER      NOT NULL DEFAULT 0
    CONSTRAINT talentum_webhook_alarm_state_quantidade_check CHECK (quantidade >= 0)
);

COMMENT ON TABLE talentum_webhook_alarm_state IS
  'Dedup do sino do webhook do Talentum (spec 095 §3.5): uma linha por alarme aberto (chave `alarme`); sem PII.';

-- ── 5. Privilégios (GRANT explícito; REVOKE só de PUBLIC, nunca do dono) ─────────────────────────────────
REVOKE ALL ON talentum_webhook_inbox FROM PUBLIC;
REVOKE ALL ON talentum_webhook_alarm_state FROM PUBLIC;
-- DELETE na inbox: a poda de metadados (90 dias). O alarm_state apaga a linha ao fechar o alarme.
GRANT SELECT, INSERT, UPDATE, DELETE ON talentum_webhook_inbox TO app_runtime, app_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON talentum_webhook_alarm_state TO app_runtime, app_system;
