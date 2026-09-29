-- ROLLBACK_485_patient_status_transitions_derivacao.sql — par de rollback da migration 485
-- (as 2 transições da derivação por horas, SEARCHING → REPLACEMENT e ACTIVE → SEARCHING; D430,
-- cadeia Fase 15).
--
-- QUANDO USAR: regressão detectada depois do deploy da 485 — decisão de reverter a derivação
-- do estado do paciente antes de um fix mais específico ficar pronto (desligar a derivação por
-- ENLITE_DERIVACAO_ESTADO=off vem ANTES: sem ela, estas 2 linhas não são usadas por ninguém).
--
-- Por que mora em `migrations/pending/`, sem número: `scripts/run-migrations-docker.js` lista
-- `migrations/` com `fs.readdirSync` SEM recursão e aplica tudo `.sql` em ordem numérica — um
-- `486_rollback_*.sql` seria aplicado automaticamente na PRÓXIMA corrida do runner (e2e, boot do
-- Cloud Run, ou `run-migration-prod.sh` batendo em `migrations/` inteira), desfazendo a 485 sem
-- ninguém ter pedido. `migrations/pending/` é o único lugar que o runner ignora (ver
-- `migrations/pending/README.md`) — o arquivo fica escrito, revisado e versionado, mas só roda
-- quando alguém aponta o caminho explicitamente.
--
-- Trava de dado: se o histórico já registra paciente movido por um dos 2 pares, apagar a
-- transição deixaria esse paciente num estado que o catálogo não explica — recusa (contagem no
-- PR, OK do Gabriel antes). Idempotente: rodar 2× não erra (o DELETE da 2ª não acha linha).
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_485_patient_status_transitions_derivacao.sql

DO $$
BEGIN
  IF to_regclass('patient_status_history') IS NOT NULL THEN
    IF (SELECT count(*) FROM patient_status_history
         WHERE (old_value, new_value) IN (('SEARCHING','REPLACEMENT'),('ACTIVE','SEARCHING'))) > 0 THEN
      RAISE EXCEPTION 'há paciente movido por uma das transições da 485 — o rollback deixaria o histórico sem transição no catálogo (contagem no PR, OK do Gabriel antes)';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('patient_status_transitions') IS NOT NULL THEN
    DELETE FROM patient_status_transitions
     WHERE (from_status, to_status) IN (
       ('SEARCHING', 'REPLACEMENT'),
       ('ACTIVE',    'SEARCHING')
     );
  END IF;
END $$;
