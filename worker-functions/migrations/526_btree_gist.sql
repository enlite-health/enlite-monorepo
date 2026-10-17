-- 526 — extensão btree_gist (spec 056, Fase 0). Dá `uuid WITH =` dentro de EXCLUDE USING gist:
-- faixa do serviço (527) e autorização (529). btree_gist é "trusted" no PG ≥ 13: basta CREATE no banco
-- (premissa P0.8). Idempotente.
CREATE EXTENSION IF NOT EXISTS btree_gist;
