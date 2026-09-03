-- 317 — `patients.service_start_date` (spec 012, US-B9; US5 da 001)
--
-- "Fecha de inicio del servicio" NÃO existe em nenhuma das 3 listas do ClickUp (contrato 001:
-- há Inicio Búsqueda, Fecha de Cierre, Fecha de Baja, Fecha Suspensión — nenhuma é esta), então
-- nasce como campo NATIVO do painel, editado no drawer geral. Não é derivada da vaga: abrir vaga
-- não a altera (teste no e2e).
--
-- lex B9 (AUTORIZADO, condição única): NÃO acrescentar à lista positiva do `enlite_mcp_ro`.
-- Coluna nova em `patients` nasce invisível (a lista é positiva) — basta não a listar.
--
-- Rollback: `ALTER TABLE patients DROP COLUMN service_start_date;`

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS service_start_date DATE NULL;

COMMENT ON COLUMN patients.service_start_date IS
  'Data de início do serviço, informada pelo painel (drawer geral). Não deriva da vaga. '
  'Fora do enlite_mcp_ro (lex B9). Migration 317, spec 012 US-B9.';
