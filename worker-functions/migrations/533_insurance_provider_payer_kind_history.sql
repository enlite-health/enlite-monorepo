-- 533 — rastro da (re)classificação do pagador (spec 058 Parte A, plan §6; molde D95 da 267, imutável como a 504).
-- `payer_kind` é a classificação CORRENTE e sobrescreve no lugar (Rv35). O rastro guarda quem mudou e de/para o quê.
-- Trigger AFTER INSERT OR UPDATE OF payer_kind lendo `app.current_uid` (NULLIF por causa do quirk da GUC vazia da 267):
-- pega PATCH, SQL à mão e upsert, na mesma transação. `changed_by` NULL = "nao_instrumentado" na leitura, nunca inferir.
-- SEM FK para insurance_providers de propósito (a trilha sobrevive ao registro). SÓ IDENTIFICADORES — nada de PII.
-- O PATCH de `payerKind` tem de rodar em `withActorContext`; sem isso o autor sai NULL.
-- Idempotente (2×). Rollback: migrations/pending/ROLLBACK_533_insurance_provider_payer_kind_history.sql.

CREATE TABLE IF NOT EXISTS insurance_provider_payer_kind_history (
  id            BIGSERIAL    PRIMARY KEY,
  provider_code TEXT         NOT NULL,
  old_kind      TEXT         NULL,
  new_kind      TEXT         NULL,
  changed_by    TEXT         NULL,
  changed_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insurance_provider_payer_kind_history_code
  ON insurance_provider_payer_kind_history (provider_code, changed_at DESC);

COMMENT ON TABLE insurance_provider_payer_kind_history IS
  'Trilha append-only da classificação do pagador (migration 533, spec 058). changed_by NULL = nao_instrumentado na leitura, nunca inferir. Só identificadores.';

CREATE OR REPLACE FUNCTION fn_058_a_payer_kind_history()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.payer_kind IS NOT NULL THEN
      INSERT INTO insurance_provider_payer_kind_history (provider_code, old_kind, new_kind, changed_by)
      VALUES (NEW.code, NULL, NEW.payer_kind, NULLIF(current_setting('app.current_uid', true), ''));
    END IF;
  ELSIF OLD.payer_kind IS DISTINCT FROM NEW.payer_kind THEN
    INSERT INTO insurance_provider_payer_kind_history (provider_code, old_kind, new_kind, changed_by)
    VALUES (NEW.code, OLD.payer_kind, NEW.payer_kind, NULLIF(current_setting('app.current_uid', true), ''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_payer_kind_history ON insurance_providers;
CREATE TRIGGER trg_058_a_payer_kind_history
  AFTER INSERT OR UPDATE OF payer_kind ON insurance_providers
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_payer_kind_history();

-- Imutável (molde fn_admission_events_imutavel, 504): nem UPDATE nem DELETE.
CREATE OR REPLACE FUNCTION fn_058_a_payer_kind_history_imutavel()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'payer_kind_history_imutavel: a trilha não se edita nem se apaga' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_payer_kind_history_imutavel ON insurance_provider_payer_kind_history;
CREATE TRIGGER trg_058_a_payer_kind_history_imutavel
  BEFORE UPDATE OR DELETE ON insurance_provider_payer_kind_history
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_payer_kind_history_imutavel();

-- Append-only também nos privilégios (o trigger é a trava forte; isto tira o convite).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT ON insurance_provider_payer_kind_history TO app_runtime';
    EXECUTE 'REVOKE UPDATE, DELETE ON insurance_provider_payer_kind_history FROM app_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE insurance_provider_payer_kind_history_id_seq TO app_runtime';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    EXECUTE 'GRANT SELECT, INSERT ON insurance_provider_payer_kind_history TO app_system';
    EXECUTE 'REVOKE UPDATE, DELETE ON insurance_provider_payer_kind_history FROM app_system';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE insurance_provider_payer_kind_history_id_seq TO app_system';
  END IF;
END
$$;

-- Semente: o estado atual dos já classificados (o PRIVATE da 532), carimbado como migration, não como pessoa.
INSERT INTO insurance_provider_payer_kind_history (provider_code, old_kind, new_kind, changed_by)
SELECT p.code, NULL, p.payer_kind, 'system:migration-532'
  FROM insurance_providers p
 WHERE p.payer_kind IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM insurance_provider_payer_kind_history h WHERE h.provider_code = p.code);
