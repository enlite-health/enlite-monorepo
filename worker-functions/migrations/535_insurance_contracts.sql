-- 535 — E3: contrato da obra social (spec 058 Parte A, §2.1 E3/§2.2 T5; plan §2).
-- Global (sem RLS: catálogo, como `insurance_providers`). `provider_code` e `country` são IMUTÁVEIS depois de criados (trigger): o vínculo
-- do serviço (537) compara o país do contrato com o do serviço e o pagador entre contratos. `OTHER` não tem contrato (é "não listada").
-- `…_name_uq` é UNIQUE INDEX `(provider_code, lower(name))`; recusa 23505 (confere-se em pg_indexes, não em pg_constraint).
-- `scope_description` é TEXTO descritivo (NC-01: abrangência é rótulo até o Marcel dizer que é regra).
--
-- T5 (`trg_058_a_contract_requires_payer_kind`, BEFORE INSERT): contrato só nasce sob pagador CLASSIFICADO (`payer_kind` não nulo).
-- Sem lock de linha de propósito: o T6′ da 532 impede o retorno a NULL, então "contrato sob pagador sem tipo" não tem como surgir depois;
-- se o T5 leu NULL (classificação concorrente ainda não commitada) recusa e o operador repete (lado seguro).
-- Idempotente (2×). Rollback: migrations/pending/ROLLBACK_535_insurance_contracts.sql.

CREATE TABLE IF NOT EXISTS insurance_contracts (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code     TEXT         NOT NULL REFERENCES insurance_providers(code),
  country           TEXT         NOT NULL,
  name              TEXT         NOT NULL,
  scope_description TEXT         NULL,
  created_by        VARCHAR(128) NOT NULL,
  updated_by        VARCHAR(128) NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT insurance_contracts_provider_not_other_chk CHECK (provider_code <> 'OTHER'),
  CONSTRAINT insurance_contracts_country_check CHECK (country IN ('AR', 'BR')),
  CONSTRAINT insurance_contracts_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS insurance_contracts_name_uq ON insurance_contracts (provider_code, lower(name));
CREATE INDEX IF NOT EXISTS idx_insurance_contracts_provider ON insurance_contracts (provider_code);

CREATE OR REPLACE FUNCTION fn_058_a_contract_immutable_keys()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.provider_code IS DISTINCT FROM OLD.provider_code OR NEW.country IS DISTINCT FROM OLD.country THEN
    RAISE EXCEPTION 'insurance_contract_imutavel: provider_code e country não mudam' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_contract_immutable_keys ON insurance_contracts;
CREATE TRIGGER trg_058_a_contract_immutable_keys
  BEFORE UPDATE ON insurance_contracts
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_contract_immutable_keys();

-- T5
CREATE OR REPLACE FUNCTION fn_058_a_contract_requires_payer_kind()
RETURNS TRIGGER AS $$
DECLARE
  v_found BOOLEAN;
  v_kind  TEXT;
BEGIN
  SELECT true, p.payer_kind INTO v_found, v_kind FROM insurance_providers p WHERE p.code = NEW.provider_code;
  IF v_found IS TRUE AND v_kind IS NULL THEN
    RAISE EXCEPTION 'PAYER_KIND_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_contract_requires_payer_kind ON insurance_contracts;
CREATE TRIGGER trg_058_a_contract_requires_payer_kind
  BEFORE INSERT ON insurance_contracts
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_contract_requires_payer_kind();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON insurance_contracts TO app_runtime';
    EXECUTE 'REVOKE DELETE ON insurance_contracts FROM app_runtime';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON insurance_contracts TO app_system';
    EXECUTE 'REVOKE DELETE ON insurance_contracts FROM app_system';
  END IF;
END
$$;

COMMENT ON TABLE insurance_contracts IS
  'Contrato com a obra social (spec 058, E3). provider_code e country imutáveis; valor-hora e imposto moram nos termos (536); sem DELETE.';
