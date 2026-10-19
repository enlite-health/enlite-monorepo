-- 532 — E1: cadastro da obra social em `insurance_providers` (spec 058 Parte A, §2.1/§2.2; plan §1.1/§2; C3).
-- Antes só havia `code, active, retired_at, sort_order, created_at` (311). Entram: `name` (NOT NULL), dados gerais opcionais,
-- `payer_kind` (classificação corrente do pagador; NULL = ainda não classificado), CHECKs de `PRIVATE`/`OTHER` e as travas.
--
-- `name` — backfill em 3 degraus, só onde ainda é NULL: (1) lista literal dos 33 códigos como estão no `es.json` de 19/10/2026
-- (`admin.patients.insuranceProviderOptions`), (2) o menor alias ClickUp do código, (3) `initcap(code)`. O assert do fim é sobre a
-- TABELA INTEIRA (`count(*) = count(name) = count(distinct lower(btrim(name)))`), não sobre o literal 33: prd pode ter códigos
-- criados depois da 311 (medido em prd: 33 provedores / 33 códigos distintos).
--
-- `…_name_uq` e `insurance_providers_tax_id_uq`: `name_uq` é EXCLUDE btree (`lower(btrim(name)) WITH =`) — unicidade por expressão que
-- ainda aparece em pg_constraint (um índice único por expressão não aparece); recusa com 23P01. `tax_id` é UNIQUE simples (vários NULL
-- convivem, que é o "parcial" da spec) e recusa com 23505.
--
-- T6′ (`trg_058_a_payer_kind_no_unset`, BEFORE UPDATE OF payer_kind): classificado não volta a NULL — numa linha só, sem ler outra
-- tabela (por isso o T5 da 535 não precisa de lock). Pega PATCH, `INSERT … ON CONFLICT DO UPDATE SET payer_kind = NULL` e UPDATE em lote.
-- `retired_at` é carimbado por trigger (R5): o PATCH só manda `active`.
--
-- Idempotente (2×). Rollback: migrations/pending/ROLLBACK_532_insurance_providers_cadastro.sql.

ALTER TABLE insurance_providers
  ADD COLUMN IF NOT EXISTS name               TEXT,
  ADD COLUMN IF NOT EXISTS legal_name         TEXT,
  ADD COLUMN IF NOT EXISTS tax_id             TEXT,
  ADD COLUMN IF NOT EXISTS address            TEXT,
  ADD COLUMN IF NOT EXISTS management_chat_id TEXT,
  ADD COLUMN IF NOT EXISTS payer_kind         TEXT;

-- (1) lista literal do es.json de 19/10/2026
UPDATE insurance_providers p
   SET name = n.name
  FROM (VALUES
    ('API', 'API'), ('ACCORD_SALUD', 'Accord Salud'), ('ASISOC', 'ASISOC'), ('AVALIAN', 'Avalian'),
    ('BANCARIOS', 'Bancarios'), ('CASA', 'CASA'), ('DAS', 'DAS'), ('GALENO', 'Galeno'), ('MHM', 'MHM'),
    ('MEDICUS', 'Medicus'), ('HTAL_BRITANICO', 'Htal Británico'), ('OSPJN', 'OSPJN'), ('OSPECOM', 'OSPECOM'),
    ('OSMECON', 'OSMECON'), ('OSDE', 'OSDE'), ('OMINT', 'Omint'), ('OSPOCE', 'OSPOCE'), ('OGORMAN', 'O''Gorman'),
    ('OSPATCA', 'OSPATCA'), ('OBSBA', 'ObSBA'), ('OSPELSYM', 'Ospelsym'), ('OSTEE_LUZ_MEDICA', 'Ostee Luz Médica'),
    ('OSDEPYM', 'Osdepym'), ('OTHER', 'Otra'), ('PFA_SUPERINTENDENCIA', 'PFA Superintendencia de Bienestar'),
    ('PRIVATE', 'Privado'), ('SANIDAD', 'SANIDAD'), ('SWISS_MEDICAL', 'Swiss Medical'), ('UP', 'UP'),
    ('OSPICHA', 'OSPICHA'), ('USUOMRA', 'USUOMRA'), ('PREVENCION_SALUD', 'Prevención Salud'), ('IOSCOR', 'IOSCOR')
  ) AS n(code, name)
 WHERE p.code = n.code AND p.name IS NULL;

-- (2) menor alias ClickUp
UPDATE insurance_providers p
   SET name = a.label
  FROM (SELECT code, min(label) AS label FROM insurance_provider_aliases GROUP BY code) a
 WHERE p.code = a.code AND p.name IS NULL AND btrim(a.label) <> '';

-- (3) initcap(code)
UPDATE insurance_providers SET name = initcap(code) WHERE name IS NULL;

ALTER TABLE insurance_providers ALTER COLUMN name SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_providers_name_not_blank' AND conrelid = 'insurance_providers'::regclass) THEN
    ALTER TABLE insurance_providers ADD CONSTRAINT insurance_providers_name_not_blank CHECK (btrim(name) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_providers_name_uq' AND conrelid = 'insurance_providers'::regclass) THEN
    ALTER TABLE insurance_providers ADD CONSTRAINT insurance_providers_name_uq
      EXCLUDE USING btree ((lower(btrim(name))) WITH =);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_providers_tax_id_uq' AND conrelid = 'insurance_providers'::regclass) THEN
    ALTER TABLE insurance_providers ADD CONSTRAINT insurance_providers_tax_id_uq UNIQUE (tax_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_providers_management_chat_id_not_blank' AND conrelid = 'insurance_providers'::regclass) THEN
    ALTER TABLE insurance_providers ADD CONSTRAINT insurance_providers_management_chat_id_not_blank
      CHECK (management_chat_id IS NULL OR btrim(management_chat_id) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_providers_payer_kind_check' AND conrelid = 'insurance_providers'::regclass) THEN
    ALTER TABLE insurance_providers ADD CONSTRAINT insurance_providers_payer_kind_check
      CHECK (payer_kind IS NULL OR payer_kind IN ('OBRA_SOCIAL', 'PREPAGA', 'PRIVATE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_providers_private_kind_chk' AND conrelid = 'insurance_providers'::regclass) THEN
    ALTER TABLE insurance_providers ADD CONSTRAINT insurance_providers_private_kind_chk
      CHECK (code <> 'PRIVATE' OR payer_kind IS NULL OR payer_kind = 'PRIVATE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_providers_other_unclassified_chk' AND conrelid = 'insurance_providers'::regclass) THEN
    ALTER TABLE insurance_providers ADD CONSTRAINT insurance_providers_other_unclassified_chk
      CHECK (code <> 'OTHER' OR payer_kind IS NULL);
  END IF;
END
$$;

COMMENT ON COLUMN insurance_providers.payer_kind IS
  'classificação corrente, sem histórico; correção vale retroativamente; NULL = ainda não classificado';

-- Backfill: o código PRIVATE já é, por definição, PRIVATE. Carimbo de autor para o rastro (533 semeia a linha de histórico).
DO $$
BEGIN
  PERFORM set_config('app.current_uid', 'system:migration-532', true);
  UPDATE insurance_providers SET payer_kind = 'PRIVATE' WHERE code = 'PRIVATE' AND payer_kind IS NULL;
  PERFORM set_config('app.current_uid', '', true);
END
$$;

-- T6′: classificado não volta a NULL.
CREATE OR REPLACE FUNCTION fn_058_a_payer_kind_no_unset()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.payer_kind IS NOT NULL AND NEW.payer_kind IS NULL THEN
    RAISE EXCEPTION 'PAYER_KIND_CANNOT_UNSET' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_payer_kind_no_unset ON insurance_providers;
CREATE TRIGGER trg_058_a_payer_kind_no_unset
  BEFORE UPDATE OF payer_kind ON insurance_providers
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_payer_kind_no_unset();

-- R5: `retired_at` carimbado pelo banco. Inativo e vazio → now(); ativo → zera. O PATCH só manda `active`.
CREATE OR REPLACE FUNCTION fn_058_a_providers_retired_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.active THEN
    NEW.retired_at := NULL;
  ELSIF NEW.retired_at IS NULL THEN
    NEW.retired_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_providers_retired_at ON insurance_providers;
CREATE TRIGGER trg_058_a_providers_retired_at
  BEFORE INSERT OR UPDATE ON insurance_providers
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_providers_retired_at();

-- Assert (R1) sobre a TABELA INTEIRA: todo código tem nome e os nomes são distintos (sem caixa/espaço nas pontas).
DO $$
DECLARE
  v_total INT; v_com_nome INT; v_distintos INT;
BEGIN
  SELECT count(*), count(name), count(DISTINCT lower(btrim(name))) INTO v_total, v_com_nome, v_distintos FROM insurance_providers;
  IF v_total <> v_com_nome OR v_total <> v_distintos THEN
    RAISE EXCEPTION '[532] assert de nomes: % provedores, % com nome, % nomes distintos', v_total, v_com_nome, v_distintos;
  END IF;
  RAISE NOTICE '[532] % provedores com nome distinto', v_total;
END
$$;
