-- ROLLBACK_538_058a_permissoes_seed.sql — par de rollback da migration 538 (spec 058 Parte A).
-- Remove os grants e depois as 11 células novas (NÃO toca nas 3 referências, que pertencem a outras features).
-- Só vale antes de o código novo ser deployado: o sync de boot recria a célula que uma rota declarar.
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_538_058a_permissoes_seed.sql
DO $$
DECLARE
  v_novas TEXT[][] := ARRAY[
    ['catalog_insurance_providers','read'], ['catalog_insurance_providers','create'], ['catalog_insurance_providers','update'],
    ['insurance_provider_contacts','read'], ['insurance_provider_contacts','create'], ['insurance_provider_contacts','update'],
    ['insurance_contracts','read'], ['insurance_contracts','create'], ['insurance_contracts','update'],
    ['patient_contract_value','create'], ['insurance_provider_patients','read']];
  v_i INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL AND to_regclass('iam.group_permissions') IS NOT NULL THEN
    FOR v_i IN 1 .. array_length(v_novas, 1) LOOP
      DELETE FROM iam.group_permissions WHERE permission_id IN
        (SELECT id FROM iam.permissions WHERE resource = v_novas[v_i][1] AND action = v_novas[v_i][2]);
      DELETE FROM iam.permissions WHERE resource = v_novas[v_i][1] AND action = v_novas[v_i][2];
    END LOOP;
  END IF;
END
$$;
