-- ROLLBACK_490_service_team_contact_log.sql — par de rollback da migration 490
-- (quadro C — encuadre: registro de contato com o prestador, modal do Figma rodada 2).
--
-- QUANDO USAR: regressão detectada depois do deploy da 490 — decisão de reverter a estrutura do
-- histórico de contato antes de um fix mais específico ficar pronto.
--
-- Mora em `migrations/pending/` pelo mesmo motivo da ROLLBACK_481 (`run-migrations-docker.js` só
-- aplica `migrations/*.sql`, nunca a subpasta — o arquivo só roda quando alguém aponta o caminho
-- explicitamente).
--
-- Trava de dado: se já existe QUALQUER registro de contato, o rollback apagaria o histórico —
-- recusa.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_490_service_team_contact_log.sql

DO $$
BEGIN
  IF to_regclass('service_team_contact_log') IS NOT NULL THEN
    IF (SELECT count(*) FROM service_team_contact_log) > 0 THEN
      RAISE EXCEPTION 'há registro de contato — o rollback apagaria o histórico (OK do Gabriel antes)';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS service_team_contact_log;
DROP FUNCTION IF EXISTS fn_stcl_country_from_service();
