-- ROLLBACK_479_patient_status_transitions_launch_to_searching.sql — par de rollback da migration 479
-- (as 3 transições funil → SEARCHING usáveis só por changeSource = 'vacancy_launch', invariante 7, D434).
--
-- QUANDO USAR: regressão detectada depois do deploy da 479 em prd — por exemplo, decisão de
-- reverter o gancho do lançamento (DX-6.1/DX-6.3/DX-6.4) antes de outro fix mais específico ficar pronto.
--
-- Por que mora em `migrations/pending/`, sem número: `scripts/run-migrations-docker.js` lista
-- `migrations/` com `fs.readdirSync` SEM recursão e aplica tudo `.sql` em ordem numérica — um
-- `480_rollback_*.sql` seria aplicado automaticamente na PRÓXIMA corrida do runner (e2e, boot do
-- Cloud Run, ou `run-migration-prod.sh` batendo em `migrations/` inteira), desfazendo a 479 sem
-- ninguém ter pedido. `migrations/pending/` é o único lugar que o runner ignora (ver
-- `migrations/pending/README.md`) — o arquivo fica escrito, revisado e versionado, mas só roda
-- quando alguém aponta o caminho explicitamente.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_479_patient_status_transitions_launch_to_searching.sql

DELETE FROM patient_status_transitions
 WHERE (from_status, to_status) IN (
   ('SOLICITANTE',       'SEARCHING'),
   ('ADMISSION',         'SEARCHING'),
   ('PENDING_ADMISSION', 'SEARCHING')
 );
