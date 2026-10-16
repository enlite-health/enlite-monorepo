-- 504 — Aba Admissão (spec 049, F1): mensagens esperadas (claim único) + trilha append-only
--
-- POR QUÊ: o aviso da reunião saía sem registro de quem mandou o quê; dois `onBooked` ou duas entregas do Cloud Tasks podiam
-- mandar 2 WhatsApps (spec §2.1, M1/M3). Agora há UMA linha por mensagem esperada e só quem ganha o
-- `INSERT … ON CONFLICT DO NOTHING RETURNING` envia: o UNIQUE(appointment_id, kind, attempt) é o freio, no BANCO.
-- `admission_events` é a trilha (um registro por passo, nunca editado). Só ids/enum/motivo — nenhum telefone, nome, texto clínico.
--
-- Idempotente (2×). RLS segue a reunião (que segue o paciente) — molde 271/497/502.
-- ROLLBACK: migrations/pending/ROLLBACK_504_admission_049_messages_events.sql

BEGIN;

-- ── A. Mensagens esperadas ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admission_messages (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id    UUID         NOT NULL REFERENCES admission_appointments(id) ON DELETE CASCADE,
  kind              TEXT         NOT NULL CHECK (kind IN ('confirmation', 'reminder_30min')),
  attempt           SMALLINT     NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 2),
  status            TEXT         NOT NULL DEFAULT 'claimed' CHECK (status IN (
    'claimed', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'send_failed', 'cancelled',
    'skipped_test', 'skipped_no_consent', 'skipped_no_phone', 'skipped_no_template')),
  twilio_sid        TEXT         NULL,
  requested_by_uid  VARCHAR(128) NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_admission_messages_claim UNIQUE (appointment_id, kind, attempt)
);

-- O callback da Twilio acha a linha pelo SID: um SID, uma linha.
CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_messages_twilio_sid
  ON admission_messages (twilio_sid) WHERE twilio_sid IS NOT NULL;

ALTER TABLE admission_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admission_messages_follow_appointment ON admission_messages;
CREATE POLICY admission_messages_follow_appointment ON admission_messages FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM admission_appointments a WHERE a.id = admission_messages.appointment_id)
);

-- ALTER DEFAULT PRIVILEGES do banco concede também DELETE: tira (linha de mensagem não se apaga, só a cascata da reunião).
REVOKE DELETE ON admission_messages FROM app_runtime, app_system;
GRANT SELECT, INSERT, UPDATE ON admission_messages TO app_runtime, app_system;

COMMENT ON TABLE admission_messages IS
  'Uma linha por mensagem esperada da reunião de admissão (spec 049). UNIQUE(appointment_id, kind, attempt) = o claim: quem ganha o INSERT envia. '
  'Todo skip vira linha (skipped_*). Só ids/enum — nunca telefone nem texto.';

-- ── B. Trilha append-only ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admission_events (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL só para os eventos do vínculo do Tactiq (`tactiq_link.*`), que não têm reunião.
  appointment_id  UUID         NULL REFERENCES admission_appointments(id) ON DELETE CASCADE,
  host_email      TEXT         NULL,
  at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  kind            TEXT         NOT NULL,
  outcome         TEXT         NULL,
  reason          TEXT         NULL,
  -- Só ids: SID, nome da task, id da reunião no Tactiq, generation, sha256.
  ref             JSONB        NULL,
  trace_id        TEXT         NULL,
  CONSTRAINT admission_events_sem_reuniao_so_vinculo CHECK (
    appointment_id IS NOT NULL OR (kind LIKE 'tactiq\_link.%' AND host_email IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_admission_events_appointment ON admission_events (appointment_id, at);

-- Append-only (molde fn_ptpcs_imutavel, 502): UPDATE nunca; DELETE só quando a reunião-mãe já não existe
-- (cascata do purge de paciente de teste). Evento de vínculo (sem reunião) nunca se apaga.
CREATE OR REPLACE FUNCTION fn_admission_events_imutavel()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.appointment_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM admission_appointments a WHERE a.id = OLD.appointment_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'admission_events_imutavel: a trilha não se apaga' USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'admission_events_imutavel: a trilha não se edita — registre um evento novo' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admission_events_imutavel ON admission_events;
CREATE TRIGGER trg_admission_events_imutavel
  BEFORE UPDATE OR DELETE ON admission_events
  FOR EACH ROW EXECUTE FUNCTION fn_admission_events_imutavel();

ALTER TABLE admission_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admission_events_follow_appointment ON admission_events;
CREATE POLICY admission_events_follow_appointment ON admission_events FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  -- evento de vínculo do Tactiq: sem paciente, só e-mail do responsável + estado (a rota exige a célula own_tactiq_link)
  OR appointment_id IS NULL
  OR EXISTS (SELECT 1 FROM admission_appointments a WHERE a.id = admission_events.appointment_id)
);

-- Append-only também nos privilégios (o trigger é a trava forte; isto tira o convite): só SELECT e INSERT.
REVOKE UPDATE, DELETE ON admission_events FROM app_runtime, app_system;
GRANT SELECT, INSERT ON admission_events TO app_runtime, app_system;

COMMENT ON TABLE admission_events IS
  'Trilha append-only da reunião de admissão (spec 049): um registro por passo. Trigger recusa UPDATE/DELETE. '
  'ref guarda SÓ ids. appointment_id NULL só para tactiq_link.*.';

COMMIT;
