-- Migration 583: pagador de teste fora das listas do catálogo (spec 077, D669 DP-15; D664, D665)
--
-- `insurance_providers.is_test` marca o pagador (obra social/prepaga) que existe só para teste em prd (massa QA077).
-- Mesmo nome e forma de `workers.is_test` (224), `job_postings.is_test` (248) e `patients.is_test` (257).
--
-- Dono único: esta coluna. Contrato (`insurance_contracts`) e vínculo serviço->contrato (`contracted_service_contract`)
-- NÃO ganham coluna: o realm deles deriva do pagador pela FK `insurance_contracts.provider_code` (D516).
-- Quem lê: `excludeTestPayerSql` (`src/shared/database/testRealmSql.ts`, D665), só nas LISTAS do catálogo (select do
-- drawer de cobertura, página de obras sociais, cascata do serviço). Item concreto (detalhe por código, pagador do
-- serviço, cobertura do paciente) e unicidade (nome, sort_order) leem a tabela inteira.
--
-- NOT NULL DEFAULT false: sem NULL (false = pagador real; true = pagador de teste). Default constante: sem reescrita da
-- tabela (PG 11+). Nenhuma linha existente muda: todas nascem false.
-- Idempotente (2x): ADD COLUMN IF NOT EXISTS. Sem BEGIN/COMMIT próprio.
--
-- Rollback: `migrations/pending/ROLLBACK_583_insurance_providers_is_test.sql`.

ALTER TABLE insurance_providers
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN insurance_providers.is_test IS 'Pagador de teste (massa QA077 em prd, spec 077 D669). false = pagador real. Fora das listas do catálogo por excludeTestPayerSql (testRealmSql.ts); contrato e vínculo derivam daqui.';
