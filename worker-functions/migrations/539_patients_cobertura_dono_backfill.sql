-- 539 — backfill dos DONOS da cobertura informada em `patients` (spec 058 Parte A, §2.4; plan §2; R4).
--   insurance_informed <- health_insurance_name        (onde o dono é nulo)
--   affiliate_id       <- health_insurance_member_id   (onde o dono é nulo)
-- Normalizador ÚNICO N(x) = NULLIF(NULLIF(lower(btrim(x)), ''), 'null'): o literal "null" (58 linhas medidas em prd), vazio e só-espaço
-- NÃO copiam. É o MESMO N dos dois lados de Q5/Q6 (relatório de conflito). O backfill copia o texto original `btrim(x)`, não o minúsculo.
-- Sem filtro de `deleted_at` (o C-F e o P2 olham todas as linhas). NÃO toca `updated_at` (não acorda leitor de "paciente mudou"); os
-- triggers de `patients` são por coluna e não disparam com estas colunas. Idempotente: só escreve onde o dono é NULL.
-- ⚠️ Migrations rodam no boot: o merge na `main` executa este backfill em prd.
-- Rollback: migrations/pending/ROLLBACK_539_patients_cobertura_dono_backfill.sql (no-op documentado).

UPDATE patients
   SET insurance_informed = btrim(health_insurance_name)
 WHERE insurance_informed IS NULL
   AND NULLIF(NULLIF(lower(btrim(health_insurance_name)), ''), 'null') IS NOT NULL;

UPDATE patients
   SET affiliate_id = btrim(health_insurance_member_id)
 WHERE affiliate_id IS NULL
   AND NULLIF(NULLIF(lower(btrim(health_insurance_member_id)), ''), 'null') IS NOT NULL;

DO $$
DECLARE
  v_nome INT; v_afiliado INT;
BEGIN
  SELECT count(*) INTO v_nome FROM patients
   WHERE insurance_informed IS NULL AND NULLIF(NULLIF(lower(btrim(health_insurance_name)), ''), 'null') IS NOT NULL;
  SELECT count(*) INTO v_afiliado FROM patients
   WHERE affiliate_id IS NULL AND NULLIF(NULLIF(lower(btrim(health_insurance_member_id)), ''), 'null') IS NOT NULL;
  IF v_nome <> 0 OR v_afiliado <> 0 THEN
    RAISE EXCEPTION '[539] backfill incompleto: % sem insurance_informed, % sem affiliate_id', v_nome, v_afiliado;
  END IF;
END
$$;
