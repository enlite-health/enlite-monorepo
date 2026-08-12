-- Migration 185: funnel_stage_precedence(text) RETURNS int
--
-- Função imutável que mapeia application_funnel_stage para um inteiro de precedência.
-- Permite comparar stages em CASE de precedência sem duplicar a lógica inline.
-- Usada por:
--   - TalentumPrescreeningRepository.upsertWorkerJobApplicationFromTalentum
--   - SyncTalentumWorkersUseCase.linkToCases (INSERT ... ON CONFLICT DO UPDATE)
--   - EncuadreRepository.syncToWorkerJobApplications

CREATE OR REPLACE FUNCTION funnel_stage_precedence(stage text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE stage
    WHEN 'INVITED'       THEN 0
    WHEN 'INITIATED'     THEN 1
    WHEN 'IN_PROGRESS'   THEN 2
    WHEN 'COMPLETED'     THEN 3
    WHEN 'ANALYZED'      THEN 4
    WHEN 'IN_DOUBT'      THEN 4
    WHEN 'QUALIFIED'     THEN 5
    WHEN 'NOT_QUALIFIED' THEN 5
    WHEN 'REPROGRAM'     THEN 5
    WHEN 'CONFIRMED'     THEN 6
    WHEN 'SELECTED'      THEN 7
    WHEN 'PLACED'        THEN 7
    WHEN 'REJECTED'      THEN 7
    WHEN 'RECHAZADO'     THEN 7
    ELSE -1
  END;
$$;

COMMENT ON FUNCTION funnel_stage_precedence(text) IS
  'Returns precedence integer for application_funnel_stage values. '
  'Higher = more advanced in the funnel. Unknown stages return -1. '
  'IMMUTABLE — safe to use in index expressions and CASE conditions.';
