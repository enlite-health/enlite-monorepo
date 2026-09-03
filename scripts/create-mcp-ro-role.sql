-- scripts/create-mcp-ro-role.sql — a role do MCP (db.query.readonly) lê tudo, MENOS texto clínico.
--
-- POR QUE EXISTE (D216 · D218, ebrain, 29/08/2026; lex CONDICIONADO C1-C11 na mesma data):
--   `enlite_mcp_ro` foi criada à mão em prod como membro de `pg_read_all_data` — nenhum arquivo do
--   repo a definia. Qualquer SQL ad-hoc do conector claude.ai lia `patients.diagnosis` e
--   `additional_comments` em claro — texto clínico identificável, item 2 da Regra de Classificação
--   de Dados (camada fixa, fora do alcance de emenda). Denylist por regex não sobrevive a `SELECT *`.
--   O controle desce para o dado: a role perde `pg_read_all_data`, ganha SELECT explícito nas tabelas
--   de hoje e, nas tabelas com texto clínico, SELECT POR COLUNA. NÃO há ALTER DEFAULT PRIVILEGES:
--   tabela nova nasce INVISÍVEL à role (lex C6 — migration roda como enlite_app; esquecer o GRANT
--   falha em voz alta, conceder por default falha em silêncio). Coluna nova também nasce invisível.
--   A view `patients_ro` devolve as colunas permitidas + METADADO do texto (has_*, *_len) — item 1
--   da Regra ("contagem, flag, agregado: sempre") continua inteiro para o time.
--
-- USO — SEMPRE numa transação (-1): se uma coluna não existir, nada muda (lex C4).
--   Ensaio (réplica local, porta 5437):
--     PGPASSWORD=local psql -h 127.0.0.1 -p 5437 -U postgres -d enlite_ar -v VERBOSITY=terse -1 -f scripts/create-mcp-ro-role.sql
--   Produção (superuser via cloud-sql-proxy de prd, porta 5436) — ato do Gabriel:
--     psql "host=127.0.0.1 port=5436 dbname=enlite_ar user=postgres" -v VERBOSITY=terse -1 -f scripts/create-mcp-ro-role.sql
--   Sem `-v mcp_ro_password=...` a senha NÃO é tocada (a role já existe em prod, secret enlite-mcp-ro-db-password).
--
-- IDEMPOTENTE. Roda ANTES e DEPOIS da migration que cria `patients.emergency_instructions` (a view
-- inclui has_/len dessa coluna só se ela existir; re-rodar após a migration a acrescenta).
--
-- PROVA (como enlite_mcp_ro) — saída literal exigida, senão não foi aplicado:
--   SELECT * FROM patients LIMIT 1;                        -- ERROR: permission denied for table patients
--   SELECT diagnosis FROM patients LIMIT 1;                -- ERROR: permission denied for table patients
--   SELECT count(to_jsonb(p)) FROM patients p;             -- ERROR (to_jsonb precisa da linha inteira)
--   SELECT description FROM job_postings LIMIT 1;          -- ERROR: permission denied for table job_postings
--   SELECT count(*) FROM patients;                         -- um número (count(*) NÃO exige coluna: passa, e é item 1)
--   SELECT count(*) FILTER (WHERE has_diagnosis) FROM patients_ro;  -- um número
--   SELECT count(*) FROM job_postings;                     -- um número (colunas não clínicas seguem)
-- CONTROLE POSITIVO (D157), como superuser:
--   GRANT SELECT (diagnosis) ON patients TO enlite_mcp_ro;  → a 2ª prova passa;  REVOKE → nega de novo.
--   CREATE TABLE t_c6(x int) como enlite_app → has_table_privilege('enlite_mcp_ro','t_c6','SELECT') = f.
-- PROVA DE PRIVILÉGIO RESIDUAL (lex C1), como superuser, tem de vir VAZIA:
--   SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles g ON g.oid=m.member WHERE g.rolname='enlite_mcp_ro';
--
-- ROLLBACK (lex C5) — nunca re-conceder pg_read_all_data; reabrir só o que for decidido, por nome:
--   GRANT SELECT (diagnosis) ON public.patients TO enlite_mcp_ro;          -- exemplo, uma coluna
--   GRANT SELECT ON public.job_postings TO enlite_mcp_ro;                    -- exemplo, uma tabela inteira
--   DROP VIEW IF EXISTS public.patients_ro;                                  -- se a view atrapalhar
--
-- DÍVIDAS NOMEADAS (fora deste script): lex C10 — quando a F1 ligar RLS em `patients`, a view (dona
-- enlite_app) ignora RLS: filtrar país DENTRO da view · C7 — descrição da tool aponta `patients_ro`
-- (branch feat/req01) · C8 — linha do conector claude.ai no registro-operacoes.md (Gabriel/Marcel).

\set ON_ERROR_STOP on
\set VERBOSITY terse

-- 1. A role existe; senha só se fornecida (variável de psql não entra em bloco DO — por isso \gexec).
\if :{?mcp_ro_password}
SELECT format('CREATE ROLE enlite_mcp_ro WITH LOGIN PASSWORD %L', :'mcp_ro_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enlite_mcp_ro') \gexec
ALTER ROLE enlite_mcp_ro WITH LOGIN PASSWORD :'mcp_ro_password';
\else
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enlite_mcp_ro') THEN
    RAISE EXCEPTION 'enlite_mcp_ro não existe e nenhuma senha foi passada (-v mcp_ro_password=...)';
  END IF;
END
$$;
\endif

-- 2. Sai do privilégio herdado: privilégio é aditivo, REVOKE de coluna não vence pg_read_all_data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
              JOIN pg_roles g ON g.oid = m.member
             WHERE g.rolname = 'enlite_mcp_ro' AND r.rolname = 'pg_read_all_data') THEN
    REVOKE pg_read_all_data FROM enlite_mcp_ro;
  END IF;
END
$$;

-- 3. Leitura explícita das tabelas DE HOJE (item 1). Sem ALTER DEFAULT PRIVILEGES (lex C6):
--    tabela nova exige GRANT nomeado na própria migration — a regra da F1 (D216 3b).
--    O banco é o corrente (enlite_ar em prod, enlite_e2e no stack do e2e) — o e2e
--    tests/e2e/mcp-ro-role.e2e.test.ts aplica este MESMO arquivo e prova a negação.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO enlite_mcp_ro', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO enlite_mcp_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO enlite_mcp_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO enlite_mcp_ro;
--    Desfaz qualquer default privilege que exista (versão anterior deste script, ou concessão à mão):
--    medido no ensaio 29/08 — o default gravado antes fazia tabela nova nascer visível mesmo sem
--    a linha no script. Sem isto, "não criar" não basta. Só para as roles que EXISTEM neste
--    banco (no stack do e2e não há enlite_app nem postgres; ALTER DEFAULT PRIVILEGES FOR ROLE
--    inexistente aborta a transação inteira).
DO $$
DECLARE dona text;
BEGIN
  FOR dona IN SELECT rolname FROM pg_roles WHERE rolname IN ('enlite_app', 'postgres') LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT ON TABLES FROM enlite_mcp_ro', dona);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT ON SEQUENCES FROM enlite_mcp_ro', dona);
  END LOOP;
END
$$;

-- 4. `patients`: SELECT por coluna. Lista POSITIVA — o que não está aqui, a role não vê.
--    Fora (item 2, texto clínico livre): diagnosis, additional_comments, emergency_instructions.
--    Fora (OP-04.a, D218 bônus): insurance_verified (afiliação sindical) e device_type (regime de
--    internação) — a nossa OP-04.a já os classifica como sensíveis.
--    Fora (spec 012, lex C7.1-d / B9 / C3): on_hold_note (texto clínico), on_hold_reason,
--    service_start_date, admission_status — coluna nova em `patients` nasce invisível: NÃO listar.
--    Rótulos de catálogo ficam (dependency_level, clinical_specialty, service_type, attention_reasons:
--    ≤9 valores distintos, ≤35 chars, medido em prod 29/08 — item 1).
REVOKE SELECT ON public.patients FROM enlite_mcp_ro;
GRANT SELECT (
  id, clickup_task_id, case_number, origin, status, country, is_test, created_at, updated_at, deleted_at,
  dependency_level, clinical_segments, service_type, clinical_specialty, needs_attention, attention_reasons,
  has_judicial_protection, has_cud, has_consent, insurance_informed, health_insurance_name,
  city_locality, province, zone_neighborhood
  -- ── C9 (D218, ratificada pelo Gabriel em 30/08): SEM identificação. Fora: first_name, last_name,
  -- birth_date, document_type, document_number, affiliate_id, sex, phone_whatsapp,
  -- health_insurance_member_id, contact_email_encrypted. Os ponteiros id / case_number /
  -- clickup_task_id dizem ao agente do claude.ai QUAL caso é e ONDE está no ClickUp — sem a pessoa.
) ON public.patients TO enlite_mcp_ro;

-- 5. Tabelas irmãs com texto clínico livre (lex C11 · D218): SELECT por coluna, lista GERADA do
--    catálogo em tempo de aplicação (não digitada). O que está em `excluir` a role não vê; coluna
--    nova nessas tabelas também nasce invisível (grant de coluna não se estende).
--    Tabelas inteiras sensíveis (OP-04.a) perdem SELECT se existirem.
DO $$
DECLARE
  alvo RECORD;
  cols text;
BEGIN
  FOR alvo IN
    SELECT * FROM (VALUES
      ('job_postings',              ARRAY['description','diagnosis','last_clickup_comment']),
      ('job_postings_clickup_sync', ARRAY['last_clickup_comment']),
      ('job_posting_comments',      ARRAY['comment_text']),
      ('publications',              ARRAY['observations']),
      ('worker_placement_audits',   ARRAY['observations','patient_raw_name']),
      ('worker_job_applications',   ARRAY['internal_notes']),
      ('interview_slots',           ARRAY['notes']),  -- lex M2: entrevista de matching fala de patologia
      -- spec 012 (lex C2.1): `access_notes` é texto livre sobre o DOMICÍLIO de um paciente. A tabela
      -- tinha GRANT de tabela inteira — a coluna nova (mig 316) nasceria legível pelo LLM no dia 1.
      ('patient_addresses',         ARRAY['access_notes']),
      -- spec 013 bloco C (QA-caça #1, mesma classe D216/D218): `professional_profile` (texto livre
      -- sobre o profissional buscado) e `hourly_value` (preço do contrato, lex C-c) da 319 tinham
      -- GRANT de tabela inteira via "ALL TABLES" — legíveis pelo MCP no dia 1. As 3 tabelas irmãs
      -- (318/319) entram nominalmente mesmo as sem texto/valor a excluir: GRANT por coluna (em vez
      -- do "ALL TABLES" implícito) garante que coluna nova nasça invisível também aqui (mesma razão
      -- do C6 para tabela nova).
      ('patient_contracted_services', ARRAY['professional_profile','hourly_value']),
      ('contracted_service_providers', ARRAY[]::text[]),
      ('contracted_service_devices',   ARRAY[]::text[]),
      ('service_types',                ARRAY[]::text[])
    ) AS t(tabela, excluir)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = alvo.tabela AND table_type = 'BASE TABLE') THEN
      RAISE NOTICE 'tabela % não existe aqui — pulada', alvo.tabela;
      CONTINUE;
    END IF;
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = alvo.tabela
       AND NOT (column_name = ANY (alvo.excluir));
    EXECUTE format('REVOKE SELECT ON public.%I FROM enlite_mcp_ro', alvo.tabela);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO enlite_mcp_ro', cols, alvo.tabela);
  END LOOP;
  FOR alvo IN SELECT unnest(ARRAY['patient_insurance_verified','patient_device_types']) AS tabela LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=alvo.tabela) THEN
      EXECUTE format('REVOKE SELECT ON public.%I FROM enlite_mcp_ro', alvo.tabela);
    END IF;
  END LOOP;
  -- lex M3: matview não entra em "ALL TABLES" — conceder por nome (item 1), nunca via pg_read_all_data.
  IF EXISTS (SELECT 1 FROM pg_class WHERE relkind='m' AND relname='worker_eligibility' AND relnamespace='public'::regnamespace) THEN
    EXECUTE 'GRANT SELECT ON public.worker_eligibility TO enlite_mcp_ro';
  END IF;
  -- lex B2, DENTRO da transação: se alguma tabela irmã ficou com SELECT de tabela inteira (nome errado,
  -- tabela pulada), o script inteiro reverte. Fail-closed no único ponto que era fail-open.
  FOR alvo IN SELECT unnest(ARRAY['patients','job_postings','job_postings_clickup_sync','job_posting_comments',
                                  'publications','worker_placement_audits','worker_job_applications','interview_slots',
                                  'patient_addresses','patient_contracted_services','contracted_service_providers',
                                  'contracted_service_devices','service_types']) AS tabela LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=alvo.tabela)
       AND has_table_privilege('enlite_mcp_ro', format('public.%I', alvo.tabela), 'SELECT') THEN
      RAISE EXCEPTION 'B2: enlite_mcp_ro ainda tem SELECT de TABELA em % — abortando a transação', alvo.tabela;
    END IF;
  END LOOP;
END
$$;

-- 6. `patients_ro`: colunas permitidas + metadado do texto clínico. Dona = enlite_app, então a view
--    calcula has_/len sem a role ver o texto. security_barrier impede função em WHERE de ver a linha
--    antes do filtro. Nome ≠ tabela de propósito (D187). ⚠️ lex C10: a dona ignora RLS — quando a F1
--    ligar RLS de país em patients, filtrar país AQUI.
DO $$
DECLARE
  tem_emerg boolean;
  extra text := '';
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='patients' AND column_name='emergency_instructions')
    INTO tem_emerg;
  IF tem_emerg THEN
    extra := ', (emergency_instructions IS NOT NULL AND emergency_instructions <> '''') AS has_emergency_instructions'
          || ', coalesce(length(emergency_instructions),0) AS emergency_instructions_len';
  END IF;
  EXECUTE 'DROP VIEW IF EXISTS public.patients_ro';
  EXECUTE 'CREATE VIEW public.patients_ro WITH (security_barrier) AS SELECT '
       || 'id, clickup_task_id, case_number, origin, status, country, is_test, created_at, updated_at, deleted_at, '
       || 'dependency_level, clinical_segments, service_type, clinical_specialty, needs_attention, attention_reasons, '
       || 'has_judicial_protection, has_cud, has_consent, insurance_informed, health_insurance_name, '
       || 'city_locality, province, zone_neighborhood, '
       -- C9 (30/08): sem identificação — a view é "patients de-identificado + metadado do texto clínico".
       || '(diagnosis IS NOT NULL AND diagnosis <> '''') AS has_diagnosis, '
       || 'coalesce(length(diagnosis),0) AS diagnosis_len, '
       || '(additional_comments IS NOT NULL AND additional_comments <> '''') AS has_additional_comments, '
       || 'coalesce(length(additional_comments),0) AS additional_comments_len'
       || extra
       || ' FROM public.patients';
  -- Dona = enlite_app onde ela existe (prod); no stack do e2e não há enlite_app e a view fica
  -- com quem rodou o script (superuser) — a semântica (has_/len sem o texto) é a mesma.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enlite_app') THEN
    EXECUTE 'ALTER VIEW public.patients_ro OWNER TO enlite_app';
  END IF;
  EXECUTE 'REVOKE ALL ON public.patients_ro FROM PUBLIC';
  EXECUTE 'GRANT SELECT ON public.patients_ro TO enlite_mcp_ro';
END
$$;

COMMENT ON VIEW public.patients_ro IS
  'Leitura do MCP (db.query.readonly): patients SEM texto clínico (diagnosis, additional_comments, emergency_instructions) nem insurance_verified/device_type; has_*/*_len são metadado (item 1 da Regra). SEM identificação (C9 ratificada 30/08): ponteiros id/case_number/clickup_task_id. D216/D218, 29-30/08/2026.';
