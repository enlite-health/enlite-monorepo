-- 485 — as 2 transições que a derivação por horas produz e o seed da 315 não tinha — liberadas
-- pela D430 (25/09). A derivação é a cadeia Fase 15 (change cadeia-paciente-vacante-itinerario):
-- `derivarEstadoPaciente` decide e a escrita é sempre por `movePatientStatus` com
-- changeSource = 'system', só para paciente com itinerário montado (D429).
--   SEARCHING → REPLACEMENT  (a 1ª alocação cobre parte das horas contratadas)
--   ACTIVE    → SEARCHING    (o último titular sai e a cobertura volta a zero)
-- Com elas, as 6 que a derivação produz estão no catálogo. Nenhuma outra: ON_HOLD → REPLACEMENT
-- segue proibida. Idempotente (o par já existente é ignorado) — reaplicar não muda nada.
-- Rollback: migrations/pending/ROLLBACK_485_patient_status_transitions_derivacao.sql.

INSERT INTO patient_status_transitions (from_status, to_status) VALUES
  ('SEARCHING', 'REPLACEMENT'),
  ('ACTIVE',    'SEARCHING')
ON CONFLICT (from_status, to_status) DO NOTHING;
