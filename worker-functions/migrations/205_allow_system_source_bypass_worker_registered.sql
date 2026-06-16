-- Migration 205: permite source='system' (auto-invite) bypassar enforce_worker_registered
--
-- BUG (descoberto na repair do TD-051 / suite auto-invite): MatchmakingService.saveMatchResults
-- insere WJAs de auto-invite com source='system' e stage='INVITED'. A query de candidatos
-- inclui workers INCOMPLETE_REGISTER quando includeIncompleteRegister=true — justamente para
-- CONVIDÁ-LOS a completar o cadastro (existe o template ar_vacancy_match_incomplete).
-- Mas o trigger 183 bloqueia INSERT de worker não-REGISTERED, e 'system' não estava no bypass.
-- Resultado: o batch inteiro de auto-invite falha quando inclui 1 worker incompleto (o loop
-- não tem catch por linha) — convites silenciosamente não saem em produção.
--
-- FIX: adicionar 'system' ao bypass, pela MESMA razão que 'talentum' já bypassa (convite
-- externo/automático a worker que ainda não completou cadastro na Enlite). 'system' é usado
-- EXCLUSIVAMENTE por MatchmakingService (auto-invite), sempre stage='INVITED' — verificado por
-- grep em src/. Não afeta postulação 'manual' nem self-service de link público (regra estrita).
--
-- Numeração: 205 (e não 203) para não colidir com as migrations 203/204 da feature de
-- contact-notes em paralelo. O runner aplica por nome de arquivo (idempotente via
-- schema_migrations), então a aplicação fora de ordem é segura — esta migration é independente.

CREATE OR REPLACE FUNCTION enforce_worker_registered_for_application()
RETURNS TRIGGER AS $$
DECLARE
  worker_status TEXT;
BEGIN
  -- Backfill histórico (planilla_operativa, import), funil externo Talentum e
  -- auto-invite do sistema (source='system', sempre stage INVITED) não bloqueiam:
  -- são convites/reconciliações onde o worker ainda pode estar incompleto.
  IF NEW.source IN ('planilla_operativa', 'import', 'talentum', 'system') THEN
    RETURN NEW;
  END IF;

  SELECT status INTO worker_status
  FROM workers
  WHERE id = NEW.worker_id;

  IF worker_status IS NULL THEN
    RAISE EXCEPTION 'worker not found: %', NEW.worker_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF worker_status <> 'REGISTERED' THEN
    RAISE EXCEPTION 'worker % cannot apply: status=% (must be REGISTERED). registration or documents incomplete.', NEW.worker_id, worker_status
      USING ERRCODE = 'check_violation',
            HINT = 'Worker precisa completar cadastro e enviar todos os documentos antes de postular.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION enforce_worker_registered_for_application() IS
  'Bloqueia worker_job_applications quando workers.status != REGISTERED. Bypass: planilla_operativa, import (backfill), talentum e system (auto-invite — convidam worker possivelmente incompleto). manual e self-service seguem regra estrita.';
