-- ROLLBACK_518_enquadre_events.sql — par de rollback da migration 518 (spec 052, Fase 2).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. PERDE todos os eventos e participações já gravados
-- (os resultados dos prestadores ficam: moram em application_funnel_stage). Antes: SELECT count(*) FROM enquadre_events;
-- Derrubar a tabela leva junto índices, CHECKs e o trigger; a função é derrubada à parte. A filha cai primeiro (FK composta).
BEGIN;
DROP TABLE IF EXISTS enquadre_event_participants;
DROP TABLE IF EXISTS enquadre_events;
DROP FUNCTION IF EXISTS fn_enquadre_events_country_from_posting();
COMMIT;
