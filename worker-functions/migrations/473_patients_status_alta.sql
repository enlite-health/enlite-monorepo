-- 473 — ALTA: valor novo de patients.status (D430) e as linhas "de qualquer estado → ALTA/DISCHARGED" (D432),
-- inclusive alta <-> baja nos dois sentidos (D437, CTO Q6). Nenhuma OUTRA saída de ALTA ou DISCHARGED nasce aqui
-- (a volta ao funil é nova admissão, lacuna I — fora desta fase). Nenhum paciente é reclassificado (Q-A3).
-- Rollback: migrations/pending/ROLLBACK_473_patients_status_alta.sql (só com 0 pacientes em ALTA).
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_status_check;
ALTER TABLE patients ADD CONSTRAINT patients_status_check
  CHECK (status IS NULL OR status IN (
    'ACTIVE', 'ON_HOLD', 'SEARCHING', 'REPLACEMENT', 'SUSPENDED', 'ALTA', 'DISCHARGED',
    'SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION',
    'DISCONTINUED'
  ));

COMMENT ON CONSTRAINT patients_status_check ON patients IS
  'PatientStatus v2 (migration 314): ACTIVE, ON_HOLD, SEARCHING, REPLACEMENT, SUSPENDED, ALTA, '
  'DISCHARGED + funil (SOLICITANTE, ADMISSION, PENDING_ADMISSION — ver admission_status, 313). '
  'DISCONTINUED é legado tolerado (backfill → DISCHARGED, migration 314). ALTA manual, migration '
  '473 (D430). Transições permitidas: patient_status_transitions (315, 473).';

INSERT INTO patient_status_transitions (from_status, to_status) VALUES
  ('SOLICITANTE','ALTA'), ('ADMISSION','ALTA'), ('PENDING_ADMISSION','ALTA'),
  ('SEARCHING','ALTA'), ('REPLACEMENT','ALTA'), ('ACTIVE','ALTA'), ('ON_HOLD','ALTA'), ('SUSPENDED','ALTA'),
  ('SOLICITANTE','DISCHARGED'), ('ADMISSION','DISCHARGED'), ('PENDING_ADMISSION','DISCHARGED'),
  ('DISCHARGED','ALTA'), ('ALTA','DISCHARGED')
ON CONFLICT (from_status, to_status) DO NOTHING;
