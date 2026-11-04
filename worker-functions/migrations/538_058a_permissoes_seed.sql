-- 538 — células da 058 Parte A (spec 058 §3.5; plan §2). Molde 435/522: a migration roda ANTES do deploy do código novo, então SEMEIA as
-- células com descrição PLACEHOLDER; o sync do catálogo (SyncPermissionCatalogUseCase) reescreve a descrição no boot sem trocar o id.
-- A descrição NÃO é 2º dono da definição da célula (o dono é PermissionCell.ts + o sync): `ON CONFLICT DO NOTHING`, nunca `DO UPDATE`.
--
--   11 células novas: catalog_insurance_providers, insurance_provider_contacts, insurance_contracts × read/create/update (9)
--                     · patient_contract_value:create · insurance_provider_patients:read
--    3 referências sem seed em .sql (por robustez; no-op onde já existem): patient_coverage:read, patient_contract_value:read, patient_services:update
--    5 pares de grant por JOIN (quem já tem a referência ganha a célula nova; NUNCA remove grant, NUNCA cria/move/reativa grupo):
--        insurance_contracts:read                 <- patient_services:update
--        catalog_insurance_providers:read         <- patient_coverage:read
--        insurance_provider_contacts:read         <- patient_coverage:read   (sai do seed se o lex negar, NC-14)
--        insurance_provider_patients:read         <- patient_coverage:read
--        patient_contract_value:create            <- patient_contract_value:read
--      Referência sem nenhum grupo (banco novo/CI) => 0 grants => RAISE NOTICE: a 058 fica só-admin até alguém conceder (efeito declarado).
-- Espelho em `public.*` só se `public.permissions` for TABELA física (relkind 'r', PRD no seed 206 cru); a view de compat da 274 não aceita INSERT.
--    + as 11 células novas ao Acesso Master a0000000-...-0001 (molde 519/522/523; prd já enforça `admin.patients`).
-- Idempotente (2×). Rollback: migrations/pending/ROLLBACK_538_058a_permissoes_seed.sql.

DO $$
DECLARE
  v_novas TEXT[][] := ARRAY[
    ['catalog_insurance_providers', 'read',   'Administração'],
    ['catalog_insurance_providers', 'create', 'Administração'],
    ['catalog_insurance_providers', 'update', 'Administração'],
    ['insurance_provider_contacts', 'read',   'Administração'],
    ['insurance_provider_contacts', 'create', 'Administração'],
    ['insurance_provider_contacts', 'update', 'Administração'],
    ['insurance_contracts',         'read',   'Administração'],
    ['insurance_contracts',         'create', 'Administração'],
    ['insurance_contracts',         'update', 'Administração'],
    ['patient_contract_value',      'create', 'Pacientes'],
    ['insurance_provider_patients', 'read',   'Pacientes']
  ];
  v_refs TEXT[][] := ARRAY[
    ['patient_coverage',       'read',   'Pacientes'],
    ['patient_contract_value', 'read',   'Pacientes'],
    ['patient_services',       'update', 'Pacientes']
  ];
  -- [nova.recurso, nova.ação, ref.recurso, ref.ação]
  v_pares TEXT[][] := ARRAY[
    ['insurance_contracts',         'read',   'patient_services',       'update'],
    ['catalog_insurance_providers', 'read',   'patient_coverage',       'read'],
    ['insurance_provider_contacts', 'read',   'patient_coverage',       'read'],
    ['insurance_provider_patients', 'read',   'patient_coverage',       'read'],
    ['patient_contract_value',      'create', 'patient_contract_value', 'read']
  ];
  v_i          INT;
  v_master_id  CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_master_n   INT;
  v_existem    INT;
  v_com_ref    INT;
  v_inseridos  INT;
  v_espelho    BOOLEAN;
BEGIN
  IF to_regclass('iam.permissions') IS NULL THEN
    RAISE NOTICE '[538] iam.permissions inexistente — nada a semear';
    RETURN;
  END IF;

  v_espelho := EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relname = 'permissions' AND c.relkind = 'r');

  FOR v_i IN 1 .. array_length(v_novas, 1) LOOP
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES (v_novas[v_i][1], v_novas[v_i][2],
            format('[538 placeholder — sincronizado no boot] %s:%s (spec 058).', v_novas[v_i][1], v_novas[v_i][2]),
            v_novas[v_i][3], 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
    IF v_espelho THEN
      INSERT INTO public.permissions (resource, action, description, category)
      VALUES (v_novas[v_i][1], v_novas[v_i][2],
              format('[538 placeholder — sincronizado no boot] %s:%s (spec 058).', v_novas[v_i][1], v_novas[v_i][2]), v_novas[v_i][3])
      ON CONFLICT (resource, action) DO NOTHING;
    END IF;
  END LOOP;

  FOR v_i IN 1 .. array_length(v_refs, 1) LOOP
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES (v_refs[v_i][1], v_refs[v_i][2],
            format('[538 placeholder — sincronizado no boot] %s:%s.', v_refs[v_i][1], v_refs[v_i][2]),
            v_refs[v_i][3], 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
    IF v_espelho THEN
      INSERT INTO public.permissions (resource, action, description, category)
      VALUES (v_refs[v_i][1], v_refs[v_i][2], format('[538 placeholder — sincronizado no boot] %s:%s.', v_refs[v_i][1], v_refs[v_i][2]), v_refs[v_i][3])
      ON CONFLICT (resource, action) DO NOTHING;
    END IF;
  END LOOP;

  -- assert: as 14 existem
  SELECT count(*) INTO v_existem FROM iam.permissions
   WHERE (resource, action) IN (
     ('catalog_insurance_providers','read'), ('catalog_insurance_providers','create'), ('catalog_insurance_providers','update'),
     ('insurance_provider_contacts','read'), ('insurance_provider_contacts','create'), ('insurance_provider_contacts','update'),
     ('insurance_contracts','read'), ('insurance_contracts','create'), ('insurance_contracts','update'),
     ('patient_contract_value','create'), ('insurance_provider_patients','read'),
     ('patient_coverage','read'), ('patient_contract_value','read'), ('patient_services','update'));
  IF v_existem <> 14 THEN
    RAISE EXCEPTION '[538] assert: % das 14 células existem em iam.permissions (esperado 14)', v_existem;
  END IF;

  IF to_regclass('iam.group_permissions') IS NULL THEN
    RAISE NOTICE '[538] iam.group_permissions inexistente — sem grants';
    RETURN;
  END IF;

  -- Acesso Master recebe as 11 células novas (molde 519/522/523): em prd a família `admin.patients` já é enforced, então
  -- sem o grant as 6 células de escrita nasceriam sem grupo nenhum. Não cria/move grupo: só concede se o Master existir.
  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE (p.resource, p.action) IN (
       ('catalog_insurance_providers','read'), ('catalog_insurance_providers','create'), ('catalog_insurance_providers','update'),
       ('insurance_provider_contacts','read'), ('insurance_provider_contacts','create'), ('insurance_provider_contacts','update'),
       ('insurance_contracts','read'), ('insurance_contracts','create'), ('insurance_contracts','update'),
       ('patient_contract_value','create'), ('insurance_provider_patients','read'))
       AND p.deprecated_at IS NULL
       AND EXISTS (SELECT 1 FROM iam.permission_groups g WHERE g.id = v_master_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_master_n = ROW_COUNT;
    RAISE NOTICE '[538] grant ao Acesso Master: % célula(s) novas da spec 058', v_master_n;
  END IF;

  FOR v_i IN 1 .. array_length(v_pares, 1) LOOP
    SELECT count(*) INTO v_com_ref
      FROM iam.group_permissions gp JOIN iam.permissions pr ON pr.id = gp.permission_id
     WHERE pr.resource = v_pares[v_i][3] AND pr.action = v_pares[v_i][4] AND pr.deprecated_at IS NULL;

    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT gp.group_id, pn.id
      FROM iam.group_permissions gp
      JOIN iam.permissions pr ON pr.id = gp.permission_id
       AND pr.resource = v_pares[v_i][3] AND pr.action = v_pares[v_i][4] AND pr.deprecated_at IS NULL
      JOIN iam.permissions pn ON pn.resource = v_pares[v_i][1] AND pn.action = v_pares[v_i][2] AND pn.deprecated_at IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inseridos = ROW_COUNT;

    IF v_com_ref = 0 THEN
      RAISE NOTICE '[538] %:% <- %:%: a referência não tem nenhum grupo (0 grants) — a célula nasce só-admin',
        v_pares[v_i][1], v_pares[v_i][2], v_pares[v_i][3], v_pares[v_i][4];
    ELSE
      RAISE NOTICE '[538] %:% <- %:%: % grupo(s) com a referência, % grant(s) inserido(s)',
        v_pares[v_i][1], v_pares[v_i][2], v_pares[v_i][3], v_pares[v_i][4], v_com_ref, v_inseridos;
    END IF;

    IF v_espelho AND to_regclass('public.group_permissions') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = 'group_permissions' AND c.relkind = 'r') THEN
      INSERT INTO public.group_permissions (group_id, permission_id)
      SELECT gp.group_id, pn.id
        FROM public.group_permissions gp
        JOIN public.permissions pr ON pr.id = gp.permission_id AND pr.resource = v_pares[v_i][3] AND pr.action = v_pares[v_i][4]
        JOIN public.permissions pn ON pn.resource = v_pares[v_i][1] AND pn.action = v_pares[v_i][2]
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END
$$;
