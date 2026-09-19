-- 446 — `ana_care_patient_document` (change `identidade-do-worker-e-recusa-honesta` /
-- pendência da conferência de horas Ana Care, decisão do Gabriel 19/09/2026).
--
-- Por quê: a tela de conferência de horas do Ana Care (módulo `anacare-hours`) mostra o
-- documento do paciente quando a FONTE (Ana Care) manda (`SourceShiftDTO.patientDocumentType`/
-- `patientDocumentNumber`, ver `AnaCareHoursMapper`/`AnaCareHoursService`) — mas nem todo
-- paciente do Ana Care tem documento cadastrado LÁ. Sem essa tabela, o operador tem que digitar
-- o DNI de novo a cada tela aberta para o mesmo paciente. Esta tabela guarda o documento QUE O
-- OPERADOR informou manualmente, para servir de FALLBACK quando a fonte não tem.
--
-- Chave é `ana_care_patient_id` (o ID do paciente NO ANA CARE), NÃO `patients.id` — SEM foreign
-- key: não existe vínculo hoje entre os pacientes da tela de conferência de horas e os nossos
-- (`patients.ana_care_id` é NULL nos 388 de prd, `patient_identity_links` tem 0 linhas — mesma
-- premissa já registrada em `migrations/445_axonico_comprobante_lancamento.sql`). Uma FK aqui
-- travaria todo insert real.
--
-- `registered_by` — uid do ator que informou o documento. Molde: a MAIORIA das tabelas do repo
-- guarda o autor como `VARCHAR(128) NOT NULL` SEM foreign key para `users` (ex.: `created_by` em
-- `migrations/422_patient_external_contacts.sql:29`, `migrations/416_patient_therapeutic_projects.sql:62`
-- — 22 ocorrências medidas de `_by VARCHAR(128) NOT NULL` sem REFERENCES; a única FK viva para
-- `users(firebase_uid)` no repo é `validated_by` em `migrations/437_anacare_shift_hours.sql:102`,
-- e é NULLABLE porque o registro nasce sem validação). Segue-se o padrão MAIORITÁRIO aqui: sem FK.
--
-- Nunca sobrescreve com número diferente (ação HONESTA como `create`, não `update`): o use case
-- (F-próxima, fora desta migration) decide 200 idempotente (mesmo número já normalizado) ou 409
-- (número diferente do já registrado) — esta migration só garante a UNICIDADE no banco via
-- UNIQUE (ana_care_patient_id); a decisão 200×409 lê antes de gravar, nunca depende de
-- ON CONFLICT.
--
-- Mesmo molde de 439/441/442/443/445: `country` texto com default, GRANT explícito por tabela
-- (sem ALTER DEFAULT PRIVILEGES), PK `BIGSERIAL`, created_at/updated_at TIMESTAMPTZ DEFAULT NOW().

BEGIN;

CREATE TABLE IF NOT EXISTS ana_care_patient_document (
  id                    BIGSERIAL    PRIMARY KEY,
  ana_care_patient_id   TEXT         NOT NULL,
  document_number       TEXT         NOT NULL,
  document_type         TEXT,
  registered_by         VARCHAR(128) NOT NULL,
  country               TEXT         NOT NULL DEFAULT 'AR',
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Dedupe/chave de leitura: no máximo um documento registrado por paciente do Ana Care.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ana_care_patient_document_patient
  ON ana_care_patient_document (ana_care_patient_id);

COMMENT ON TABLE ana_care_patient_document IS
  'Documento (DNI) de paciente do Ana Care informado manualmente pelo operador, para servir de '
  'FALLBACK na tela de conferência de horas quando a fonte (Ana Care) não manda documento. Chave '
  'é ana_care_patient_id (ID do paciente NO ANA CARE), SEM foreign key para patients — não existe '
  'vínculo hoje (patients.ana_care_id é NULL nos 388 de prd, ver migration 445). UNIQUE por '
  'ana_care_patient_id: nunca sobrescreve com número diferente (ação create honesta, não update) '
  '— o use case decide 200 idempotente ou 409 antes de gravar.';

COMMENT ON COLUMN ana_care_patient_document.ana_care_patient_id IS
  'ID do paciente NO ANA CARE (não é patients.id nosso) — a mesma chave que a tela de conferência '
  'de horas usa para agrupar turnos por paciente (AnaCareHoursMapper.groupIntoPatients).';

COMMENT ON COLUMN ana_care_patient_document.document_number IS
  'DNI já normalizado pelo chamador (mesma porta domain/documentNumber.ts do módulo integration, '
  'normalizeAndValidateDocumentNumber) — esta tabela não normaliza, o use case garante.';

COMMENT ON COLUMN ana_care_patient_document.registered_by IS
  'uid do staff que registrou o documento — molde VARCHAR(128) NOT NULL sem FK para users, mesmo '
  'padrão majoritário do repo (ex.: created_by em migrations/422_patient_external_contacts.sql).';

COMMENT ON INDEX uq_ana_care_patient_document_patient IS
  'No máximo um documento registrado por ana_care_patient_id — garante no banco que o registro '
  'nunca sobrescreve silenciosamente um número diferente; o use case lê antes de decidir 200×409.';

-- GRANT explícito por tabela (convenção do repo — sem ALTER DEFAULT PRIVILEGES, molde 439/441/442/443/445).
GRANT SELECT, INSERT, UPDATE ON ana_care_patient_document TO app_runtime, app_system;
GRANT USAGE, SELECT ON SEQUENCE ana_care_patient_document_id_seq TO app_runtime, app_system;

COMMIT;
