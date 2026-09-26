-- 477 — `QUICK_RESPONSE_TEAM` no CHECK de application_funnel_stage + precedência
-- (cadeia-paciente-vacante-itinerario, Fase 4; D430, invariantes 5/11).
--
-- Nome distinto de `RAPID_RESPONSE` por ordem da fase (as duas premissas caídas no
-- Passo 0, fase-4.md:26): `RAPID_RESPONSE` já é `job_postings.status` (vaga em busca
-- de reposição rápida) e `encuadres.role` (papel do worker no encuadre) — dois
-- conceitos existentes. `QUICK_RESPONSE_TEAM` é a etapa NOVA do funil da candidatura
-- (destino do arrasto manual do quadro B, D430); reusar o mesmo literal juntaria dois
-- conceitos hoje distintos.
--
-- Molde: migration 264_remove_initiated_stage_phase2.sql (CHECK :57-74, asserção de
-- 1 constraint :104-116, função de precedência :119-133).
--
-- Por que a precedência recebe 7 (mesmo slot de SELECTED/REJECTED), e não -1 como o
-- ELSE de hoje (DX-4.2, execucao/fase-4.md:73-79): funnel_stage_precedence() é a
-- guarda "etapa nunca regride" usada por dois upserts automáticos —
-- TalentumPrescreeningRepository.ts:157-158 e EncuadreRepository.ts:229-230 — que só
-- sobrescrevem a etapa quando precedence(nova) >= precedence(atual). Com -1, QUALQUER
-- webhook da Talentum ou reescrita de encuadre tiraria em silêncio a pessoa da Equipe
-- de Resposta Rápida — o estágio nasceria inseguro contra uma automação escrevendo
-- sobre um estágio que a D430 reserva ao arrasto do operador.
--
-- Down (rollback, fase-4.md §Rollback — só depois de exportar a contagem para o PR):
--   SELECT count(*) FROM worker_job_applications WHERE application_funnel_stage='QUICK_RESPONSE_TEAM';
--   UPDATE worker_job_applications SET application_funnel_stage='SELECTED'
--     WHERE application_funnel_stage='QUICK_RESPONSE_TEAM';
--   -- CHECK de volta às 9 etapas (sem QUICK_RESPONSE_TEAM)
--   -- funnel_stage_precedence() de volta à versão da 264 (sem a linha QUICK_RESPONSE_TEAM)

ALTER TABLE worker_job_applications
  DROP CONSTRAINT IF EXISTS worker_job_applications_application_funnel_stage_check;
ALTER TABLE worker_job_applications
  ADD CONSTRAINT worker_job_applications_application_funnel_stage_check
  CHECK (application_funnel_stage IN (
    'INVITED','PRE_SCREENING','IN_PROGRESS','COMPLETED','QUALIFIED','IN_DOUBT',
    'CONFIRMED','SELECTED','QUICK_RESPONSE_TEAM','REJECTED'));

-- Molde: 264:104-116 — garante que sobrou exatamente 1 constraint de funnel_stage.
DO $$
DECLARE constraint_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO constraint_count
  FROM information_schema.table_constraints
  WHERE table_name = 'worker_job_applications'
    AND constraint_name LIKE '%funnel_stage%';
  IF constraint_count != 1 THEN
    RAISE EXCEPTION 'Migration 477: esperava 1 constraint de funnel_stage, encontrou %. Inspecionar pg_constraint.', constraint_count;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION funnel_stage_precedence(stage text)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE stage
    WHEN 'INVITED'             THEN 0
    WHEN 'PRE_SCREENING'       THEN 1
    WHEN 'IN_PROGRESS'         THEN 2
    WHEN 'COMPLETED'           THEN 3
    WHEN 'IN_DOUBT'            THEN 4
    WHEN 'QUALIFIED'           THEN 5
    WHEN 'CONFIRMED'           THEN 6
    WHEN 'SELECTED'            THEN 7
    WHEN 'QUICK_RESPONSE_TEAM' THEN 7
    WHEN 'REJECTED'            THEN 7
    ELSE -1
  END;
$$;

COMMENT ON FUNCTION funnel_stage_precedence(text) IS
  'Precedência canônica do funil de candidaturas. '
  'Migration 477 (2026-09-26, Fase 4): QUICK_RESPONSE_TEAM no slot 7 (= SELECTED/REJECTED) — '
  'guarda "etapa não regride" contra automações da Talentum/Encuadre reescreverem por cima '
  'do arrasto manual do operador (DX-4.2). '
  'Migration 264 (2026-07-04): INITIATED removido definitivamente (Fase-2). '
  'Migration 230 (2026-06-26): PRE_SCREENING adicionado no slot 1 (substitui INITIATED). '
  'F7.b (migration 195): REPROGRAM removido. '
  'F7.a (migration 194): PLACED removido (0 linhas em prod). '
  'F3 (migration 191): NOT_QUALIFIED removido (auto-rejeição). '
  'F2 (migration 190): RECHAZADO removido (canonical=REJECTED). '
  'ANALYZED nunca esteve no CHECK de WJA — transporte interno do mapper Talentum.';

DO $$ BEGIN
  RAISE NOTICE 'Migration 477 done: QUICK_RESPONSE_TEAM adicionado ao CHECK + funnel_stage_precedence no slot 7 (Fase 4).';
END $$;
