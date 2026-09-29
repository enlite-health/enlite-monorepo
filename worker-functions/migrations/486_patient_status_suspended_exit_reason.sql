-- 486 — SUSPENDED ganha saída com motivo (decisão do Gabriel 29/09/2026):
--   a. 3 transições que faltavam no catálogo para o paciente Suspendido poder ir para
--      Búsqueda/Reemplazo/En espera (ACTIVE/ALTA/DISCHARGED já saíam de SUSPENDED desde 315/473).
--   b. `patient_status_history` ganha `reason` (motivo fechado, CHECK — SuspensionExitReason,
--      domain/enums) e `actor_uid` (quem mudou, decisão do Gabriel 29/09/2026 — D444): substitui
--      o "sem quem" da 254/C7.2, grava e exibe o firebase uid (só o ID, nunca nome) na Historial —
--      aviso M1-1 aos colaboradores segue pendente (dono Gabriel/Marcel); cláusula (c) da política
--      de staff access vale (proibido usar a trilha para avaliação de
--      desempenho/disciplina/dimensionamento). Os dois NULL por padrão: histórico anterior
--      e mudança de SISTEMA (derivação, VacancyLaunchHook) continuam sem ator; motivo só é gravado
--      ao SAIR de SUSPENDED manualmente (PatientStatusWriter valida antes do UPDATE).
--   c. Os dois triggers da 254/255 passam a ler `app.status_reason` e `app.actor_uid` (mesmo
--      molde de `app.change_source`, já lido por eles) e gravar via NULLIF(…, '') — string vazia
--      (GUC não setado nesta transação) vira NULL, do mesmo jeito que a ausência do GUC já virava
--      NULL antes de existir change_source. Nenhum outro campo do corpo das duas funções muda.
-- Idempotente: INSERT...ON CONFLICT DO NOTHING, ADD COLUMN IF NOT EXISTS, DROP+ADD CONSTRAINT,
-- CREATE OR REPLACE FUNCTION. Reaplicar não muda nada.
-- Rollback: migrations/pending/ROLLBACK_486_patient_status_suspended_exit_reason.sql

BEGIN;

-- ── a. catálogo de transições (patient_status_transitions, migration 315) ──────────────────────
INSERT INTO patient_status_transitions (from_status, to_status) VALUES
  ('SUSPENDED', 'SEARCHING'),
  ('SUSPENDED', 'REPLACEMENT'),
  ('SUSPENDED', 'ON_HOLD')
ON CONFLICT (from_status, to_status) DO NOTHING;

-- ── b. colunas novas em patient_status_history (migration 254) ─────────────────────────────────
ALTER TABLE patient_status_history
  ADD COLUMN IF NOT EXISTS reason VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS actor_uid VARCHAR(128) NULL;

ALTER TABLE patient_status_history DROP CONSTRAINT IF EXISTS patient_status_history_reason_check;
ALTER TABLE patient_status_history
  ADD CONSTRAINT patient_status_history_reason_check
  CHECK (reason IS NULL OR reason IN (
    'RESUMED_SERVICE', 'FAMILY_REQUESTED', 'NEEDS_NEW_WORKER', 'WRONG_STATUS', 'OTHER'
  ));

COMMENT ON COLUMN patient_status_history.reason IS
  'Motivo de SAÍDA de SUSPENDED (SuspensionExitReason, domain/enums) — catálogo fechado, sem '
  'texto livre (texto clínico não entra na trilha). NULL em toda mudança que não seja sair de '
  'SUSPENDED manualmente (admin_panel/kanban). Migration 486.';
COMMENT ON COLUMN patient_status_history.actor_uid IS
  'Firebase uid de quem mudou o status via HTTP (decisão do Gabriel 29/09/2026 — D444): substitui '
  'o "sem quem" de C7.2, migration 254; grava e EXIBE o uid (só o ID, nunca nome) na Historial — '
  'aviso M1-1 aos colaboradores segue pendente (dono Gabriel/Marcel); cláusula (c) da política de '
  'staff access vale (proibido usar a trilha para avaliação de desempenho/disciplina/dimensionamento). '
  'NULL para mudança de SISTEMA (derivação por horas, VacancyLaunchHook). Nunca logado (Cloud '
  'Logging) — só viaja por set_config na transação. Migration 486.';

-- ── c. triggers (254 AFTER UPDATE OF status, 255 AFTER INSERT) ─────────────────────────────────
CREATE OR REPLACE FUNCTION fn_log_patient_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IS NOT NULL THEN
    INSERT INTO patient_status_history (patient_id, old_value, new_value, change_source, reason, actor_uid)
    VALUES (NEW.id, OLD.status, NEW.status,
            current_setting('app.change_source', true),
            NULLIF(current_setting('app.status_reason', true), ''),
            NULLIF(current_setting('app.actor_uid', true), ''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_log_patient_status_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IS NOT NULL THEN
    INSERT INTO patient_status_history (patient_id, old_value, new_value, change_source, created_at, reason, actor_uid)
    VALUES (NEW.id, NULL, NEW.status, 'insert', NOW(),
            NULLIF(current_setting('app.status_reason', true), ''),
            NULLIF(current_setting('app.actor_uid', true), ''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
