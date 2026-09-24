-- ============================================================
-- Migration 460: case_ordinal — a enésima vaga de um caso (patient_id)
--
-- Spec 027 (Fase 5) — número do caso. Hoje o título da vaga é
-- "CASO {case_number}-{vacancy_number}", mas vacancy_number é GLOBAL (uma
-- SEQUENCE compartilhada por TODAS as vagas do sistema, migration 114) — não
-- diz nada sobre a posição da vaga DENTRO do caso do paciente. case_ordinal
-- é essa posição: 1 = primeira vaga já criada para aquele patient_id, 2 = a
-- segunda, etc.
--
-- Por que UNIQUE (e não COUNT(*)+1 sem constraint): dois cliques simultâneos
-- no mesmo caso (2 requests concorrentes de "criar vaga" para o mesmo
-- paciente) têm de falhar por CONSTRAINT do banco, não por corrida entre
-- leitura e escrita no código — um COUNT(*)+1 sem índice único deixaria as
-- duas requests calcularem o mesmo próximo número e gravarem duplicado.
-- A aplicação (VacancyCrudController.createVacancy, ActivateRecruitmentUseCase,
-- createWithPatientUpdate — spec 027 T052) trata a violação (23505) com retry.
--
-- Por que NÃO reaproveita índice existente:
--   idx_job_postings_patient_id (migration 037) é um índice NÃO-único, só
--   para busca por paciente — não impede duplicata de ordinal.
--   idx_job_postings_unique_slot (migration 142) é sobre
--   (patient_id, service_address_formatted, schedule) — guard-rail de vaga
--   duplicada por endereço+horário, assunto totalmente diferente.
-- ============================================================

BEGIN;

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS case_ordinal INTEGER;

COMMENT ON COLUMN job_postings.case_ordinal IS
  'Posição ordinal da vaga dentro do caso (patient_id) — a enésima vaga já '
  'criada para aquele paciente, contando inclusive vagas soft-deletadas (a '
  'numeração nunca é reciclada). Calculado por subquery dentro do próprio '
  'INSERT (buildInsertQuery, spec 027 Fase 5) — NULL quando patient_id é '
  'NULL. Ver idx_job_postings_case_ordinal para a garantia de unicidade.';

-- Backfill: numera as vagas existentes por caso, na ordem em que nasceram
-- (created_at; vacancy_number como desempate para timestamps iguais).
-- Idempotente — só toca linhas com case_ordinal ainda NULL, então rodar de
-- novo não altera nada.
UPDATE job_postings
SET case_ordinal = sub.ordinal
FROM (
  SELECT id,
         row_number() OVER (
           PARTITION BY patient_id
           ORDER BY created_at, vacancy_number
         ) AS ordinal
  FROM job_postings
  WHERE patient_id IS NOT NULL
) sub
WHERE job_postings.id = sub.id
  AND job_postings.patient_id IS NOT NULL
  AND job_postings.case_ordinal IS NULL;

-- Guard-rail: impede duas vagas VIVAS do mesmo caso com o mesmo ordinal.
-- Filtro deleted_at IS NULL de propósito — soft-delete libera aquele ordinal
-- para reaproveitamento pela constraint (embora a aplicação, ao numerar via
-- MAX(case_ordinal) sobre TODAS as linhas do paciente, não vá de fato
-- reciclar em uso normal).
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_postings_case_ordinal
  ON job_postings (patient_id, case_ordinal)
  WHERE patient_id IS NOT NULL
    AND case_ordinal IS NOT NULL
    AND deleted_at IS NULL;

COMMENT ON INDEX idx_job_postings_case_ordinal IS
  'Guard-rail: impede duas vagas vivas do mesmo caso (patient_id) com o '
  'mesmo case_ordinal — cliques simultâneos em "criar vaga" para o mesmo '
  'paciente colidem aqui, e o caller retenta (spec 027 Fase 5, T052).';

COMMIT;
