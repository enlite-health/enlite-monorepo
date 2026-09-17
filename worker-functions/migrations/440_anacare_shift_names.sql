-- 440 — Nome e sobrenome de paciente/prestador no retrato de turnos do Ana Care.
--
-- Decisão do Gabriel (17/09): a tela de conferência de horas mostrava `Sin vínculo · ID X` para os
-- dois lados porque o nome nunca era carregado — "o nome vem junto na requisição do Ana Care e é
-- de lá que você precisa pegar". A migration 437 (comentário original) dizia "SEM
-- patient_name_cache/nurse_name_cache no retrato — nome só via vínculo, nunca duplicado aqui"; esta
-- migration REVOGA essa parte da 437 por decisão explícita e nomeada do Gabriel (17/09, ver
-- `docs/diario`), não por reinterpretação.
--
-- Estas quatro colunas são RÓTULO DE EXIBIÇÃO do retrato — cópia transitória do que o Ana Care
-- manda no payload do turno (`SourceShiftDTO.patientFirstName/patientLastName/nurseFirstName/
-- nurseLastName`, minimizados na borda por `AnaCareFieldMinimization`). NÃO são o registro de
-- identidade do paciente/prestador (esse mora em `patients`/`workers`) — a retenção do retrato é
-- CURTA (reescrito a cada sync), então não é um lugar de guarda de identidade duradoura. Nome vai
-- para a TELA (regra dura CLAUDE.md: não é texto clínico, não é log de PII).
--
-- `NULL` é estado legítimo: um turno pode vir da fonte sem nome (medido: nem todo turno amostrado
-- tinha os quatro campos preenchidos). Round-trip fiel: nome que entra no upsert é nome que sai na
-- leitura (`AnaCareShiftRepository.listByMonth`).
--
-- Rollback:
--   ALTER TABLE anacare_shift DROP COLUMN IF EXISTS patient_first_name;
--   ALTER TABLE anacare_shift DROP COLUMN IF EXISTS patient_last_name;
--   ALTER TABLE anacare_shift DROP COLUMN IF EXISTS nurse_first_name;
--   ALTER TABLE anacare_shift DROP COLUMN IF EXISTS nurse_last_name;

BEGIN;

ALTER TABLE anacare_shift ADD COLUMN IF NOT EXISTS patient_first_name TEXT NULL;
ALTER TABLE anacare_shift ADD COLUMN IF NOT EXISTS patient_last_name  TEXT NULL;
ALTER TABLE anacare_shift ADD COLUMN IF NOT EXISTS nurse_first_name   TEXT NULL;
ALTER TABLE anacare_shift ADD COLUMN IF NOT EXISTS nurse_last_name    TEXT NULL;

COMMENT ON COLUMN anacare_shift.patient_first_name IS
  'Rótulo de exibição do retrato — nome do paciente COMO O PRÓPRIO PAYLOAD DO TURNO manda (Ana '
  'Care), não cruzamento com `patients`. Cópia transitória (retenção curta do retrato); o registro '
  'de identidade do paciente mora em `patients`. NULL = fonte não mandou nome para este turno.';

COMMENT ON COLUMN anacare_shift.patient_last_name IS
  'Sobrenome do paciente, mesma origem/natureza de `patient_first_name` (payload do turno).';

COMMENT ON COLUMN anacare_shift.nurse_first_name IS
  'Rótulo de exibição do retrato — nome do prestador COMO O PRÓPRIO PAYLOAD DO TURNO manda (Ana '
  'Care), não cruzamento com `workers`. Cópia transitória (retenção curta do retrato); o registro '
  'de identidade do prestador mora em `workers`. NULL = fonte não mandou nome para este turno. A '
  'exibição continua condicionada à célula `worker_contact:read` (gate inalterado, ver '
  'AnaCareHoursService).';

COMMENT ON COLUMN anacare_shift.nurse_last_name IS
  'Sobrenome do prestador, mesma origem/natureza de `nurse_first_name` (payload do turno).';

COMMIT;
