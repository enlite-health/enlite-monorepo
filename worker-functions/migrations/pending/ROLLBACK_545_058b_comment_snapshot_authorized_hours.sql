-- ROLLBACK_545_058b_comment_snapshot_authorized_hours.sql — par de rollback da migration 545 (spec 058 Parte B). Só documentação.
-- Remove o prefixo "snapshot legado" e restaura o texto anterior quando ele foi preservado ("Antes: ..."); sem texto anterior, zera o COMMENT.
DO $$
DECLARE
  v_atual TEXT;
BEGIN
  SELECT col_description('public.patient_contracted_services'::regclass,
                         (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.patient_contracted_services'::regclass AND a.attname = 'authorized_hours'))
    INTO v_atual;
  IF v_atual LIKE 'snapshot legado%' THEN
    EXECUTE format('COMMENT ON COLUMN public.patient_contracted_services.authorized_hours IS %L',
      CASE WHEN position(' Antes: ' IN v_atual) > 0 THEN substr(v_atual, position(' Antes: ' IN v_atual) + 8) ELSE NULL END);
  END IF;
END
$$;
