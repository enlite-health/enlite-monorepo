-- 595 — as 5 setas de RETOMADA e REATIVAÇÃO (estado-automatico-do-paciente, F3; D5/D9; design §1.1 E4).
-- "Retomar" (de ON_HOLD/SUSPENDED) e "Reativar" (de DISCHARGED) re-derivam o destino pelo itinerário (`resolverRetomada`): sem
-- itinerário → SEARCHING; com horas → ACTIVE/REPLACEMENT. Sem as setas abaixo a derivação devolveria um destino que a FSM recusa:
--   ON_HOLD    → REPLACEMENT   (nova)
--   SUSPENDED  → SEARCHING     (já criada pela 486; o ON CONFLICT a ignora)
--   SUSPENDED  → REPLACEMENT   (já criada pela 486)
--   DISCHARGED → SEARCHING     (nova)
--   DISCHARGED → REPLACEMENT   (nova)
-- (`ON_HOLD → ACTIVE|SEARCHING`, `SUSPENDED → ACTIVE` e `DISCHARGED → ACTIVE` já existem desde a 315.)
-- A política por origem (`POLITICA_POR_ORIGEM`) é que decide QUEM pode usar cada seta; aditiva, sem dado de paciente alterado.
-- Idempotente: INSERT … ON CONFLICT DO NOTHING — reaplicar não muda nada.
-- Rollback: migrations/pending/ROLLBACK_595_patient_status_transitions_retomada.sql

INSERT INTO patient_status_transitions (from_status, to_status) VALUES
  ('ON_HOLD',    'REPLACEMENT'),
  ('SUSPENDED',  'SEARCHING'),
  ('SUSPENDED',  'REPLACEMENT'),
  ('DISCHARGED', 'SEARCHING'),
  ('DISCHARGED', 'REPLACEMENT')
ON CONFLICT (from_status, to_status) DO NOTHING;
