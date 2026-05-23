-- Migration 183: Enforce worker REGISTERED status as precondition to postular
--
-- Regra de negócio (CLAUDE.md): worker só pode postular a uma vacante se
-- cadastro + documentos estão completos. A coluna workers.status é o
-- checkpoint canônico, mantida via WorkerImportRepository.recalculateStatus():
--   - REGISTERED          → cadastro + 5 docs base + área serviço + disponibilidade
--   - INCOMPLETE_REGISTER → faltando dado obrigatório
--   - DISABLED            → worker desativado
--
-- Trigger BEFORE INSERT OR UPDATE em worker_job_applications: dispara exceção
-- com mensagem clara se workers.status != 'REGISTERED'.
--
-- Bypass: backfill histórico (source IN 'planilla_operativa', 'import') NÃO é
-- bloqueado — é reconciliação de operação offline antiga, não postulação ativa.
-- Talentum (source='talentum') também bypassa: é funil EXTERNO — o worker ainda
-- não completou cadastro na Enlite quando se candidata pelo Talentum.
-- O webhook do Talentum pode criar workers auto com INCOMPLETE_REGISTER; bloquear
-- aqui destruiria o fluxo de triagem inteiro.
-- Track-channel (source='manual') e admin (source='manual') seguem a regra estrita.

CREATE OR REPLACE FUNCTION enforce_worker_registered_for_application()
RETURNS TRIGGER AS $$
DECLARE
  worker_status TEXT;
BEGIN
  -- Backfill histórico de planilha e funil externo Talentum não bloqueiam
  IF NEW.source IN ('planilla_operativa', 'import', 'talentum') THEN
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

DROP TRIGGER IF EXISTS trg_enforce_worker_registered ON worker_job_applications;

CREATE TRIGGER trg_enforce_worker_registered
  BEFORE INSERT OR UPDATE OF worker_id, job_posting_id, application_funnel_stage, application_status
  ON worker_job_applications
  FOR EACH ROW
  EXECUTE FUNCTION enforce_worker_registered_for_application();

COMMENT ON FUNCTION enforce_worker_registered_for_application() IS
  'Bloqueia worker_job_applications quando workers.status != REGISTERED. Garante que worker tem cadastro e documentos completos antes de postular. Backfill histórico (planilla_operativa, import) bypassa.';
