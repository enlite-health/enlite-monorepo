-- 563 — spec 084 F6 (R12, R16): o #NN da vaga é a ORDEM DO SERVIÇO dentro do paciente
--
-- Antes (migration 460): case_ordinal = MAX(case_ordinal do paciente) + 1 na criação da vaga, contando vagas
-- apagadas. Depois: case_ordinal = posição do SERVIÇO contratado entre os serviços do paciente (por created_at, id),
-- 1..N; vaga SEM serviço fica SEM número (NULL); vaga nova de um serviço repete o número do serviço (R12).
-- Nenhum título, link ou projeto do Talentum muda: eles usam case_number/vacancy_number, não case_ordinal.
--
-- ── O índice único idx_job_postings_case_ordinal (patient_id, case_ordinal) ──────────────────────────────────
-- Cai durante a renumeração (o UPDATE passa por estados intermediários que o violariam) e é RECRIADO ao fim, com o
-- mesmo nome e predicado da 460. Continua valendo: o número agora é a posição do SERVIÇO e a migration 530 admite UMA
-- vaga viva por serviço, então duas vagas vivas do mesmo paciente com o mesmo número são impossíveis. R12 (a vaga nova
-- de um serviço repete o número) acontece quando a anterior foi APAGADA (fora do índice). Vaga sem serviço = NULL.
--
-- ── Vagas vivas existentes ───────────────────────────────────────────────────────────────────────────────────
-- Medido em prd (03/11): das 344 vagas vivas com paciente, as 156 COM paciente e SEM serviço PERDEM o número (viram
-- NULL; as outras 16 sem serviço não têm paciente e já eram NULL) e as 188 com serviço ganham a posição do seu serviço
-- (47 mudam de rótulo, 36 tinham número maior que a quantidade de serviços). A contagem final é re-medida em prd antes
-- do merge.
--
-- ── Rollback ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Antes do UPDATE, `(id, case_ordinal)` de TODA vaga viva com número vai para `job_postings_case_ordinal_before_563`
-- (criada só na 1ª execução: reexecutar NÃO sobrescreve o retrato). Para desfazer:
--   UPDATE job_postings jp SET case_ordinal = b.case_ordinal FROM job_postings_case_ordinal_before_563 b WHERE b.id = jp.id;
--   (e DROP INDEX idx_job_postings_case_ordinal + recriar com o mesmo nome, se a renumeração tiver deixado duplicata).
--
-- Ordem importa: o índice único é derrubado ANTES do UPDATE (a renumeração passa por estados intermediários que o violariam). Vagas apagadas não são tocadas (história; fora do índice).
--
-- Roda como enlite_app (dono): DROP INDEX / CREATE INDEX / UPDATE na própria tabela. Idempotente (reexecutar
-- recalcula o mesmo valor).

DROP INDEX IF EXISTS idx_job_postings_case_ordinal;

CREATE TABLE IF NOT EXISTS job_postings_case_ordinal_before_563 AS
  SELECT id, case_ordinal FROM job_postings WHERE deleted_at IS NULL AND case_ordinal IS NOT NULL;
COMMENT ON TABLE job_postings_case_ordinal_before_563 IS
  'Spec 084 (migration 563): retrato de (id, case_ordinal) das vagas vivas ANTES da renumeração — só para rollback. Pode ser apagada depois da estabilização.';

UPDATE job_postings jp
   SET case_ordinal = NULL
 WHERE jp.deleted_at IS NULL
   AND jp.contracted_service_id IS NULL
   AND jp.case_ordinal IS NOT NULL;

UPDATE job_postings jp
   SET case_ordinal = s.ordinal
  FROM (
    SELECT id, row_number() OVER (PARTITION BY patient_id ORDER BY created_at, id)::int AS ordinal
      FROM patient_contracted_services
  ) s
 WHERE jp.contracted_service_id = s.id
   AND jp.deleted_at IS NULL
   AND jp.case_ordinal IS DISTINCT FROM s.ordinal;

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_postings_case_ordinal
  ON job_postings (patient_id, case_ordinal)
  WHERE patient_id IS NOT NULL AND case_ordinal IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN job_postings.case_ordinal IS
  'Spec 084 (R12/R16): ordem do SERVIÇO contratado dentro do paciente (1..N). NULL para vaga sem serviço. Vaga nova de um serviço repete o número do serviço. Derivado na criação (buildInsertQuery) e no vínculo, nunca MAX+1. Índice único (paciente, número) entre vagas vivas.';

DO $$ BEGIN RAISE NOTICE 'Migration 563: case_ordinal passa a ser a ordem do serviço; índice único recriado depois da renumeração'; END $$;
