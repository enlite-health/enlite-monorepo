-- ROLLBACK_595_patient_status_transitions_retomada.sql — par de rollback da migration 595 (estado-automatico-do-paciente, F3).
--
-- QUANDO USAR: regressão detectada depois do deploy das ações "Retomar"/"Reativar" — decisão de reverter antes de um fix mais específico.
--
-- Por que mora em `migrations/pending/`, sem número: o runner (`scripts/run-migrations-docker.js`) lista `migrations/` SEM recursão e
-- aplica tudo `.sql` em ordem numérica; `pending/` é o único lugar que ele ignora (ver `migrations/pending/README.md`). Só roda quando
-- alguém aponta o caminho explicitamente.
--
-- ATENÇÃO — só removemos as setas que a 595 CRIOU. `SUSPENDED → SEARCHING` e `SUSPENDED → REPLACEMENT` são da 486 (saída de Suspendido
-- com motivo) e FICAM: o rollback da 486 é quem as tira.
--
-- Trava de dado: se a trilha já registra paciente movido por uma das 3 setas removidas, apagá-la deixaria esse paciente num estado que o
-- catálogo não explica — recusa (contagem no PR, OK do Gabriel antes). Idempotente: rodar 2× não erra.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_595_patient_status_transitions_retomada.sql

DO $$
BEGIN
  IF to_regclass('patient_status_history') IS NOT NULL THEN
    IF (SELECT count(*) FROM patient_status_history
         WHERE (old_value, new_value) IN (('ON_HOLD','REPLACEMENT'),('DISCHARGED','SEARCHING'),('DISCHARGED','REPLACEMENT'))) > 0 THEN
      RAISE EXCEPTION 'há paciente movido por uma das transições da 595 — o rollback deixaria o histórico sem transição no catálogo (contagem no PR, OK do Gabriel antes)';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('patient_status_transitions') IS NOT NULL THEN
    DELETE FROM patient_status_transitions
     WHERE (from_status, to_status) IN (
       ('ON_HOLD',    'REPLACEMENT'),
       ('DISCHARGED', 'SEARCHING'),
       ('DISCHARGED', 'REPLACEMENT')
     );
  END IF;
END $$;
