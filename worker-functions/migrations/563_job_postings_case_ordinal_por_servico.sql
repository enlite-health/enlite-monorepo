-- 563 — spec 084 F6 (R12, R16): o #NN da vaga é a ORDEM DO SERVIÇO dentro do paciente
--
-- Antes (migration 460): case_ordinal = MAX(case_ordinal do paciente) + 1 na criação da vaga, contando vagas
-- apagadas. Depois: case_ordinal = posição do SERVIÇO contratado entre os serviços do paciente (por created_at, id),
-- 1..N; vaga SEM serviço fica SEM número (NULL); vaga nova de um serviço repete o número do serviço (R12).
-- Nenhum título, link ou projeto do Talentum muda: eles usam case_number/vacancy_number, não case_ordinal.
--
-- ── O índice único idx_job_postings_case_ordinal (patient_id, case_ordinal) ──────────────────────────────────
-- Cai. R12 exige que duas vagas VIVAS do mesmo serviço (a baixada/encerrada e a nova) repitam o mesmo número, o que
-- esse índice proibiria. A garantia de que dois serviços não dividem número agora é derivação pura (a posição do
-- serviço), não corrida entre INSERTs — então o índice único perde o motivo de existir. Fica um índice comum para a
-- busca por (paciente, número) usada em EnquadreEventListRepository.
--
-- ── Vagas vivas existentes ───────────────────────────────────────────────────────────────────────────────────
-- Medido em prd (03/11): das 344 vagas vivas com paciente, as 172 sem serviço PERDEM o número (viram NULL) e as 188
-- com serviço ganham a posição do seu serviço (47 mudam de rótulo, 36 tinham número maior que a quantidade de
-- serviços). Ordem importa: o índice único é derrubado ANTES do UPDATE (a renumeração passa por estados
-- intermediários que o violariam). Vagas apagadas não são tocadas (história; fora do índice).
--
-- Roda como enlite_app (dono): DROP INDEX / CREATE INDEX / UPDATE na própria tabela. Idempotente (reexecutar
-- recalcula o mesmo valor).

DROP INDEX IF EXISTS idx_job_postings_case_ordinal;

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

CREATE INDEX IF NOT EXISTS idx_job_postings_patient_case_ordinal
  ON job_postings (patient_id, case_ordinal)
  WHERE patient_id IS NOT NULL AND case_ordinal IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN job_postings.case_ordinal IS
  'Spec 084 (R12/R16): ordem do SERVIÇO contratado dentro do paciente (1..N). NULL para vaga sem serviço. Vaga nova de um serviço repete o número do serviço. Derivado na criação (buildInsertQuery), nunca MAX+1.';

DO $$ BEGIN RAISE NOTICE 'Migration 563: case_ordinal passa a ser a ordem do serviço; índice único trocado por comum'; END $$;
