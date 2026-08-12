-- Migration 216: catálogo de tags para workers + tabela de associação.
--
-- CONTEXTO: permite que o Recrutamento aplique tags controladas (catálogo
-- centralizado gerenciado por admin) em workers para facilitar filtros de
-- busca e segmentação. Tags suportam nome, cor hex e descrição opcional.
--
-- Tabelas:
--   worker_tag_catalog  — catálogo central (soft-delete via deleted_at)
--   worker_tags         — many-to-many worker ↔ tag (PK composta)
--
-- Idempotente: IF NOT EXISTS em todas as DDLs.

CREATE TABLE IF NOT EXISTS worker_tag_catalog (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  color       CHAR(7) NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  description TEXT,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS worker_tag_catalog_name_unique
  ON worker_tag_catalog (lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS worker_tags (
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES worker_tag_catalog(id) ON DELETE RESTRICT,
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (worker_id, tag_id)
);

CREATE INDEX IF NOT EXISTS worker_tags_tag_id_idx ON worker_tags (tag_id);
