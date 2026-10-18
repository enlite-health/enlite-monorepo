-- 529 — autorização de horas por serviço contratado, com vigência (spec 056 §4.3; D515, D517). Quantidade da vigência
-- INTEIRA (nunca "por mês": o mês é recorte na leitura). Corrigir = nova linha + superseded_at na antiga (bitemporal).
-- Sem DELETE para o app. Idempotente (2×). Rollback: migrations/pending/ROLLBACK_529_contracted_service_authorization.sql.
CREATE TABLE IF NOT EXISTS contracted_service_authorization (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  contracted_service_id UUID         NOT NULL REFERENCES patient_contracted_services(id) ON DELETE CASCADE,
  hours                 NUMERIC      NOT NULL CONSTRAINT csa_hours_positive CHECK (hours > 0),
  valid                 DATERANGE    NOT NULL
                        CONSTRAINT csa_valid_fechada CHECK (NOT isempty(valid) AND NOT lower_inf(valid) AND NOT upper_inf(valid)),
  recorded_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  recorded_by           VARCHAR(128) NOT NULL,
  superseded_at         TIMESTAMPTZ  NULL,
  country               TEXT         NULL   -- etapa 1: trigger; etapa 2: NOT NULL; etapa 3: CHECK (molde 494)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'csa_sem_sobreposicao') THEN
    ALTER TABLE contracted_service_authorization ADD CONSTRAINT csa_sem_sobreposicao
      EXCLUDE USING gist (contracted_service_id WITH =, valid WITH &&) WHERE (superseded_at IS NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_csa_service ON contracted_service_authorization (contracted_service_id);

CREATE OR REPLACE FUNCTION fn_csa_country_from_service()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT pcs.country INTO NEW.country FROM patient_contracted_services pcs WHERE pcs.id = NEW.contracted_service_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_csa_country ON contracted_service_authorization;
CREATE TRIGGER trg_csa_country BEFORE INSERT ON contracted_service_authorization
  FOR EACH ROW EXECUTE FUNCTION fn_csa_country_from_service();
ALTER TABLE contracted_service_authorization ALTER COLUMN country SET NOT NULL;
ALTER TABLE contracted_service_authorization DROP CONSTRAINT IF EXISTS csa_country_check;
ALTER TABLE contracted_service_authorization ADD CONSTRAINT csa_country_check CHECK (country IN ('AR', 'BR'));

-- só superseded_at muda, e uma vez (NULL → valor). Fato gravado não se reescreve.
CREATE OR REPLACE FUNCTION fn_csa_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'csa_imutavel' USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'csa_ja_substituida' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_csa_immutable ON contracted_service_authorization;
CREATE TRIGGER trg_csa_immutable BEFORE UPDATE ON contracted_service_authorization
  FOR EACH ROW EXECUTE FUNCTION fn_csa_immutable();

ALTER TABLE contracted_service_authorization ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contracted_service_authorization_follow_service ON contracted_service_authorization;
CREATE POLICY contracted_service_authorization_follow_service ON contracted_service_authorization FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_contracted_services pcs WHERE pcs.id = contracted_service_authorization.contracted_service_id)
);

GRANT SELECT, INSERT, UPDATE ON contracted_service_authorization TO app_runtime, app_system;
REVOKE DELETE ON contracted_service_authorization FROM app_runtime, app_system;

COMMENT ON TABLE contracted_service_authorization IS
  'Horas autorizadas pela obra social para UM serviço contratado, com vigência fechada [desde, hasta+1). hours = total da '
  'vigência inteira. Uma autorização corrente por período (csa_sem_sobreposicao). O contrato da obra social, quando existir, '
  'aponta para o serviço e LÊ daqui (D517). Fora da régua do estado (D516). Rollback: '
  'migrations/pending/ROLLBACK_529_contracted_service_authorization.sql.';
COMMENT ON COLUMN contracted_service_authorization.superseded_at IS
  'NULL = linha corrente (único significado). Preenchido = corrigida por outra linha; guarda o que valia quando se faturou.';
COMMENT ON COLUMN contracted_service_authorization.country IS
  'Herdado de patient_contracted_services.country por trigger (etapa 1/3). NOT NULL (2/3) + CHECK AR/BR (3/3).';
