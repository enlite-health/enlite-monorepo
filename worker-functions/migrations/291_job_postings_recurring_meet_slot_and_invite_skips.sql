-- ============================================================
-- Migration 291: slot RECORRENTE de entrevista na vaga + pulos do convite contáveis
-- (D211.4, planning 26/08 · lex 29/08 CONDICIONADO C1-C8)
--
-- Medido em prod (29/08): 307 aprovações da Talentum em 60 d, 304 convites de
-- entrevista PULADOS porque os 3 `meet_datetime_N` fixos da vaga já tinham
-- passado (a vaga fica ~102 d aberta). A "reunión de presentación" é um
-- encontro SEMANAL de manhã (segunda 08:30 = 26 vagas, terça 08:30 = 11…).
--
-- 1) job_postings ganha UM slot recorrente semanal (dia + hora LOCAL no
--    `timezone` da vaga + sala). Convive com os 3 slots fixos (mig 098).
-- 2) interview_invite_skips: cada convite pulado vira linha contável (antes era
--    `console.warn` — indistinguível de sucesso em domain_events). Molde da
--    OP-08: ids + motivo + timestamp; SEM telefone, SEM texto, SEM variables.
--    `country NOT NULL` sem default (plano de compliance F1).
-- Aditiva: nada é dropado.
-- ============================================================

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS meet_recurring_weekday SMALLINT DEFAULT NULL
    CHECK (meet_recurring_weekday IS NULL OR meet_recurring_weekday BETWEEN 0 AND 6),
  ADD COLUMN IF NOT EXISTS meet_recurring_time TIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS meet_recurring_link TEXT DEFAULT NULL;

COMMENT ON COLUMN job_postings.meet_recurring_weekday IS
  'Dia da semana da reunión de presentación recorrente (0=domingo … 6=sábado). NULL = sem recorrência.';
COMMENT ON COLUMN job_postings.meet_recurring_time IS
  'Hora LOCAL da reunião recorrente, no fuso de job_postings.timezone (mig 180). Nunca UTC.';
COMMENT ON COLUMN job_postings.meet_recurring_link IS
  'Sala do Google Meet da reunião recorrente (https://meet.google.com/xxx-xxxx-xxx).';

-- Os três andam juntos: recorrência sem hora ou sem sala não é ofertável.
ALTER TABLE job_postings
  DROP CONSTRAINT IF EXISTS job_postings_meet_recurring_complete;
ALTER TABLE job_postings
  ADD CONSTRAINT job_postings_meet_recurring_complete CHECK (
    (meet_recurring_weekday IS NULL AND meet_recurring_time IS NULL AND meet_recurring_link IS NULL)
    OR (meet_recurring_weekday IS NOT NULL AND meet_recurring_time IS NOT NULL AND meet_recurring_link IS NOT NULL)
  );

-- ── Pulos do convite de entrevista ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interview_invite_skips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       UUID NULL REFERENCES workers(id) ON DELETE CASCADE,
  job_posting_id  UUID NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  domain_event_id UUID NULL,
  country         CHAR(2) NOT NULL CHECK (country IN ('AR', 'BR')),
  reason          TEXT NOT NULL CHECK (reason IN (
    'VACANCY_NOT_FOUND', 'NO_FUTURE_SLOT', 'WORKER_NOT_FOUND',
    'WORKER_DISABLED', 'OPT_OUT', 'ALREADY_INVITED'
  )),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE interview_invite_skips IS
  'Convites de entrevista (funnel_stage.qualified → qualified_worker_request) que NÃO saíram, com o motivo. '
  'Finalidade: medição (gestão à vista) e detecção de desvio (Ley 25.326 art. 9). '
  'Só ids + motivo + timestamp — sem telefone, sem texto. Para OPT_OUT/WORKER_DISABLED o painel expõe CONTAGEM, nunca lista acionável (lex 29/08 C6). '
  'RETENÇÃO: 180 dias, apagada por archive_old_messages() (p_skips_retention_days). Nunca é fonte do opt-out (messaging_opt_out é a fonte).';

CREATE INDEX IF NOT EXISTS idx_interview_invite_skips_created_at
  ON interview_invite_skips(created_at);
CREATE INDEX IF NOT EXISTS idx_interview_invite_skips_reason_created
  ON interview_invite_skips(reason, created_at);

-- ── Retenção: a MESMA função de archiving (mig 087) ganha o 3º alvo ─────────────
-- Retorno preservado (2 colunas) para quem já chama `SELECT archive_old_messages()`.
-- A assinatura de 2 parâmetros é REMOVIDA antes: CREATE OR REPLACE com parâmetro
-- novo criaria uma SOBRECARGA e `archive_old_messages()` ficaria ambígua.
DROP FUNCTION IF EXISTS archive_old_messages(INT, INT);
CREATE OR REPLACE FUNCTION archive_old_messages(
  p_outbox_retention_days INT DEFAULT 90,
  p_bulk_retention_days INT DEFAULT 365,
  p_skips_retention_days INT DEFAULT 180
)
RETURNS TABLE(outbox_deleted BIGINT, bulk_deleted BIGINT) AS $$
DECLARE
  v_outbox_deleted BIGINT;
  v_bulk_deleted BIGINT;
BEGIN
  DELETE FROM messaging_outbox
  WHERE status IN ('sent', 'failed')
    AND processed_at < NOW() - (p_outbox_retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_outbox_deleted = ROW_COUNT;

  DELETE FROM whatsapp_bulk_dispatch_logs
  WHERE dispatched_at < NOW() - (p_bulk_retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_bulk_deleted = ROW_COUNT;

  -- interview_invite_skips: registro de medição, não de opt-out — pode ir embora.
  DELETE FROM interview_invite_skips
  WHERE created_at < NOW() - (p_skips_retention_days || ' days')::INTERVAL;

  RETURN QUERY SELECT v_outbox_deleted, v_bulk_deleted;
END;
$$ LANGUAGE plpgsql;
