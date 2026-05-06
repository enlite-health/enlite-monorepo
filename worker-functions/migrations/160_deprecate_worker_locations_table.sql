-- Migration 160: deprecate legacy worker_locations table
--
-- Após migrations 158/159 consolidarem dados em worker_service_areas e o código
-- (MatchmakingService, VacancyMatchController, EncuadreFunnelController,
-- AdminWorkersDetailBuilder, WorkerLocationRepository) deixar de ler/escrever
-- nessa tabela, renomeamos para sinalizar deprecação.
--
-- Padrão do repo: renomear para _deprecated_YYYYMMDD antes do drop final.
-- Drop real fica para uma migration futura, depois de >=1 release em produção
-- sem regressão observada.
--
-- Confirmação antes do drop final:
--   - Testes E2E completos passando (pnpm test:e2e)
--   - grep -rn "worker_locations\b" worker-functions/src/ → 0 hits

ALTER TABLE worker_locations RENAME TO worker_locations_deprecated_20260506;

COMMENT ON TABLE worker_locations_deprecated_20260506 IS
  'DEPRECATED 2026-05-06 — dados consolidados em worker_service_areas via migration 159. '
  'Drop em release futura (>=1 release sem regressão).';
