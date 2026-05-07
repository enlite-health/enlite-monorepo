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

-- Idempotente: em prod a 160 nunca foi aplicada, entao worker_locations ja
-- esta no nome correto e a tabela _deprecated_20260506 nao existe. Em dev
-- (onde 160 rodou) a deprecated existe e precisamos renomear de volta.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'worker_locations_deprecated_20260506'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'worker_locations'
  ) THEN
    EXECUTE 'ALTER TABLE worker_locations_deprecated_20260506 RENAME TO worker_locations';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'worker_locations'
  ) THEN
    EXECUTE 'COMMENT ON TABLE worker_locations IS NULL';
  END IF;
END $$;
