-- 531 — extensão btree_gist (spec 058 Parte A, plan §2). Dá `uuid WITH =` dentro de EXCLUDE USING gist:
-- os EXCLUDE de E4 (termos) e E5 (vínculo serviço → contrato) das migrations 536/537.
-- Próprio da Parte A: idempotente com a 526 da stage (mesma extensão, `IF NOT EXISTS`). btree_gist é "trusted" no
-- PG >= 13: basta CREATE no banco (medido: `enlite_app` tem CREATE e é membro de cloudsqlsuperuser).
-- Idempotente (2×). Rollback: migrations/pending/ROLLBACK_531_insurance_btree_gist.sql.
CREATE EXTENSION IF NOT EXISTS btree_gist;
