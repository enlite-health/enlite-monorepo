-- 540 — COMMENT de snapshot nas 6 colunas legadas da cobertura/contrato (spec 058 Parte A, §8.1). Só documentação: o dono novo de cada conceito
-- e "sai no P2(A)". O texto antigo do COMMENT (quando havia) é preservado depois do prefixo. Idempotente: não prefixa duas vezes.
-- Rollback: migrations/pending/ROLLBACK_540_058a_comment_snapshot_legado.sql.
DO $$
DECLARE
  v_alvo RECORD;
  v_velho TEXT;
BEGIN
  FOR v_alvo IN SELECT * FROM (VALUES
    ('patient_contracted_services', 'hourly_value',               'insurance_contract_terms.hourly_rate (via contracted_service_contract)'),
    ('patient_contracted_services', 'tax_condition',              'insurance_contract_terms.tax_rate_percent (via contracted_service_contract)'),
    ('patient_contracted_services', 'contract_type',              'insurance_providers.payer_kind (do contrato vinculado)'),
    ('patients',                    'insurance_verified',         'patient_insurance_verified (coverage verificada)'),
    ('patients',                    'health_insurance_name',      'patients.insurance_informed'),
    ('patients',                    'health_insurance_member_id', 'patients.affiliate_id')
  ) AS t(tabela, coluna, dono) LOOP
    SELECT col_description(format('public.%I', v_alvo.tabela)::regclass,
                           (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = format('public.%I', v_alvo.tabela)::regclass AND a.attname = v_alvo.coluna))
      INTO v_velho;
    IF v_velho IS NULL OR v_velho NOT LIKE 'SNAPSHOT%' THEN
      EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L', v_alvo.tabela, v_alvo.coluna,
        format('SNAPSHOT (spec 058, 19/10/2026): não é mais escrito pela aplicação; dono novo = %s; sai no P2(A).', v_alvo.dono)
        || COALESCE(' Antes: ' || v_velho, ''));
    END IF;
  END LOOP;
END
$$;
