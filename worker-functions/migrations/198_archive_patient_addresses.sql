-- Migration 198: versionamento de endereço do paciente — coluna archived_at
--
-- Motivação: hoje quando o webhook ClickUp atualiza um endereço de paciente,
-- o sync faz UPDATE in-place na row de patient_addresses. Resultado: TODAS as
-- vagas que apontam pra essa row passam a refletir o conteúdo novo
-- silenciosamente. Isso quebra a expectativa operacional de que
-- "vaga publicada preserva o endereço escolhido pelo operador no momento da
-- criação" — um prestador agendado pra ir em "Av A, Villa Ballester" não pode
-- ter o anúncio mudado de baixo dele para "Av B, CABA".
--
-- Solução: versionar endereços. Quando o ClickUp atualiza o `address_formatted`
-- e existem vagas ativas apontando para a row antiga, o sync:
--   1. Marca a row antiga como `archived_at = NOW()`.
--   2. Insere uma nova row em `patient_addresses` com o mesmo `display_order`
--      e os campos novos.
-- Resultado:
--   - Vagas antigas continuam apontando pra row antiga (preservada como
--     histórico imutável).
--   - Form de criação de vaga lista só `archived_at IS NULL` — operador escolhe
--     o endereço atual.
--   - Listagem do paciente também filtra `archived_at IS NULL`.
--
-- Detalhes em: docs/features/vacancy-creation/06-endereco-servico.md
--             docs/features/vacancy-creation/10-bug-historico-endereco-antigo.md

BEGIN;

ALTER TABLE patient_addresses
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN patient_addresses.archived_at IS
  'Quando preenchido: este endereço foi versionado — uma nova row em patient_addresses substituiu este endereço pra novas vagas. Vagas existentes que ainda apontam pra esta row preservam o histórico. NULL = endereço ativo.';

-- Index parcial pra acelerar lookups dos endereços ativos do paciente
-- (form de criação de vaga, sync ClickUp). Não estamos colocando UNIQUE em
-- (patient_id, display_order) porque historicamente já havia colisões — o sync
-- precisa lidar com a normalização gradualmente.
CREATE INDEX IF NOT EXISTS idx_patient_addresses_active
  ON patient_addresses (patient_id, display_order)
  WHERE archived_at IS NULL;

COMMIT;
