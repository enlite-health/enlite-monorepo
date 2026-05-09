-- Migration 167: blind index de trigrams HMAC para busca por nome em workers
--
-- MODELO DE SEGURANÇA (CipherSweet-compatible):
--   O nome completo do AT nunca é armazenado em plaintext. Esta coluna contém
--   um array de HMACs truncados (8 bytes cada) dos trigrams do nome normalizado
--   (lower + NFD + sem acentos + padding de espaço nas bordas).
--
-- O QUE ESTA COLUNA VAZA:
--   • Distribuição de frequência de trigrams comuns ("ana", "mar", "sil") —
--     análise de frequência possível se o atacante tiver acesso ao banco E
--     souber a chave HMAC (K_trgm). Sem K_trgm, o array é opaco.
--   • Tamanho do array (número de trigrams) — correlaciona com comprimento do nome.
--
-- O QUE NÃO VAZA:
--   • O nome em si — apenas HMAC truncado irreversível.
--
-- ROTAÇÃO DE CHAVE:
--   Trocar K_trgm no Secret Manager exige backfill completo de name_trgm_bidx
--   antes de desativar a versão antiga. Ver script scripts/backfill-name-trgm-bidx.ts.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS name_trgm_bidx BYTEA[];

CREATE INDEX IF NOT EXISTS idx_workers_name_trgm_bidx_gin
  ON workers USING GIN (name_trgm_bidx)
  WHERE merged_into_id IS NULL;

COMMENT ON COLUMN workers.name_trgm_bidx IS
  'Blind index: array de HMAC-SHA256 truncado (8 bytes) de cada trigram do nome '
  'normalizado (lower+NFD+padding). Chave HMAC em Secret Manager: worker-trgm-hmac-key. '
  'Permite busca por nome via @> sem descriptografar. Preencher via BlindIndexService.';
