-- ROLLBACK_486_patient_status_suspended_exit_reason.sql — par de rollback da migration 486
-- (3 transições de saída de SUSPENDED + colunas `reason`/`actor_uid` em patient_status_history +
-- os 2 triggers da 254/255 lendo `app.status_reason`/`app.actor_uid`; decisão do Gabriel 29/09/2026).
--
-- QUANDO USAR: regressão detectada depois do deploy da 486 — por exemplo, decisão de reverter a
-- exigência de motivo de saída antes de um fix mais específico ficar pronto.
--
-- Por que mora em `migrations/pending/`, sem número: `scripts/run-migrations-docker.js` lista
-- `migrations/` com `fs.readdirSync` SEM recursão e aplica tudo `.sql` em ordem numérica — um
-- `487_rollback_*.sql` seria aplicado automaticamente na PRÓXIMA corrida do runner (e2e, boot do
-- Cloud Run, ou `run-migration-prod.sh` batendo em `migrations/` inteira), desfazendo a 486 sem
-- ninguém ter pedido. `migrations/pending/` é o único lugar que o runner ignora (ver
-- `migrations/pending/README.md`) — o arquivo fica escrito, revisado e versionado, mas só roda
-- quando alguém aponta o caminho explicitamente.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_486_patient_status_suspended_exit_reason.sql
--
-- TRAVA: se já existe linha de histórico com `reason` ou `actor_uid` preenchido, dropar as colunas
-- perde dado — recusa (contagem no PR, OK do Gabriel antes). As 3 linhas de transição só saem se
-- nenhum paciente foi movido por elas (mesmo molde da ROLLBACK_485).

DO $$
BEGIN
  IF to_regclass('patient_status_history') IS NOT NULL THEN
    IF (SELECT count(*) FROM patient_status_history WHERE reason IS NOT NULL OR actor_uid IS NOT NULL) > 0 THEN
      RAISE EXCEPTION 'há linha de patient_status_history com reason/actor_uid preenchido — dropar as colunas perde dado (contagem no PR, OK do Gabriel antes)';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('patient_status_history') IS NOT NULL THEN
    IF (SELECT count(*) FROM patient_status_history
         WHERE (old_value, new_value) IN (('SUSPENDED','SEARCHING'),('SUSPENDED','REPLACEMENT'),('SUSPENDED','ON_HOLD'))) > 0 THEN
      RAISE EXCEPTION 'há paciente movido por uma das 3 transições da 486 — o rollback deixaria o histórico sem transição no catálogo (contagem no PR, OK do Gabriel antes)';
    END IF;
  END IF;
END $$;

-- Triggers voltam ao corpo exato da 254/255 (sem reason/actor_uid).
CREATE OR REPLACE FUNCTION fn_log_patient_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IS NOT NULL THEN
    INSERT INTO patient_status_history (patient_id, old_value, new_value, change_source)
    VALUES (NEW.id, OLD.status, NEW.status,
            current_setting('app.change_source', true));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_log_patient_status_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IS NOT NULL THEN
    INSERT INTO patient_status_history (patient_id, old_value, new_value, change_source, created_at)
    VALUES (NEW.id, NULL, NEW.status, 'insert', NOW());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass('patient_status_transitions') IS NOT NULL THEN
    DELETE FROM patient_status_transitions
     WHERE (from_status, to_status) IN (
       ('SUSPENDED', 'SEARCHING'),
       ('SUSPENDED', 'REPLACEMENT'),
       ('SUSPENDED', 'ON_HOLD')
     );
  END IF;
END $$;

ALTER TABLE patient_status_history DROP CONSTRAINT IF EXISTS patient_status_history_reason_check;
ALTER TABLE patient_status_history DROP COLUMN IF EXISTS reason;
ALTER TABLE patient_status_history DROP COLUMN IF EXISTS actor_uid;
