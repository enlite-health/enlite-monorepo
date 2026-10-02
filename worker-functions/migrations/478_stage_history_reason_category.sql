-- 478 — `reason_category` na trilha `worker_job_application_stage_history` + o
-- gatilho que a grava (cadeia-paciente-vacante-itinerario, Fase 4; D434, invariante 11).
--
-- Coluna ADITIVA, NULL por padrão: linhas antigas ficam NULL, nenhuma reescrita —
-- só o INSERT feito pelo gatilho a partir de agora carrega o valor (quando houver).
--
-- Por que NULLIF(current_setting('app.move_reason', true), '') e não só
-- current_setting(...): depois que um GUC customizado (`app.move_reason`) foi setado
-- UMA vez numa conexão, `current_setting(nome, true)` devolve `''` (string vazia, não
-- NULL) nas transações SEGUINTES da MESMA conexão do pool — é o comportamento
-- documentado do Postgres para `set_config(is_local=true)` fora de uma transação que
-- o setou. Sem o NULLIF, toda escrita automática POSTERIOR (que nunca seta
-- app.move_reason) bateria `''` no CHECK abaixo e abortaria a automação inteira.
--
-- Sem mudança de GRANT: a trilha já é só SELECT+INSERT para app_runtime/app_system
-- (REVOKE UPDATE, DELETE, TRUNCATE em 269_app_runtime_roles.sql:84-93, citado também
-- em 476:8-9) — a coluna nova nasce sob o mesmo grant, sem UPDATE possível.
--
-- O gatilho trg_application_stage_history (169:56-59) NÃO é recriado — só a função
-- fn_log_application_stage_change() muda (CREATE OR REPLACE), o DROP/CREATE TRIGGER
-- de 169 continua valendo como está.
--
-- Down (rollback, fase-4.md §Rollback — só contagem por categoria vai no PR, nunca os
-- motivos individuais, que se perdem no rollback):
--   SELECT reason_category, count(*) FROM worker_job_application_stage_history GROUP BY 1;
--   -- função de volta à versão da migration 169 (sem reason_category nos INSERT)
--   ALTER TABLE worker_job_application_stage_history DROP COLUMN reason_category;

ALTER TABLE worker_job_application_stage_history
  ADD COLUMN IF NOT EXISTS reason_category VARCHAR(40) NULL;

ALTER TABLE worker_job_application_stage_history
  DROP CONSTRAINT IF EXISTS wjash_reason_category_check;
ALTER TABLE worker_job_application_stage_history
  ADD CONSTRAINT wjash_reason_category_check CHECK (
    reason_category IS NULL OR reason_category IN (
      -- salto de etapa (DX-4.4, WF/domain/moveReason.ts JUMP)
      'ENCUADRE_ANTECIPADO','REAPROVEITADO_DE_OUTRA_VAGA','INDICACAO_DA_EQUIPE',
      -- entrar em Rejeitados = a mesma lista de encuadres.rejection_reason_category
      -- (Encuadre.ts:16-26, migrations 094:19 + 117:15-16)
      'DISTANCE','SCHEDULE_INCOMPATIBLE','INSUFFICIENT_EXPERIENCE','SALARY_EXPECTATION','WORKER_DECLINED',
      'OVERQUALIFIED','DEPENDENCY_MISMATCH','TALENTUM_NOT_QUALIFIED',
      -- sair de Rejeitados (DX-4.4, LEAVE_REJECTED)
      'REAVALIACAO','REJEITADO_POR_ENGANO',
      -- comum às três listas
      'OTHER'
    )
  );

CREATE OR REPLACE FUNCTION fn_log_application_stage_change() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO worker_job_application_stage_history
      (application_id, field_name, old_value, new_value, changed_by, reason_category)
    VALUES (NEW.id, 'application_funnel_stage', NULL, NEW.application_funnel_stage,
            current_setting('app.current_uid', true),
            NULLIF(current_setting('app.move_reason', true), ''));
    RETURN NEW;
  END IF;

  IF OLD.application_funnel_stage IS DISTINCT FROM NEW.application_funnel_stage THEN
    INSERT INTO worker_job_application_stage_history
      (application_id, field_name, old_value, new_value, changed_by, reason_category)
    VALUES (NEW.id, 'application_funnel_stage', OLD.application_funnel_stage, NEW.application_funnel_stage,
            current_setting('app.current_uid', true),
            NULLIF(current_setting('app.move_reason', true), ''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  RAISE NOTICE 'Migration 478 done: reason_category adicionada à trilha + gatilho gravando com NULLIF (Fase 4).';
END $$;
