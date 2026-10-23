-- 547 — catálogo terapêutico: coluna `description` em objetivos específicos e atividades (spec 061).
--
-- Propósito: cada item do catálogo passa a ter título (`label`, já existente) + descrição opcional.
-- Descrição NULL = sem descrição. A versão do Projeto Terapêutico guarda cópia congelada no snapshot
-- (fora desta migration — `TherapeuticCatalogRepository.snapshotOf`).
--
-- SEM BACKFILL: a coluna nasce vazia (NULL) nas linhas existentes. Nada de UPDATE. `sort_order`,
-- `label_len`, índices, trigger 416 e `therapeutic_segments` ficam intocados.
--
-- Rollback: ALTER TABLE therapeutic_specific_objectives DROP COLUMN description;
--           ALTER TABLE therapeutic_activities          DROP COLUMN description;
-- (a coluna nasce vazia; o DROP também remove o CHECK).

ALTER TABLE therapeutic_specific_objectives ADD COLUMN IF NOT EXISTS description TEXT NULL;
ALTER TABLE therapeutic_activities          ADD COLUMN IF NOT EXISTS description TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'therapeutic_specific_objectives_description_len'
      AND conrelid = 'therapeutic_specific_objectives'::regclass
  ) THEN
    ALTER TABLE therapeutic_specific_objectives
      ADD CONSTRAINT therapeutic_specific_objectives_description_len
      CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'therapeutic_activities_description_len'
      AND conrelid = 'therapeutic_activities'::regclass
  ) THEN
    ALTER TABLE therapeutic_activities
      ADD CONSTRAINT therapeutic_activities_description_len
      CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000);
  END IF;
END
$$;

COMMENT ON COLUMN therapeutic_specific_objectives.description IS 'Descrição do item (spec 061). NULL = sem descrição. Copiada para o snapshot da versão (congelada).';
COMMENT ON COLUMN therapeutic_activities.description IS 'Descrição do item (spec 061). NULL = sem descrição. Copiada para o snapshot da versão (congelada).';
