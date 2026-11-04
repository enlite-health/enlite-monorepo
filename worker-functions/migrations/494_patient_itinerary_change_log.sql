-- Migration 494: `patient_itinerary_change_log` — o registro de trocas do itinerário
-- (change itinerario-trocas-motivos-e-figma, Fase 2, design D3). Molde de country/RLS/GRANT:
-- `490_service_team_contact_log.sql`.
--
-- Uma linha por evento de troca (substituição de um dia, substituição inteira, tirar do itinerário,
-- cancelamentos de agendamento). APPEND-ONLY: nunca UPDATE/DELETE. Sem texto livre e sem PII além de
-- ids: pessoa só por id, motivo só por `code` do catálogo (492). Não reaproveita a 484 (ausência) nem
-- põe motivo em `patient_itinerary_assignment` (linha mutável).
--
-- `destination` (RESERVE | LEAVE_SERVICE) é obrigatório para REPLACE/REMOVE e proibido nos demais
-- (`picl_destination_by_kind`). country em 3 etapas (trigger → NOT NULL → CHECK AR/BR), RLS segue o serviço.
--
-- Idempotente (2×). Sem BEGIN/COMMIT próprio.
-- Rollback: `migrations/pending/ROLLBACK_494_patient_itinerary_change_log.sql` (recusa se houver linha).

CREATE TABLE IF NOT EXISTS patient_itinerary_change_log (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  contracted_service_id UUID         NOT NULL REFERENCES patient_contracted_services(id) ON DELETE CASCADE,
  kind                  TEXT         NOT NULL,
  outgoing_worker_id    UUID         NOT NULL REFERENCES workers(id),
  incoming_worker_id    UUID         NULL     REFERENCES workers(id),
  assignment_id         UUID         NULL     REFERENCES patient_itinerary_assignment(id),
  new_assignment_id     UUID         NULL     REFERENCES patient_itinerary_assignment(id),
  absence_id            UUID         NULL     REFERENCES patient_itinerary_absence(id),
  effective_date        DATE         NOT NULL,
  reason_code           TEXT         NOT NULL REFERENCES service_exit_reasons(code),
  destination           TEXT         NULL,
  country               TEXT         NULL,  -- etapa 1: trigger abaixo preenche; etapa 2: NOT NULL; etapa 3: CHECK
  created_by            VARCHAR(128) NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT picl_kind_check CHECK (kind IN ('ABSENCE','REPLACE','REMOVE','SUBSTITUTE_CANCELLED','ENTRY_CANCELLED')),
  CONSTRAINT picl_destination_check CHECK (destination IS NULL OR destination IN ('RESERVE','LEAVE_SERVICE')),
  CONSTRAINT picl_destination_by_kind CHECK ((kind IN ('REPLACE','REMOVE')) = (destination IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_picl_service ON patient_itinerary_change_log (contracted_service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_picl_outgoing ON patient_itinerary_change_log (outgoing_worker_id);

-- ── country: 3 etapas (molde 490/481) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_picl_country_from_service()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT pcs.country INTO NEW.country FROM patient_contracted_services pcs WHERE pcs.id = NEW.contracted_service_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_picl_country ON patient_itinerary_change_log;
CREATE TRIGGER trg_picl_country
  BEFORE INSERT ON patient_itinerary_change_log
  FOR EACH ROW EXECUTE FUNCTION fn_picl_country_from_service();

ALTER TABLE patient_itinerary_change_log ALTER COLUMN country SET NOT NULL;

ALTER TABLE patient_itinerary_change_log DROP CONSTRAINT IF EXISTS picl_country_check;
ALTER TABLE patient_itinerary_change_log
  ADD CONSTRAINT picl_country_check CHECK (country IN ('AR', 'BR'));

-- ── RLS: segue o serviço (molde 490) ──────────────────────────────────────────
ALTER TABLE patient_itinerary_change_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_itinerary_change_log_follow_service ON patient_itinerary_change_log;
CREATE POLICY patient_itinerary_change_log_follow_service ON patient_itinerary_change_log FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_contracted_services pcs WHERE pcs.id = patient_itinerary_change_log.contracted_service_id)
);

-- ── GRANT/REVOKE — sem DELETE, sem UPDATE (append-only) ───────────────────────
GRANT SELECT, INSERT ON patient_itinerary_change_log TO app_runtime, app_system;
REVOKE DELETE, UPDATE ON patient_itinerary_change_log FROM app_runtime, app_system;

COMMENT ON TABLE patient_itinerary_change_log IS
  'Registro de trocas do itinerário (substituição de um dia/inteira, saída, cancelamento de agendamento). '
  'Append-only: nunca UPDATE/DELETE. Sem texto livre: pessoa só por id, motivo só por code do catálogo '
  '(service_exit_reasons). Rollback: migrations/pending/ROLLBACK_494_patient_itinerary_change_log.sql.';
COMMENT ON COLUMN patient_itinerary_change_log.country IS
  'Herdado de patient_contracted_services.country por trigger (etapa 1/3). NOT NULL (etapa 2/3) + CHECK AR/BR (etapa 3/3).';
