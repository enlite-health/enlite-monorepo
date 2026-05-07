-- Migration 161: rollback do rename feito pela migration 160
--
-- Contexto:
--   A migration 160 renomeou worker_locations -> worker_locations_deprecated_20260506
--   pensando em deprecar a tabela apos o codigo parar de usa-la. Decisao operacional
--   posterior foi reverter o codigo (Cloud Run -> revisao anterior). O codigo antigo
--   ainda le/escreve em worker_locations (MatchmakingService, VacancyMatchController,
--   EncuadreFunnelController, AdminWorkersDetailBuilder, WorkerLocationRepository).
--
-- Esta migration:
--   1. Renomeia worker_locations_deprecated_20260506 de volta para worker_locations
--   2. Mantem as colunas adicionadas pela 158 em worker_service_areas (aditivas, compativeis)
--   3. Mantem o backfill da 159 em worker_service_areas (apenas dados, sem schema)
--
-- Apos esta migration:
--   - Banco volta a ter worker_locations (nome esperado pelo codigo legacy)
--   - worker_service_areas continua com work_zone/interest_zone/data_source preenchidos
--   - Possivel reaplicar a 160 (com novo numero) quando o codigo for de fato migrado
--     e validado em producao

ALTER TABLE worker_locations_deprecated_20260506 RENAME TO worker_locations;

COMMENT ON TABLE worker_locations IS NULL;
