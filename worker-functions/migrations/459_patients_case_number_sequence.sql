-- ============================================================
-- Migration 459: SEQUENCE nativa para patients.case_number
--
-- Spec 027 (US1) — paciente nascido no app passa a receber case_number
-- automaticamente, sem depender do ClickUp.
--
-- Motivo do START WITH 1000:
--   O legado do ClickUp numerou os casos de 110 a 828 (campo "Caso Número"
--   do ClickUp, importado por PatientService.upsertFromClickUp) — essa faixa
--   está CONGELADA, o ClickUp deixou de numerar em 23/09/2026 (decisão do
--   Gabriel, plataforma é a fonte da verdade do paciente desde 11/09/2026).
--   A partir de 1000 o número é NATIVO: gerado por esta SEQUENCE, nunca mais
--   pelo ClickUp. A folga entre 828 e 1000 é de propósito — margem para que
--   nenhum número nativo colida com um legado ainda não visto por esta
--   migration (o maior case_number legado medido é 828; 1000 dá folga).
--
-- NÃO adiciona DEFAULT nextval(...) na coluna e NÃO torna a coluna NOT NULL:
--   43 pacientes existem hoje com case_number NULL, e o backfill deles é
--   outra task. Quem preenche o valor é o código de aplicação
--   (PatientIdentityRepository.nextCaseNumber, spec 027 T011), não o schema.
-- ============================================================

BEGIN;

CREATE SEQUENCE IF NOT EXISTS patients_case_number_seq
  START WITH 1000
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

ALTER SEQUENCE patients_case_number_seq OWNED BY patients.case_number;

COMMENT ON SEQUENCE patients_case_number_seq IS
  'case_number nativo (spec 027). O legado do ClickUp ocupa 110..828 e está '
  'congelado — o ClickUp deixou de numerar casos em 23/09/2026. A partir de '
  '1000 o número é gerado por esta SEQUENCE (nextval, nunca DEFAULT — a '
  'coluna continua sem DEFAULT e sem NOT NULL de propósito, ver migration).';

COMMIT;
