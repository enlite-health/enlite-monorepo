-- Migration 229: permite que merge/undo de dedup bypasse enforce_worker_registered
--
-- BUG (achado nos logs de prod, erro 23514 em AdminDedupController:executeMerge):
-- O Centro de Duplicados, ao unificar contas, reaponta worker_job_applications do
-- absorvido pro principal via `UPDATE worker_job_applications SET worker_id = <principal>`
-- (WorkerPhoneMergeReparent, estratégia upsert_delete). Esse UPDATE dispara o trigger
-- trg_enforce_worker_registered (mig 183/196/205), que revalida o status do NOVO dono.
-- Como a maioria dos workers em prod é INCOMPLETE_REGISTER, qualquer unificação cujo
-- principal não esteja REGISTERED e cujo absorvido tenha postulação 'manual'/self-service
-- levanta check_violation e faz ROLLBACK da transação inteira → operador vê "Erro interno".
-- O caminho de UNDO sofre do mesmo problema: reinsere as WJAs no absorvido (BEFORE INSERT),
-- e como o absorvido também costuma estar incompleto, a transação de undo aborta.
--
-- FIX: reparent de merge/undo NÃO é uma postulação nova — é consolidação de dado já
-- existente, que já passou (ou bypassou) o guard quando foi criada. O trigger passa a
-- retornar cedo quando a transação seta o GUC de sessão `app.bypass_registered_guard='on'`.
-- O WorkerPhoneMergeService (executeSingleMerge) e o WorkerMergeUndoService (undoMergeTx)
-- emitem `SET LOCAL app.bypass_registered_guard = 'on'` logo após o BEGIN — escopo restrito
-- à própria transação (auto-reset no COMMIT/ROLLBACK). Nenhum outro caminho seta o GUC, então
-- postulação real (manual/self-service) continua sob regra estrita.
--
-- Aditiva: só substitui o corpo da função (CREATE OR REPLACE). O trigger continua apontando
-- pra mesma função; não é recriado.

CREATE OR REPLACE FUNCTION enforce_worker_registered_for_application()
RETURNS TRIGGER AS $$
DECLARE
  worker_status TEXT;
BEGIN
  -- Merge/undo de dedup seta este GUC por transação (SET LOCAL): reparent de WJA
  -- não é postulação nova, é consolidação de dado existente — não revalidar o guard.
  IF current_setting('app.bypass_registered_guard', true) = 'on' THEN
    RETURN NEW;
  END IF;

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
  'Bloqueia worker_job_applications quando workers.status != REGISTERED. Bypass: GUC app.bypass_registered_guard=on (merge/undo de dedup), planilla_operativa, import (backfill), talentum e system (auto-invite). manual e self-service seguem regra estrita.';
