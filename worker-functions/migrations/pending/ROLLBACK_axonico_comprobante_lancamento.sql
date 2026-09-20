-- ROLLBACK_axonico_comprobante_lancamento.sql — par de rollback da migration 445
-- (axonico_comprobante_lancamento, change `integracao-axonico`, F2).
--
-- Por que mora em `migrations/pending/`, sem número: `scripts/run-migrations-docker.js` lista
-- `migrations/` com `fs.readdirSync` SEM recursão e aplica tudo `.sql` em ordem numérica — um
-- `446_rollback_*.sql` seria aplicado automaticamente logo depois da 445, na PRÓXIMA corrida do
-- runner (e2e, boot do Cloud Run, ou `run-migration-prod.sh` batendo em `migrations/` inteira),
-- derrubando a tabela que acabou de nascer. `migrations/pending/` é o único lugar que o runner
-- ignora (ver `migrations/pending/README.md`) — o arquivo fica escrito, revisado e versionado, mas
-- só roda quando alguém aponta o caminho explicitamente.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_axonico_comprobante_lancamento.sql

BEGIN;

DROP TABLE IF EXISTS axonico_comprobante_lancamento;

COMMIT;
