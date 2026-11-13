-- Migration 582: qualidade do geocode em patient_addresses (spec 077 §8.3, F1)
--
-- O Google devolve, junto com lat/lng, `location_type` e `partial_match`. Guardamos os dois FATOS
-- (o que o Google disse) e o instante do geocode; o veredito "confiável" NÃO é gravado.
--
-- Dono do conceito: patient_addresses (mesma linha de lat/lng, migration 153). Nada novo duplicado.
--
-- Semântica de cada coluna (NULL tem UM significado):
--   geocode_quality       text        ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE | UNKNOWN
--                                     UNKNOWN = o Google respondeu e não classificou (≠ NULL).
--                                     NULL = ainda não classificado (endereço anterior ao backfill ou geocode falhou).
--   geocode_partial_match boolean     flag `partial_match` da resposta do Google.
--                                     NULL = ainda não classificado (endereço anterior ao backfill ou geocode falhou).
--   geocoded_at           timestamptz instante do geocode que produziu os dois campos acima.
--                                     NULL = ainda não classificado (endereço anterior ao backfill ou geocode falhou).
--
-- DERIVADO NUNCA GRAVADO (D516): NÃO existe coluna `quality`/`is_reliable`. A regra
-- `RELIABLE ⇔ geocode_quality IN (ROOFTOP, RANGE_INTERPOLATED) AND geocode_partial_match IS NOT TRUE`
-- mora no código (`isReliableGeocode`, T267), para mudar de régua sem migration nem backfill.
--
-- Sem NOT NULL/DEFAULT (não força backfill). Não toca lat/lng.
-- Idempotente (2×): ADD COLUMN IF NOT EXISTS (o CHECK inline só é criado junto com a coluna).
-- Sem BEGIN/COMMIT próprio.
--
-- Rollback: `migrations/pending/ROLLBACK_582_patient_addresses_geocode_quality.sql`.

ALTER TABLE patient_addresses
  ADD COLUMN IF NOT EXISTS geocode_quality text NULL
    CHECK (geocode_quality IN ('ROOFTOP','RANGE_INTERPOLATED','GEOMETRIC_CENTER','APPROXIMATE','UNKNOWN')),
  ADD COLUMN IF NOT EXISTS geocode_partial_match boolean NULL,
  ADD COLUMN IF NOT EXISTS geocoded_at timestamptz NULL;

COMMENT ON COLUMN patient_addresses.geocode_quality IS 'location_type do Google no último geocode (ROOFTOP|RANGE_INTERPOLATED|GEOMETRIC_CENTER|APPROXIMATE). UNKNOWN = Google respondeu e não classificou. NULL = ainda não classificado (anterior ao backfill ou geocode falhou). Confiabilidade é derivada no código (isReliableGeocode), nunca gravada.';
COMMENT ON COLUMN patient_addresses.geocode_partial_match IS 'Flag partial_match do Google no último geocode. NULL = ainda não classificado (anterior ao backfill ou geocode falhou).';
COMMENT ON COLUMN patient_addresses.geocoded_at IS 'Instante do geocode que gravou geocode_quality/geocode_partial_match. NULL = ainda não classificado (anterior ao backfill ou geocode falhou).';
