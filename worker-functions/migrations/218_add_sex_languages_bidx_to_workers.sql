-- Migration 218: blind indexes para sexo e idiomas em workers
--
-- MODELO DE SEGURANÇA (CipherSweet-compatible):
--   sex_encrypted e languages_encrypted NUNCA são armazenados em plaintext.
--   Estas colunas contêm HMACs determinísticos (truncado a 8 bytes) do VALOR
--   INTEIRO normalizado — diferente do índice de nome (trigrams), aqui é HMAC
--   do valor canônico completo (ex.: 'male', 'female', 'es', 'pt').
--
-- CANONICAL VALUES:
--   sex_bidx:        HMAC de 'male' | 'female' (via normalizeSexValue())
--   languages_bidx:  HMAC de cada idioma normalizado (ex.: 'es', 'pt', 'en')
--
-- CHAVE:
--   Mesma chave do índice de nome: worker-trgm-hmac-key no Secret Manager.
--   testMode: NODE_ENV=test → chave fixa (32 bytes 0x42).
--
-- O QUE ESTA COLUNA VAZA:
--   • Distribuição de frequência (ex.: quantos workers são 'female').
--     Sem a chave HMAC, o HMAC é opaco.
--
-- ROTAÇÃO DE CHAVE:
--   Trocar K_hmac exige backfill completo via
--   scripts/backfill-sex-languages-bidx.ts antes de desativar a versão antiga.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS sex_bidx       BYTEA,
  ADD COLUMN IF NOT EXISTS languages_bidx BYTEA[];

CREATE INDEX IF NOT EXISTS idx_workers_sex_bidx
  ON workers (sex_bidx)
  WHERE merged_into_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_workers_languages_bidx_gin
  ON workers USING GIN (languages_bidx)
  WHERE merged_into_id IS NULL;

COMMENT ON COLUMN workers.sex_bidx IS
  'Blind index: HMAC-SHA256 truncado (8 bytes) do valor canônico normalizado de sexo '
  '(''male'' ou ''female'' em lowercase inglês). Chave HMAC em Secret Manager: '
  'worker-trgm-hmac-key. Permite filtrar por sexo via = sem descriptografar. '
  'Preencher via BlindIndexService.generateValueBidx(normalizeSexValue(sex)).';

COMMENT ON COLUMN workers.languages_bidx IS
  'Blind index: array de HMAC-SHA256 truncado (8 bytes) de cada idioma normalizado '
  '(ex.: ''es'', ''pt'', ''en'' em lowercase). Chave HMAC em Secret Manager: '
  'worker-trgm-hmac-key. Permite filtrar por idioma via @> sem descriptografar. '
  'Preencher via BlindIndexService.generateValuesBidx(languages).';
