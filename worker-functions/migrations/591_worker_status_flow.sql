-- Migration 591: workers.status só muda com FLUXO DECLARADO + worker_status_history.flow (spec 093, DF-3..DF-7, DF-11)
--
-- A PARTIR DESTA MIGRATION, todo UPDATE que MUDA workers.status — inclusive migration futura de dado e script manual —
-- precisa, na MESMA transação e ANTES do UPDATE:
--     SELECT set_config('app.status_flow', '<FLOW>', true);      -- true = vale só nesta transação
-- Sem isso o trigger trg_worker_status_require_flow recusa o UPDATE (controle, não instrução: escritor por fora quebra
-- alto no CI/e2e em vez de mudar status em silêncio). Valores para quem não é código de aplicação:
--     MIGRATION       migration de dado (set_config no topo do arquivo)
--     MANUAL_SCRIPT   scripts em scripts/
--     TEST_FIXTURE    testes/seeds (também deixa rastro no history)
-- Os outros 15 valores são os escritores da aplicação (WorkerStatusTransitions). Lista fechada no CHECK abaixo; dono da
-- lista = este CHECK (teste compara pg_get_constraintdef × enum TS WorkerStatusFlow).
--
-- O que muda:
--   1. worker_status_history.flow VARCHAR(64) NULL + CHECK da lista. NULL = linha anterior à 093 (nada é reescrito).
--   2. fn_log_worker_status_change(): corpo vigente (096) + flow = NULLIF(current_setting('app.status_flow', true), '').
--      `changed_by` continua vindo de app.current_uid. `change_source` NÃO é tocada (DF-7: é a fonte do ator, não o fluxo).
--   3. fn_worker_status_require_flow() + trg_worker_status_require_flow BEFORE UPDATE OF status, só quando o status muda.
--
-- NULLIF(..., ''): após COMMIT/ROLLBACK o GUC transacional fica '' (não NULL) na sessão — '' conta como "não declarado".
-- A mensagem do RAISE não carrega id, telefone ou qualquer dado do titular (PI-4).
-- Privilégios: nada de GRANT/REVOKE. As duas funções são de gatilho, SEM SECURITY DEFINER (rodam como o invoker; o
-- INSERT em worker_status_history já é concedido a app_runtime/app_system pela 269 e cobre a coluna nova) e EXECUTE é
-- PUBLIC por padrão. Nenhum REVOKE no próprio dono (migration-roda-como-enlite-app).
-- Idempotente (2x): ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT/TRIGGER IF EXISTS + CREATE, CREATE OR REPLACE.
-- Sem BEGIN/COMMIT próprio (o runner envolve).
--
-- Rollback: `migrations/pending/ROLLBACK_591_worker_status_flow.sql` (remove trigger, função e coluna; devolve o corpo da 096).

-- ── 1. Coluna + CHECK ────────────────────────────────────────────────────────
ALTER TABLE worker_status_history ADD COLUMN IF NOT EXISTS flow VARCHAR(64);

ALTER TABLE worker_status_history DROP CONSTRAINT IF EXISTS worker_status_history_flow_check;
ALTER TABLE worker_status_history
  ADD CONSTRAINT worker_status_history_flow_check CHECK (flow IS NULL OR flow IN (
    'WIZARD_PERSONAL_INFO',
    'WIZARD_AVAILABILITY',
    'WIZARD_SERVICE_AREA',
    'WIZARD_STEP',
    'WORKER_DOCUMENT_UPLOAD',
    'ADMIN_DOCUMENT_REVIEW',
    'PROFILE_FIELDS_EDIT',
    'ADMIN_STATUS_CHANGE',
    'WORKER_IMPORT',
    'PHONE_MERGE',
    'CLAIM_SHELL_ABSORB',
    'ADMIN_MERGE',
    'MERGE_UNDO',
    'ARCHIVE_REACTIVATION',
    'ACCOUNT_DEACTIVATION',
    'MIGRATION',
    'MANUAL_SCRIPT',
    'TEST_FIXTURE'
  ));

COMMENT ON COLUMN worker_status_history.flow IS 'NULL = linha anterior à 093; linha nova de status nunca é NULL (garantido por trg_worker_status_require_flow)';

-- ── 2. O log passa a gravar o fluxo ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_log_worker_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO worker_status_history (worker_id, field_name, old_value, new_value, changed_by, flow)
    VALUES (NEW.id, 'status', OLD.status, NEW.status,
            current_setting('app.current_uid', true),
            NULLIF(current_setting('app.status_flow', true), ''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 3. Trava: status só muda com fluxo declarado ─────────────────────────────
CREATE OR REPLACE FUNCTION fn_worker_status_require_flow()
RETURNS TRIGGER AS $$
BEGIN
  IF NULLIF(current_setting('app.status_flow', true), '') IS NULL THEN
    RAISE EXCEPTION 'workers.status sem fluxo declarado — use WorkerStatusTransitions'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_worker_status_require_flow ON workers;
CREATE TRIGGER trg_worker_status_require_flow
  BEFORE UPDATE OF status ON workers
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION fn_worker_status_require_flow();
