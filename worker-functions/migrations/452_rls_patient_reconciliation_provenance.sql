BEGIN;

-- ================================================================
-- Migration 452: liga RLS de país nas 3 tabelas de patient-fonte-da-verdade
-- (spec 003) que têm FK para `patients` (achado do gate revisao-pr no PR #429,
-- sync main→stage 19/09/2026)
-- ================================================================
-- Context: `tests/e2e/country-rls-policies.test.ts` ("invariante: TODA tabela
-- com FK para patients tem RLS ligada") ficou vermelho no merge main→stage:
-- as migrations 439-441 (spec 003, nasceram no `main`, que não tem RLS em
-- lugar nenhum) declaram a policy de país mas DELIBERADAMENTE não ligam RLS —
-- o comentário de cada uma diz "inerte: RLS não é habilitada fora do QA —
-- plano F1" (specs/003/lex-veredito.md, C1). Isso é coerente no `main`; na
-- `stage`, onde o invariante do e2e é vira lei, é um buraco real: sem RLS,
-- qualquer conexão como app_runtime/app_system lê as 3 tabelas cross-país.
--
-- As 3 tabelas com FK para patients (conferido em pg_constraint, é o MESMO
-- critério do e2e):
--   · patient_identity_links.patient_id            (ON DELETE SET NULL)
--   · patient_identity_links.candidate_patient_id   (ON DELETE SET NULL)
--   · patient_reconciliation_items.patient_id       (NOT NULL, ON DELETE CASCADE)
--   · patient_field_provenance.patient_id           (NOT NULL, ON DELETE CASCADE)
--
-- MECANISMO — por que NÃO é o molde `_follow_patient` da 413/271/416 (EXISTS no
-- pai) e SIM `iam.session_may_see_country` (411) direto na coluna `country` da
-- própria tabela:
--   1. `patient_identity_links.patient_id` é NULLABLE por desenho (match_key
--      'NONE' = "só existe na fonte, ainda sem pessoa" — comentário da 439). Um
--      EXISTS(SELECT 1 FROM patients WHERE id = patient_id) esconderia TODA
--      linha ainda não casada com paciente nenhum, para QUALQUER staff — mesmo
--      o do país certo. O follow-the-parent pressupõe pai sempre presente
--      (verdade nas satélites de 271/413/416: patient_id NOT NULL); aqui não é.
--   2. As 3 tabelas já nascem com `country TEXT NOT NULL` SEM default —
--      exatamente para isto (lex C1: "country NOT NULL sem default + policy
--      declarada (inerte)"). A coluna existe PARA a RLS decidir sozinha, sem
--      depender de um join que pode não ter pai.
--   3. Resultado: a MESMA função e a MESMA forma de `patients_country_isolation`
--      (411) — sistema por role+GUC, senão `iam.session_may_see_country`
--      (gate de role, claim opcional, grant de grupo, tudo já centralizado lá)
--      — só trocando `patients.country` pela coluna própria de cada tabela.
--      Não é policy ad hoc nova: é o MESMO predicado, a mesma função, os
--      mesmos GRANTs de EXECUTE (já concedidos a PUBLIC pela 411 — nada a
--      reconceder aqui).
--
-- GRANTs de tabela (SELECT/INSERT/UPDATE/DELETE a app_runtime/app_system): já
-- existem — herdados do `ALTER DEFAULT PRIVILEGES IN SCHEMA public` da 269,
-- que vale para toda tabela criada pelo MESMO owner depois dela (439-441 são
-- posteriores). Conferido no e2e desta migration com `has_table_privilege`;
-- nada é re-concedido aqui para não mascarar uma regressão real do default
-- privilege devesse ter falhado.
--
-- SEM FORCE (mesmo motivo da 271/411/413): o owner das tabelas (`enlite_app`
-- em prod, `enlite_admin` no e2e) não tem BYPASSRLS mas TAMBÉM não é afetado
-- por RLS sem FORCE — o comportamento de prod/stage-como-owner fica
-- inalterado; só conexões como app_runtime/app_system passam a ser filtradas.
-- O e2e trava a invariante "nenhuma tabela da leva tem FORCE" para o schema
-- inteiro — não é preciso repetir aqui, só não introduzir.
--
-- Idempotente: DROP POLICY IF EXISTS antes de recriar; ENABLE ROW LEVEL
-- SECURITY é idempotente por natureza.
--
-- PROVA: tests/e2e/country-rls-policies.test.ts (a invariante de FK↔RLS) e
-- migração aplicada localmente contra Postgres real via
-- scripts/run-migrations-docker.js.
-- ================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'patient_identity_links',
    'patient_reconciliation_items',
    'patient_field_provenance'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Derruba a policy ad hoc inerte declarada nas 439/440/441
    -- (`country = current_setting('app.country', true)`) — nunca esteve ativa
    -- (RLS não estava ligada), mas o nome colide com a policy nova.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_country', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (
         (
           NULLIF(current_setting(''app.system_context'', true), '''') IS NOT NULL
           AND pg_has_role(current_user, ''app_system'', ''MEMBER'')
         )
         OR iam.session_may_see_country(%I.country, current_user, true)
       )',
      t || '_country', t, t
    );
  END LOOP;
END
$$;

COMMENT ON POLICY patient_identity_links_country ON patient_identity_links IS
  '452: país decidido pela COLUNA PRÓPRIA (patient_id é nullable — link pode ainda não ter casado com paciente), via iam.session_may_see_country (411). Substitui a policy ad hoc inerte da 439.';
COMMENT ON POLICY patient_reconciliation_items_country ON patient_reconciliation_items IS
  '452: país decidido pela COLUNA PRÓPRIA, via iam.session_may_see_country (411) — mesmo mecanismo de patients (consistência entre as 3 tabelas da leva, mesmo com patient_id NOT NULL aqui). Substitui a policy ad hoc inerte da 440.';
COMMENT ON POLICY patient_field_provenance_country ON patient_field_provenance IS
  '452: país decidido pela COLUNA PRÓPRIA, via iam.session_may_see_country (411) — mesmo mecanismo de patients. Substitui a policy ad hoc inerte da 441.';

COMMIT;
