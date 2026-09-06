-- 315 — `patient_status_transitions`: as transições PERMITIDAS, em tabela (spec 012, US-B7)
--
-- `PUT /api/admin/patients/:id/status` consulta esta tabela e recusa (422, código
-- PATIENT_STATUS_TRANSITION_NOT_ALLOWED) o que não estiver aqui. Tabela e não constante em
-- TypeScript pela mesma razão do catálogo (307): mudar a regra é dado de operação, não deploy.
--
-- Seed = `plan.md` da spec 012 (⚠️ SUP: lista PROVISÓRIA — Marcel confirma):
--   ACTIVE      → ON_HOLD, REPLACEMENT, SUSPENDED, DISCHARGED
--   ON_HOLD     → ACTIVE, SEARCHING, DISCHARGED
--   SEARCHING   → ACTIVE, ON_HOLD, DISCHARGED
--   REPLACEMENT → ACTIVE, SEARCHING, SUSPENDED, DISCHARGED
--   SUSPENDED   → ACTIVE, DISCHARGED
--   DISCHARGED  → ACTIVE  (resgate, `#REGRA-07`)
-- + a saída do funil de admissão (SOLICITANTE/ADMISSION/PENDING_ADMISSION → ACTIVE), que é o
--   que o Kanban ("Activo") e o botão Activar já fazem hoje — sem estas três linhas, o `PUT`
--   passaria a recusar o movimento que a tela permite desde a Fase 2.
-- Movimentos DENTRO do funil (SOLICITANTE ↔ ADMISSION ↔ PENDING_ADMISSION) NÃO passam por aqui:
-- são do Kanban, livres como sempre foram (ver PatientService.moveStatus).
--
-- Rollback: `DROP TABLE patient_status_transitions;` — sem dado de paciente.

CREATE TABLE IF NOT EXISTS patient_status_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  CONSTRAINT patient_status_transitions_pkey PRIMARY KEY (from_status, to_status),
  CONSTRAINT patient_status_transitions_not_self CHECK (from_status <> to_status)
);

INSERT INTO patient_status_transitions (from_status, to_status) VALUES
  ('ACTIVE',      'ON_HOLD'),
  ('ACTIVE',      'REPLACEMENT'),
  ('ACTIVE',      'SUSPENDED'),
  ('ACTIVE',      'DISCHARGED'),
  ('ON_HOLD',     'ACTIVE'),
  ('ON_HOLD',     'SEARCHING'),
  ('ON_HOLD',     'DISCHARGED'),
  ('SEARCHING',   'ACTIVE'),
  ('SEARCHING',   'ON_HOLD'),
  ('SEARCHING',   'DISCHARGED'),
  ('REPLACEMENT', 'ACTIVE'),
  ('REPLACEMENT', 'SEARCHING'),
  ('REPLACEMENT', 'SUSPENDED'),
  ('REPLACEMENT', 'DISCHARGED'),
  ('SUSPENDED',   'ACTIVE'),
  ('SUSPENDED',   'DISCHARGED'),
  ('DISCHARGED',  'ACTIVE'),
  -- saída do funil de admissão (o que Kanban/Activar já fazem)
  ('SOLICITANTE',       'ACTIVE'),
  ('ADMISSION',         'ACTIVE'),
  ('PENDING_ADMISSION', 'ACTIVE')
ON CONFLICT (from_status, to_status) DO NOTHING;

COMMENT ON TABLE patient_status_transitions IS
  'Transições permitidas de patients.status (v2, migration 314). Consultada por '
  'PatientService.moveStatus; ausência = 422. Seed do plan.md da spec 012 (provisório — Marcel '
  'confirma). Catálogo sem dado pessoal.';
