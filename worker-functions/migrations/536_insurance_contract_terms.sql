-- 536 — E4: termo do contrato = valor-hora + imposto % com vigência (spec 058 Parte A, §2.1 E4; plan §1.1).
-- Bitemporal no molde da 529: corrigir/reprecificar = linha NOVA + marcar a antiga (`superseded_*`); nunca reescrever. Sem DELETE.
--   hourly_rate        NUMERIC(12,2) > 0 (preço COBRADO; nada a ver com a remuneração do prestador).
--   tax_rate_percent   NUMERIC(5,2) NOT NULL, 0..100, SEM DEFAULT: `0` = isento; "não definido" não existe (formulário vazio → 422).
--   valid              DATERANGE não vazio, lower obrigatório, upper aberto = sem fim.
--   superseded_*       trio coerente por CHECK (3 nulos ou 3 preenchidos), razão REPRICED|CORRECTION; `superseded_at` posto POR TRIGGER (R5):
--                      o escritor só informa `superseded_by`/`superseded_reason`.
-- Imutabilidade ADAPTADA (R2): o molde `fn_csa_immutable` (529:46) só libera `superseded_at`, o que recusaria o trio. Aqui o trigger libera o
-- trio inteiro, uma única vez (NULL → valor), e recusa qualquer outra mudança.
-- Idempotente (2×). Rollback: migrations/pending/ROLLBACK_536_insurance_contract_terms.sql.

CREATE TABLE IF NOT EXISTS insurance_contract_terms (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id        UUID          NOT NULL REFERENCES insurance_contracts(id),
  hourly_rate        NUMERIC(12,2) NOT NULL,
  tax_rate_percent   NUMERIC(5,2)  NOT NULL,
  valid              DATERANGE     NOT NULL,
  recorded_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  recorded_by        VARCHAR(128)  NOT NULL,
  superseded_at      TIMESTAMPTZ   NULL,
  superseded_by      VARCHAR(128)  NULL,
  superseded_reason  TEXT          NULL,

  CONSTRAINT insurance_contract_terms_hourly_rate_check CHECK (hourly_rate > 0),
  CONSTRAINT insurance_contract_terms_tax_rate_percent_check CHECK (tax_rate_percent >= 0 AND tax_rate_percent <= 100),
  CONSTRAINT insurance_contract_terms_valid_check CHECK (NOT isempty(valid) AND NOT lower_inf(valid)),
  CONSTRAINT insurance_contract_terms_superseded_reason_check
    CHECK (superseded_reason IS NULL OR superseded_reason IN ('REPRICED', 'CORRECTION')),
  CONSTRAINT insurance_contract_terms_superseded_trio_chk
    CHECK ((superseded_at IS NULL AND superseded_by IS NULL AND superseded_reason IS NULL)
        OR (superseded_at IS NOT NULL AND superseded_by IS NOT NULL AND superseded_reason IS NOT NULL))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_contract_terms_sem_sobreposicao') THEN
    ALTER TABLE insurance_contract_terms ADD CONSTRAINT insurance_contract_terms_sem_sobreposicao
      EXCLUDE USING gist (contract_id WITH =, valid WITH &&) WHERE (superseded_at IS NULL);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_insurance_contract_terms_contract ON insurance_contract_terms (contract_id);

-- R2 + R5: só o trio `superseded_*` muda, uma única vez; `superseded_at` é posto aqui, com o now() do banco.
CREATE OR REPLACE FUNCTION fn_058_a_term_immutable()
RETURNS TRIGGER AS $$
DECLARE
  v_livres CONSTANT TEXT[] := ARRAY['superseded_at', 'superseded_by', 'superseded_reason'];
BEGIN
  IF (to_jsonb(NEW) - v_livres) IS DISTINCT FROM (to_jsonb(OLD) - v_livres) THEN
    RAISE EXCEPTION 'insurance_contract_term_imutavel' USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'insurance_contract_term_ja_substituido' USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by IS NOT NULL OR NEW.superseded_reason IS NOT NULL THEN
    NEW.superseded_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_term_immutable ON insurance_contract_terms;
CREATE TRIGGER trg_058_a_term_immutable
  BEFORE UPDATE ON insurance_contract_terms
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_term_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON insurance_contract_terms TO app_runtime';
    EXECUTE 'REVOKE DELETE ON insurance_contract_terms FROM app_runtime';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON insurance_contract_terms TO app_system';
    EXECUTE 'REVOKE DELETE ON insurance_contract_terms FROM app_system';
  END IF;
END
$$;

COMMENT ON TABLE insurance_contract_terms IS
  'Termo do contrato: valor-hora e imposto % com vigência fechada à esquerda (spec 058, E4). Uma linha corrente por período (…_sem_sobreposicao); corrigir = linha nova + trio superseded_*. Sem DELETE.';
COMMENT ON COLUMN insurance_contract_terms.tax_rate_percent IS
  'Imposto em % (0..100), NOT NULL e SEM DEFAULT: 0 = isento; não existe "não definido".';
