-- 324 — revoga o `ALTER DEFAULT PRIVILEGES` da 323 (spec 016, F1.5, D261 — item C4 do parecer do CTO)
--
-- ── O que a 323 fez, e por que a linha 202-205 dela é uma concessão ABERTA NO TEMPO ─────────
-- A 323 (`GRANT SELECT ON ALL TABLES IN SCHEMA terminology TO enlite_mcp_ro`) já resolve o
-- PRESENTE: as 3 tabelas que existem hoje (`icd_releases`, `icd_entities`, `icd_synonyms`) ficam
-- legíveis pelo conector claude.ai — decisão correta, documentada na 323 (schema é dado público
-- da OMS, não PHI). O problema é a linha seguinte:
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE <current_user> IN SCHEMA terminology
--     GRANT SELECT ON TABLES TO enlite_mcp_ro;
--
-- Isso não é sobre as tabelas de hoje — é uma REGRA PERMANENTE: qualquer tabela nova que o MESMO
-- role vier a criar neste schema, no futuro, nasce automaticamente legível pelo `enlite_mcp_ro`,
-- SEM revisão nenhuma no momento em que essa tabela é criada. `governanca/classificacao-de-
-- dados` item 4 é exatamente o oposto disso: toda concessão de leitura ao conector passa por
-- decisão EXPLÍCITA por tabela, no momento em que a tabela nasce — nunca por herança automática
-- de uma regra de anos atrás que ninguém mais está olhando.
--
-- ── Por que revogar e não só "não usar mais" ────────────────────────────────────────────────
-- Um default privilege não documentado em nenhum GRANT explícito é fácil de esquecer que existe
-- — a próxima tabela deste schema (ex.: uma futura `icd_release_notes` ou similar) nasceria
-- legível sem ninguém ter escrito um GRANT para ela, e sem ninguém perceber a ausência de
-- revisão. Revogar aqui faz o comportamute PADRÃO voltar a ser "nova tabela NÃO é legível até
-- alguém decidir e commitar um GRANT explícito" — o mesmo princípio de deny-by-default que o
-- resto do banco usa por coluna (`create-mcp-ro-role.sql`), agora também por TABELA neste schema.
--
-- ── O que este arquivo NÃO faz ───────────────────────────────────────────────────────────────
-- Não revoga o GRANT já concedido nas 3 tabelas existentes (linha 201 da 323) — elas continuam
-- legíveis, é o comportamento correto e já decidido. Só o "default" (a promessa automática para
-- tabela FUTURA) é revogado. Se uma tabela nova do schema `terminology` precisar ser legível pelo
-- conector, uma migration futura faz `GRANT SELECT ON <tabela nova> TO enlite_mcp_ro` — explícito,
-- revisável no PR daquela migration.
--
-- ── Idempotência ─────────────────────────────────────────────────────────────────────────────
-- `ALTER DEFAULT PRIVILEGES ... REVOKE` numa entrada que não existe (ou já foi revogada) não
-- lança erro — é um no-op. Guardado atrás do MESMO `IF EXISTS (SELECT ... pg_roles)` da 323,
-- pelo mesmo motivo: a role pode não ter sido criada ainda neste ambiente.
--
-- ⚠️ `FOR ROLE %I` usa `current_user` — TEM que ser o MESMO role que executou a 323 (normalmente
-- o role de migration do ambiente, ex.: `enlite_admin`), porque default privilege é escopado por
-- (schema, role-que-cria). Revogar com um role diferente do que concedeu não erra, mas também não
-- revoga nada (o registro em `pg_default_acl` fica indexado pelo role original).
--
-- Rollback: reaplicar o `ALTER DEFAULT PRIVILEGES ... GRANT` da 323 (não recomendado — é
-- exatamente a concessão aberta que esta migration existe para fechar).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enlite_mcp_ro') THEN
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA terminology REVOKE SELECT ON TABLES FROM enlite_mcp_ro',
      current_user
    );
  END IF;
END $$;
