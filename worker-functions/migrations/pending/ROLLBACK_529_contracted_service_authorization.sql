DO $$
BEGIN
  IF to_regclass('public.contracted_service_authorization') IS NOT NULL
     AND (SELECT count(*) FROM contracted_service_authorization) > 0 THEN
    RAISE EXCEPTION 'há autorização registrada — o rollback apagaria o lançamento da operação (OK do Gabriel antes)';
  END IF;
END $$;
DROP TABLE IF EXISTS contracted_service_authorization;
DROP FUNCTION IF EXISTS fn_csa_country_from_service();
DROP FUNCTION IF EXISTS fn_csa_immutable();
