-- ROLLBACK_481_contracted_service_rejections.sql — par de rollback da migration 481
-- (quadro C — encuadre por serviço: contracted_service_rejections; DX-10.2).
--
-- QUANDO USAR: regressão detectada depois do deploy da 481 — decisão de reverter a estrutura do
-- log de rejeição por serviço antes de um fix mais específico ficar pronto.
--
-- Por que mora em `migrations/pending/`, sem número: `scripts/run-migrations-docker.js` lista
-- `migrations/` com `fs.readdirSync` SEM recursão e aplica tudo `.sql` em ordem numérica — um
-- `482_rollback_*.sql` seria aplicado automaticamente na PRÓXIMA corrida do runner (e2e, boot do
-- Cloud Run, ou `run-migration-prod.sh` batendo em `migrations/` inteira), desfazendo a 481 sem
-- ninguém ter pedido. `migrations/pending/` é o único lugar que o runner ignora (ver
-- `migrations/pending/README.md`) — o arquivo fica escrito, revisado e versionado, mas só roda
-- quando alguém aponta o caminho explicitamente.
--
-- Trava de dado: se já existe QUALQUER marca de rejeição, o rollback apagaria o log de encuadre —
-- recusa.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_481_contracted_service_rejections.sql

DO $$
BEGIN
  IF to_regclass('contracted_service_rejections') IS NOT NULL THEN
    IF (SELECT count(*) FROM contracted_service_rejections) > 0 THEN
      RAISE EXCEPTION 'há marca de rejeição — o rollback apagaria o log de encuadre (OK do Gabriel antes)';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS contracted_service_rejections;
DROP FUNCTION IF EXISTS fn_csr_country_from_service();
