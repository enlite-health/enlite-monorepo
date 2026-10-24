-- 545 — COMMENT de snapshot em patient_contracted_services.authorized_hours (spec 058 Parte B, plan §1 P7; molde da 540). Só documentação:
-- a coluna não tem vigência, o dono novo é contracted_service_authorization (529) e a coluna sai no P2(B). O texto antigo do COMMENT
-- (quando havia) é preservado depois do prefixo. Idempotente: não prefixa duas vezes. Sem BEGIN/COMMIT.
-- Rollback: migrations/pending/ROLLBACK_545_058b_comment_snapshot_authorized_hours.sql.
DO $$
DECLARE
  v_velho TEXT;
BEGIN
  SELECT col_description('public.patient_contracted_services'::regclass,
                         (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.patient_contracted_services'::regclass AND a.attname = 'authorized_hours'))
    INTO v_velho;
  IF v_velho IS NULL OR v_velho NOT LIKE 'snapshot legado%' THEN
    EXECUTE format('COMMENT ON COLUMN public.patient_contracted_services.authorized_hours IS %L',
      'snapshot legado; dono = contracted_service_authorization; sai no P2(B); Spec 058.' || COALESCE(' Antes: ' || v_velho, ''));
  END IF;
END
$$;
