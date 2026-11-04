-- 537 — E5: vínculo serviço contratado → contrato, com vigência (spec 058 Parte A, §2.1 E5/§2.2 T1-T3; plan §1.1/§1.3.1).
-- Molde da 529 (bitemporal, RLS por EXISTS no serviço, GRANT SELECT/INSERT/UPDATE, sem DELETE). Linhas superadas só existem no banco.
-- Carimbos postos pelo BANCO (R5), nunca por timestamp da aplicação: `recorded_xact xid8 DEFAULT pg_current_xact_id()` no INSERT;
-- `superseded_at` (now()) e `superseded_xact` por trigger quando o trio `superseded_*` é marcado. Escolha de xid8 (e não `xmin`): sobrevive
-- a savepoint, onde `xmin` seria o subxid.
--
-- T1/T2 (`trg_058_a_csc_guard`, BEFORE INSERT; lock `hashtext('contract-link:patient:'||patient_id)`, relê `patient_id` depois do lock):
--   COUNTRY_MISMATCH  país do contrato <> país do serviço.
--   Vínculo NOVO (POST: nenhuma linha DESTE serviço marcada na transação corrente), regras literais sobre linhas de TRANSAÇÕES ANTERIORES:
--     existe linha superada por ENDED/SWITCHED, ou mais de 1 viva -> REQUIRES_NEW_SERVICE (ENDED é terminal para vínculo novo);
--     exatamente 1 viva e nenhuma superada por ENDED/SWITCHED -> USE_CORRECTION; 0 linhas, ou só CORRECTION sem viva -> permitido.
--   Caminho do ESCRITOR (existe linha DO MESMO `contracted_service_id` do NEW com `superseded_xact = transação corrente`): a regra acima NÃO
--     se aplica; só confere: SWITCHED/ENDED exigem o mesmo `provider_code` da linha superada (senão REQUIRES_NEW_SERVICE); ENDED só admite o
--     reinsert FECHADO; CORRECTION aceita qualquer pagador. Marcação em OUTRO serviço, mesmo do mesmo paciente, não isenta (B4).
--   T2 TWO_PAYERS_OVERLAP: linha viva de OUTRO serviço do mesmo paciente com `valid && NEW.valid` e `provider_code` diferente.
--     A T2 NÃO lê `payer_kind` (senão a reclassificação retroativa poderia violá-la depois do fato).
-- T3 (`trg_058_a_pcs_immutable_patient_country`, em patient_contracted_services): lock OLD+NEW e recusa a troca de patient_id/country
--   quando existe QUALQUER linha em E5 do serviço (vigente ou superada) (R6). Sem E5, a troca passa.
-- Imutabilidade ADAPTADA ao trio (R2), como a 536: libera superseded_at/_by/_reason/_xact, uma única vez, e nada mais.
-- Idempotente (2×). Rollback: migrations/pending/ROLLBACK_537_contracted_service_contract.sql.

CREATE TABLE IF NOT EXISTS contracted_service_contract (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  contracted_service_id UUID         NOT NULL REFERENCES patient_contracted_services(id) ON DELETE CASCADE,
  contract_id           UUID         NOT NULL REFERENCES insurance_contracts(id),
  valid                 DATERANGE    NOT NULL,
  recorded_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  recorded_by           VARCHAR(128) NOT NULL,
  recorded_xact         XID8         NOT NULL DEFAULT pg_current_xact_id(),
  superseded_at         TIMESTAMPTZ  NULL,
  superseded_by         VARCHAR(128) NULL,
  superseded_reason     TEXT         NULL,
  superseded_xact       XID8         NULL,

  CONSTRAINT contracted_service_contract_valid_check CHECK (NOT isempty(valid) AND NOT lower_inf(valid)),
  CONSTRAINT contracted_service_contract_superseded_reason_check
    CHECK (superseded_reason IS NULL OR superseded_reason IN ('ENDED', 'SWITCHED', 'CORRECTION')),
  CONSTRAINT contracted_service_contract_superseded_trio_chk
    CHECK ((superseded_at IS NULL AND superseded_by IS NULL AND superseded_reason IS NULL AND superseded_xact IS NULL)
        OR (superseded_at IS NOT NULL AND superseded_by IS NOT NULL AND superseded_reason IS NOT NULL AND superseded_xact IS NOT NULL))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contracted_service_contract_sem_sobreposicao') THEN
    ALTER TABLE contracted_service_contract ADD CONSTRAINT contracted_service_contract_sem_sobreposicao
      EXCLUDE USING gist (contracted_service_id WITH =, valid WITH &&) WHERE (superseded_at IS NULL);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS csc_service_idx ON contracted_service_contract (contracted_service_id);

-- R2 + R5: só o trio (+ xact) muda, uma única vez; os carimbos são postos aqui.
CREATE OR REPLACE FUNCTION fn_058_a_csc_immutable()
RETURNS TRIGGER AS $$
DECLARE
  v_livres CONSTANT TEXT[] := ARRAY['superseded_at', 'superseded_by', 'superseded_reason', 'superseded_xact'];
BEGIN
  IF (to_jsonb(NEW) - v_livres) IS DISTINCT FROM (to_jsonb(OLD) - v_livres) THEN
    RAISE EXCEPTION 'contracted_service_contract_imutavel' USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'contracted_service_contract_ja_substituido' USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by IS NOT NULL OR NEW.superseded_reason IS NOT NULL THEN
    NEW.superseded_at := now();
    NEW.superseded_xact := pg_current_xact_id();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_csc_immutable ON contracted_service_contract;
CREATE TRIGGER trg_058_a_csc_immutable
  BEFORE UPDATE ON contracted_service_contract
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_csc_immutable();

-- T1 + T2
CREATE OR REPLACE FUNCTION fn_058_a_csc_guard()
RETURNS TRIGGER AS $$
DECLARE
  v_cur              CONSTANT XID8 := pg_current_xact_id();
  v_patient          UUID;
  v_patient_depois   UUID;
  v_service_country  TEXT;
  v_contract_country TEXT;
  v_provider         TEXT;
  v_ended_switched   INT;
  v_vivas            INT;
BEGIN
  NEW.recorded_xact := v_cur;

  SELECT s.patient_id INTO v_patient FROM patient_contracted_services s WHERE s.id = NEW.contracted_service_id;
  IF v_patient IS NULL THEN
    RETURN NEW; -- a FK recusa o serviço inexistente
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('contract-link:patient:' || v_patient::text));
  -- relê depois do lock: o serviço pode ter trocado de paciente enquanto esperávamos
  SELECT s.patient_id, s.country INTO v_patient_depois, v_service_country
    FROM patient_contracted_services s WHERE s.id = NEW.contracted_service_id;
  IF v_patient_depois IS DISTINCT FROM v_patient THEN
    PERFORM pg_advisory_xact_lock(hashtext('contract-link:patient:' || v_patient_depois::text));
    v_patient := v_patient_depois;
  END IF;

  SELECT c.provider_code, c.country INTO v_provider, v_contract_country FROM insurance_contracts c WHERE c.id = NEW.contract_id;
  IF NOT FOUND THEN
    RETURN NEW; -- a FK recusa o contrato inexistente
  END IF;

  IF v_contract_country IS DISTINCT FROM v_service_country THEN
    RAISE EXCEPTION 'COUNTRY_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM contracted_service_contract e
              WHERE e.contracted_service_id = NEW.contracted_service_id AND e.superseded_xact = v_cur) THEN
    -- caminho do escritor: só confere o pagador da linha que ESTA transação marcou
    IF EXISTS (SELECT 1 FROM contracted_service_contract e
                 JOIN insurance_contracts ec ON ec.id = e.contract_id
                WHERE e.contracted_service_id = NEW.contracted_service_id AND e.superseded_xact = v_cur
                  AND e.superseded_reason IN ('SWITCHED', 'ENDED') AND ec.provider_code <> v_provider) THEN
      RAISE EXCEPTION 'REQUIRES_NEW_SERVICE' USING ERRCODE = 'P0001';
    END IF;
    IF upper_inf(NEW.valid) AND EXISTS (SELECT 1 FROM contracted_service_contract e
                WHERE e.contracted_service_id = NEW.contracted_service_id AND e.superseded_xact = v_cur
                  AND e.superseded_reason = 'ENDED') THEN
      RAISE EXCEPTION 'REQUIRES_NEW_SERVICE' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- vínculo novo: regras literais sobre linhas de transações anteriores
    SELECT count(*) FILTER (WHERE e.superseded_reason IN ('ENDED', 'SWITCHED')),
           count(*) FILTER (WHERE e.superseded_at IS NULL)
      INTO v_ended_switched, v_vivas
      FROM contracted_service_contract e
     WHERE e.contracted_service_id = NEW.contracted_service_id AND e.recorded_xact <> v_cur;
    IF v_ended_switched > 0 OR v_vivas > 1 THEN
      RAISE EXCEPTION 'REQUIRES_NEW_SERVICE' USING ERRCODE = 'P0001';
    ELSIF v_vivas = 1 THEN
      RAISE EXCEPTION 'USE_CORRECTION' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- T2: dois pagadores ao mesmo tempo para o mesmo paciente
  IF NEW.superseded_at IS NULL AND EXISTS (
       SELECT 1 FROM contracted_service_contract e
         JOIN patient_contracted_services s ON s.id = e.contracted_service_id
         JOIN insurance_contracts ec ON ec.id = e.contract_id
        WHERE s.patient_id = v_patient AND e.contracted_service_id <> NEW.contracted_service_id
          AND e.superseded_at IS NULL AND e.valid && NEW.valid AND ec.provider_code <> v_provider) THEN
    RAISE EXCEPTION 'TWO_PAYERS_OVERLAP' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_csc_guard ON contracted_service_contract;
CREATE TRIGGER trg_058_a_csc_guard
  BEFORE INSERT ON contracted_service_contract
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_csc_guard();

-- T3: o serviço não muda de paciente/país por baixo do vínculo
CREATE OR REPLACE FUNCTION fn_058_a_pcs_immutable_patient_country()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.country IS DISTINCT FROM OLD.country THEN
    -- ordem estável (menor texto primeiro) para não criar deadlock entre duas trocas cruzadas
    PERFORM pg_advisory_xact_lock(hashtext('contract-link:patient:' || LEAST(OLD.patient_id::text, NEW.patient_id::text)));
    IF OLD.patient_id <> NEW.patient_id THEN
      PERFORM pg_advisory_xact_lock(hashtext('contract-link:patient:' || GREATEST(OLD.patient_id::text, NEW.patient_id::text)));
    END IF;
    IF EXISTS (SELECT 1 FROM contracted_service_contract e WHERE e.contracted_service_id = OLD.id) THEN
      RAISE EXCEPTION 'SERVICE_HAS_CONTRACT_LINK' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_058_a_pcs_immutable_patient_country ON patient_contracted_services;
CREATE TRIGGER trg_058_a_pcs_immutable_patient_country
  BEFORE UPDATE OF patient_id, country ON patient_contracted_services
  FOR EACH ROW EXECUTE FUNCTION fn_058_a_pcs_immutable_patient_country();

ALTER TABLE contracted_service_contract ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contracted_service_contract_follow_service ON contracted_service_contract;
CREATE POLICY contracted_service_contract_follow_service ON contracted_service_contract FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_contracted_services pcs WHERE pcs.id = contracted_service_contract.contracted_service_id)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON contracted_service_contract TO app_runtime, app_system';
    EXECUTE 'REVOKE DELETE ON contracted_service_contract FROM app_runtime, app_system';
  END IF;
END
$$;

COMMENT ON TABLE contracted_service_contract IS
  'Vínculo serviço contratado -> contrato, com vigência fechada [desde, até+1) (spec 058, E5). Corrigir/trocar/encerrar = linha nova + trio superseded_* '
  '(ENDED|SWITCHED|CORRECTION); linhas superadas só no banco. Travas T1/T2 (trg_058_a_csc_guard) e T3 (em patient_contracted_services). Sem DELETE.';
