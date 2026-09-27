-- ROLLBACK_480_patient_itinerary.sql — par de rollback da migration 480
-- (duas tabelas do itinerário: patient_itinerary_slot, patient_itinerary_assignment; DX-7.1).
--
-- QUANDO USAR: regressão detectada depois do deploy da 480 — decisão de reverter a estrutura do
-- itinerário antes de um fix mais específico ficar pronto.
--
-- Por que mora em `migrations/pending/`, sem número: `scripts/run-migrations-docker.js` lista
-- `migrations/` com `fs.readdirSync` SEM recursão e aplica tudo `.sql` em ordem numérica — um
-- `481_rollback_*.sql` seria aplicado automaticamente na PRÓXIMA corrida do runner (e2e, boot do
-- Cloud Run, ou `run-migration-prod.sh` batendo em `migrations/` inteira), desfazendo a 480 sem
-- ninguém ter pedido. `migrations/pending/` é o único lugar que o runner ignora (ver
-- `migrations/pending/README.md`) — o arquivo fica escrito, revisado e versionado, mas só roda
-- quando alguém aponta o caminho explicitamente.
--
-- Trava de dado: se já existe QUALQUER alocação, o rollback apagaria quem cuida de quem — recusa.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_480_patient_itinerary.sql

DO $$
BEGIN
  IF (SELECT count(*) FROM patient_itinerary_assignment) > 0 THEN
    RAISE EXCEPTION 'há alocação — o rollback apagaria quem cuida de quem';
  END IF;
END $$;

DROP TABLE IF EXISTS patient_itinerary_assignment;
DROP TABLE IF EXISTS patient_itinerary_slot;
DROP FUNCTION IF EXISTS fn_patient_itinerary_assignment_candidacy();
DROP FUNCTION IF EXISTS fn_patient_itinerary_assignment_country_from_slot();
DROP FUNCTION IF EXISTS fn_patient_itinerary_slot_country_from_service();
