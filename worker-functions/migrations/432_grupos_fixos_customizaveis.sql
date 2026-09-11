-- 432 — Recrutador, Community Manager e Financeiro deixam de ser grupos de sistema (PR-8a, US-19, SUP-29)
--
-- POR QUÊ (D285, `#DEC-17` ~5810 da planning 09/09; `plan.md` §432 do data-model): a F11 caiu —
-- não existe mais "proposta de grupos validada pelo time" desenhada por migration. O que fica FIXO
-- são as 4 CONTAS (D285: gabriel.g.stein@gmail.com, marcel@, diego.trevisan@, javier.bernal@enlite.health),
-- não os grupos do seed 206. Dos 5 grupos semeados como `is_system=true`, só Acesso Master e Super
-- Admin continuam travados (FR-701) — o resto (Recrutador, Community Manager, Financeiro) o time
-- edita pelo painel a partir de agora.
--
-- O QUE FAZ: `UPDATE ... SET is_system = false` nos 3 grupos nomeados, só onde `is_system` já era
-- `true` (idempotente — rodar 2x não muda nada na 2ª). Roda nas DUAS formas físicas da tabela
-- (data-model.md §432): `iam.permission_groups` (stage, pós-274) e `public.permission_groups`
-- (PRD, ainda no seed 206 cru) — cada bloco só age se a tabela existir, com `IF EXISTS` no
-- `to_regclass`, no molde da 274.
--
-- O QUE NÃO FAZ: não muda NENHUMA filiação (`user_groups`/`group_permissions`) — só a flag
-- `is_system`. FR-702 exige contagem de membros igual antes/depois; o teste e2e
-- (`iam-permissions-usecases.test.ts`) mede isso.
--
-- ROLLBACK: `UPDATE ... SET is_system = true WHERE name IN (...)` nas mesmas tabelas — reversível
-- sem perda de dado (nenhuma linha morre, só a flag volta).

BEGIN;

DO $$
DECLARE
  v_before INT;
  v_after  INT;
BEGIN
  IF to_regclass('iam.permission_groups') IS NOT NULL THEN
    SELECT count(*) INTO v_before FROM iam.user_groups ug
      JOIN iam.permission_groups g ON g.id = ug.group_id
     WHERE g.name IN ('Recrutador', 'Community Manager', 'Financeiro') AND ug.removed_at IS NULL;

    UPDATE iam.permission_groups
       SET is_system = false
     WHERE is_system = true
       AND name IN ('Recrutador', 'Community Manager', 'Financeiro');

    SELECT count(*) INTO v_after FROM iam.user_groups ug
      JOIN iam.permission_groups g ON g.id = ug.group_id
     WHERE g.name IN ('Recrutador', 'Community Manager', 'Financeiro') AND ug.removed_at IS NULL;

    IF v_before IS DISTINCT FROM v_after THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = format('[432] contagem de membros mudou em iam.permission_groups: antes=%s depois=%s — a migration só pode tocar is_system', v_before, v_after);
    END IF;

    RAISE NOTICE '[432] iam.permission_groups: membros dos 3 grupos antes=% depois=% (idênticos, só is_system mudou)', v_before, v_after;
  END IF;

  IF to_regclass('public.permission_groups') IS NOT NULL
     -- a view de compatibilidade da 274 também se chama `public.permission_groups`
     -- (SELECT-only, sem coluna própria) — só age aqui se for TABELA de verdade (PRD, seed 206 cru).
     AND EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'permission_groups' AND c.relkind = 'r'
     )
  THEN
    SELECT count(*) INTO v_before FROM public.user_groups ug
      JOIN public.permission_groups g ON g.id = ug.group_id
     WHERE g.name IN ('Recrutador', 'Community Manager', 'Financeiro');

    UPDATE public.permission_groups
       SET is_system = false
     WHERE is_system = true
       AND name IN ('Recrutador', 'Community Manager', 'Financeiro');

    SELECT count(*) INTO v_after FROM public.user_groups ug
      JOIN public.permission_groups g ON g.id = ug.group_id
     WHERE g.name IN ('Recrutador', 'Community Manager', 'Financeiro');

    IF v_before IS DISTINCT FROM v_after THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = format('[432] contagem de membros mudou em public.permission_groups: antes=%s depois=%s', v_before, v_after);
    END IF;

    RAISE NOTICE '[432] public.permission_groups: membros dos 3 grupos antes=% depois=% (idênticos, só is_system mudou)', v_before, v_after;
  END IF;
END
$$;

COMMIT;
