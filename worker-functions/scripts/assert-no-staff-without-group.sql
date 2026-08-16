-- assert-no-staff-without-group.sql — GATE DA VIRADA do painel de grupos (D114, lex C2)
--
-- Uso (runbook `docs/runbook-abac-virada.md`, passo da virada do engine):
--
--     psql "$DATABASE_URL" -f scripts/assert-no-staff-without-group.sql
--
-- POR QUÊ: depois da virada, o grupo é a ÚNICA fonte de acesso — staff ACTIVE sem
-- nenhum grupo vigente vê a tela de boas-vindas e mais nada. Ligar
-- `PERMISSION_ENGINE_ENABLED` antes da migração de dados apagaria o painel para o time
-- inteiro, e o sintoma ("sumiu tudo") não aponta para a causa.
--
-- POR QUE NÃO NO BOOT: worker-functions serve também a app do prestador, os leads e os
-- webhooks. Um assert de boot fail-closed trocaria um problema de ACESSO por uma
-- INDISPONIBILIDADE geral (veto explícito do lex, C2). O processo só ALERTA; quem falha
-- é este script, rodado pelo operador antes do flip.
--
-- Re-executável à vontade. Não escreve nada. Saída para colar no diário no fim.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_tenant     UUID := iam.current_tenant_id();
  v_sem_grupo  INT;
  v_sem_pais   INT;
  v_gestores   INT;
  v_marcador   TEXT;
BEGIN
  SELECT count(*) INTO v_sem_grupo
    FROM users u
   WHERE u.status = 'ACTIVE'
     AND u.role IN ('admin', 'recruiter', 'community_manager')
     AND NOT EXISTS (
       SELECT 1 FROM iam.user_groups ug
         JOIN iam.permission_groups g ON g.id = ug.group_id
          AND g.archived_at IS NULL AND g.tenant_id = v_tenant
        WHERE ug.user_id = u.firebase_uid AND ug.removed_at IS NULL);

  SELECT count(*) INTO v_sem_pais
    FROM users u
   WHERE u.status = 'ACTIVE'
     AND u.role IN ('admin', 'recruiter', 'community_manager')
     AND cardinality(iam.effective_countries(u.firebase_uid, v_tenant)) = 0;

  SELECT count(DISTINCT u.firebase_uid) INTO v_gestores
    FROM users u
   WHERE u.status = 'ACTIVE'
     AND 'permission_management:write' = ANY (iam.effective_permissions(u.firebase_uid, v_tenant));

  SELECT value INTO v_marcador FROM iam.rollout_state WHERE key = 'permission_groups_migrated';

  RAISE NOTICE '[perm] staff ACTIVE sem grupo: % | sem país efetivo: % | gestores: % | marcador: %',
    v_sem_grupo, v_sem_pais, v_gestores, COALESCE(v_marcador, '(ausente)');

  IF v_sem_grupo > 0 THEN
    RAISE EXCEPTION '[perm] % staff ACTIVE sem NENHUM grupo vigente — rodar a migração de dados antes de virar o engine', v_sem_grupo;
  END IF;

  -- (lex C1) Acesso urgente exige ≥2 gestores NOMEADOS: com um só, a saída dele
  -- (férias, desligamento, conta suspensa) tranca a gestão de acesso da empresa —
  -- e o anti-lockout do banco impede até de consertar por dentro.
  IF v_gestores < 2 THEN
    RAISE EXCEPTION '[perm] só % staff ativo com permission_management:write — o procedimento de acesso urgente exige ao menos 2 gestores nomeados', v_gestores;
  END IF;

  IF v_marcador IS NULL THEN
    RAISE EXCEPTION '[perm] marcador permission_groups_migrated ausente em iam.rollout_state — a migração de dados não rodou (ou não marcou) neste ambiente';
  END IF;

  RAISE NOTICE '[perm] GATE OK — pode virar PERMISSION_ENGINE_ENABLED neste ambiente';
END
$$;

-- Saída legível para o diário: quem tem o quê, hoje.
SELECT u.firebase_uid,
       u.role,
       u.status,
       COALESCE(ARRAY(
         SELECT g.name FROM iam.user_groups ug
           JOIN iam.permission_groups g ON g.id = ug.group_id AND g.archived_at IS NULL
          WHERE ug.user_id = u.firebase_uid AND ug.removed_at IS NULL
          ORDER BY 1), '{}') AS grupos,
       iam.effective_countries(u.firebase_uid, iam.current_tenant_id()) AS paises,
       cardinality(iam.effective_permissions(u.firebase_uid, iam.current_tenant_id())) AS celulas
  FROM users u
 WHERE u.status = 'ACTIVE'
   AND u.role IN ('admin', 'recruiter', 'community_manager')
 ORDER BY u.role, u.firebase_uid;
