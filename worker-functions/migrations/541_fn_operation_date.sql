-- 541 — fn_operation_date(country, at): o "hoje" de um país no banco (spec 058 Parte B, plan §1 P1).
-- Espelho SQL de shared/locale/operationDate.ts (mapa de shared/locale/CountryTimezone.ts: AR → America/Argentina/Buenos_Aires,
-- BR → America/Sao_Paulo). País fora do mapa, ou NULL → P0001 UNKNOWN_COUNTRY: NUNCA fallback (a 527 tem fallback silencioso
-- para Buenos Aires, fatos X12 — fica na LISTA, esta função não o reusa). STABLE (now() só entra pelo DEFAULT).
-- Idempotente (CREATE OR REPLACE). Sem BEGIN/COMMIT (o runner abre a transação por arquivo).
-- Rollback: migrations/pending/ROLLBACK_541_fn_operation_date.sql (rodar depois dos ROLLBACK_545…542).
CREATE OR REPLACE FUNCTION fn_operation_date(p_country text, p_at timestamptz DEFAULT now())
RETURNS date
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tz text;
BEGIN
  v_tz := CASE p_country
            WHEN 'AR' THEN 'America/Argentina/Buenos_Aires'
            WHEN 'BR' THEN 'America/Sao_Paulo'
          END;
  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_COUNTRY' USING ERRCODE = 'P0001';
  END IF;
  RETURN (p_at AT TIME ZONE v_tz)::date;
END;
$$;

COMMENT ON FUNCTION fn_operation_date(text, timestamptz) IS
  'Data local (dia de operação) do país no instante p_at. Espelho de shared/locale/operationDate.ts; país fora do mapa lança UNKNOWN_COUNTRY (P0001), nunca fallback. Spec 058 Parte B.';

REVOKE ALL ON FUNCTION fn_operation_date(text, timestamptz) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION fn_operation_date(text, timestamptz) TO app_runtime, app_system';
  END IF;
END
$$;
