-- 524 — extensão btree_gist (spec 056, Fase 0). Dá `uuid WITH =` dentro de EXCLUDE USING gist:
-- faixa do serviço (525) e autorização (527). btree_gist é "trusted" no PG ≥ 13: basta CREATE no banco
-- (premissa P0.8). Idempotente.
CREATE EXTENSION IF NOT EXISTS btree_gist;
