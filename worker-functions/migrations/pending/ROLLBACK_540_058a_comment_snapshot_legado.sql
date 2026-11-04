-- ROLLBACK_540_058a_comment_snapshot_legado.sql — par de rollback da migration 540 (spec 058 Parte A). Só documentação.
-- Remove o prefixo SNAPSHOT e restaura o texto anterior quando ele foi preservado ("Antes: ..."); sem texto anterior, zera o COMMENT.
DO $$
DECLARE
  v_alvo RECORD;
  v_atual TEXT;
BEGIN
  FOR v_alvo IN SELECT * FROM (VALUES
    ('patient_contracted_services', 'hourly_value'), ('patient_contracted_services', 'tax_condition'),
    ('patient_contracted_services', 'contract_type'), ('patients', 'insurance_verified'),
    ('patients', 'health_insurance_name'), ('patients', 'health_insurance_member_id')
  ) AS t(tabela, coluna) LOOP
    SELECT col_description(format('public.%I', v_alvo.tabela)::regclass,
                           (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = format('public.%I', v_alvo.tabela)::regclass AND a.attname = v_alvo.coluna))
      INTO v_atual;
    IF v_atual LIKE 'SNAPSHOT%' THEN
      EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L', v_alvo.tabela, v_alvo.coluna,
        CASE WHEN position(' Antes: ' IN v_atual) > 0 THEN substr(v_atual, position(' Antes: ' IN v_atual) + 8) ELSE NULL END);
    END IF;
  END LOOP;
END
$$;
