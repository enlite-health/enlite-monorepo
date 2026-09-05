-- 313 — `patients.admission_status`: o funil de ADMISSÃO separado do estado CLÍNICO (spec 012, US-B7)
--
-- ── O problema ──────────────────────────────────────────────────────────────
-- `patients.status` misturava duas perguntas: "em que ponto do funil de admissão está?"
-- (SOLICITANTE → ADMISSION → PENDING_ADMISSION) e "em que estado está o serviço?" (ACTIVE,
-- SUSPENDED, ...). Com os seis estados da decisão 2 do Gabriel (03/09) — ACTIVE · ON_HOLD ·
-- SEARCHING · REPLACEMENT · SUSPENDED · DISCHARGED — a mistura vira ambiguidade: um paciente
-- ON_HOLD já passou pela admissão; um SOLICITANTE não tem estado de serviço nenhum.
--
-- ⇒ Coluna NOVA, aditiva: `admission_status` ∈ SOLICITANTE | ADMISSION | PENDING_ADMISSION | DONE.
--    O Kanban de pacientes passa a ler ESTA coluna (coluna "Activo" = DONE).
--    `status` fica com o estado clínico (314) e, enquanto o paciente está na admissão, continua
--    carregando o valor legado (SOLICITANTE/ADMISSION/PENDING_ADMISSION) — "legados até backfill"
--    da spec: nenhum leitor de `status` (SLA, funil, stats, botão Activar) quebra.
--
-- ── Coerência por TRIGGER, não por instrução ────────────────────────────────
-- Quem escreve `status` hoje: PatientIdentityRepository (upsert do ClickUp, `status =
-- EXCLUDED.status`), PatientService.moveStatus, ActivatePatientUseCase (SQL direto). Três
-- escritores, e o sync do ClickUp é o maior. Pedir a cada um que escreva `admission_status`
-- junto é a fiação que ninguém liga (a lição do dual-write da 310). O trigger deriva:
--   status ∈ {SOLICITANTE, ADMISSION, PENDING_ADMISSION} → admission_status = status
--   status ∈ estados clínicos                            → admission_status = 'DONE'
--   status NULL (ClickUp sem status reconhecido)         → não mexe
--
-- Rollback: DROP TRIGGER trg_patients_admission_status_sync; DROP FUNCTION
-- fn_patients_admission_status_sync(); ALTER TABLE patients DROP COLUMN admission_status.

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS admission_status TEXT NOT NULL DEFAULT 'DONE';

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_admission_status_check;
ALTER TABLE patients
  ADD CONSTRAINT patients_admission_status_check
  CHECK (admission_status IN ('SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION', 'DONE'));

-- Backfill: quem está no funil leva o próprio valor; todo o resto já passou (DONE, o default).
-- Idempotente: só toca quem diverge.
UPDATE patients
   SET admission_status = status
 WHERE status IN ('SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION')
   AND admission_status IS DISTINCT FROM status;

CREATE OR REPLACE FUNCTION fn_patients_admission_status_sync()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION') THEN
    NEW.admission_status := NEW.status;
  ELSIF NEW.status IS NOT NULL THEN
    NEW.admission_status := 'DONE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patients_admission_status_sync ON patients;
-- BEFORE, para que a linha já nasça/mude coerente e o trigger de histórico (254, AFTER) veja
-- os dois campos finais. `OF status`: um UPDATE que não toca status não recalcula nada.
CREATE TRIGGER trg_patients_admission_status_sync
  BEFORE INSERT OR UPDATE OF status ON patients
  FOR EACH ROW EXECUTE FUNCTION fn_patients_admission_status_sync();

CREATE INDEX IF NOT EXISTS idx_patients_admission_status
  ON patients (admission_status) WHERE deleted_at IS NULL;

COMMENT ON COLUMN patients.admission_status IS
  'Funil de ADMISSÃO (migration 313): SOLICITANTE | ADMISSION | PENDING_ADMISSION | DONE. '
  'DERIVADO de `status` por trigger (fn_patients_admission_status_sync) — nenhum caminho de '
  'aplicação precisa escrever aqui. O Kanban de pacientes lê esta coluna; `status` é o estado '
  'clínico do serviço (314). Spec 012, US-B7.';
