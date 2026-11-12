-- Migration 568: o DONO de `agentes.veredictos` volta a poder validar a FK dos achados (spec 078, notário/juiz/validador)
--
-- Defeito medido em prd (30/10 → 04/11/2026): `agentes.veredicto.registrar` com achados morria com
-- `permission denied for table veredictos` (36/36 erros têm achados; 32/32 sucessos têm achados = []);
-- `agentes.veredicto_achados` tem 0 linhas em prd desde que nasceu.
--
-- Causa: a checagem de FK do Postgres (`RI_FKey_check`) roda `SELECT 1 FROM ONLY agentes.veredictos x WHERE id = $1
-- FOR KEY SHARE OF x` COMO O DONO da tabela referenciada — e `FOR KEY SHARE` exige o privilégio UPDATE. A 551 fez
-- `REVOKE UPDATE … ON ALL TABLES IN SCHEMA agentes FROM enlite_app`, e em prd `enlite_app` é o executor das migrations
-- E o dono das tabelas: o dono perdeu o UPDATE de si mesmo e, com ele, a capacidade de validar qualquer FK que aponte
-- para `veredictos`. O INSERT na própria `veredictos` passa (só pede INSERT); o do primeiro achado morre na FK.
-- CI e suítes locais rodam como superuser (dono superuser não passa por ACL) — a classe é invisível antes de prd.
--
-- Conserto mínimo: `UPDATE` só na COLUNA `id`, só para o DONO. Basta: com o conjunto de colunas atualizadas vazio
-- (caso do `FOR KEY SHARE`), o Postgres aceita UPDATE em QUALQUER coluna. Não reabre o INSERT-only da 551:
--   - app_runtime/app_system/enlite_runtime/enlite_system não ganham nada;
--   - o dono segue sem UPDATE em qualquer outra coluna e sem DELETE/TRUNCATE (provado no e2e
--     `agentes-veredicto-fk-dono-078`); `id` referenciado por achado não muda (FK NO ACTION recusa).
-- O DONO é lido do catálogo (não é nome fixo): é o papel que a checagem de FK usa, seja qual for o login do app.
--
-- Escopo: SÓ `veredictos` (o defeito nomeado). As outras tabelas referenciadas do schema (`reportes`, `pedidos`,
-- `pedido_atitudes`) têm o mesmo defeito latente — ficam para decisão própria.
-- Idempotente (GRANT repetido é no-op). Sem BEGIN/COMMIT próprio (o runner envolve).
-- Rollback: `migrations/pending/ROLLBACK_568_078_veredictos_fk_check_do_dono.sql`.

DO $$
DECLARE
  dono text := pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'agentes.veredictos'::regclass));
BEGIN
  EXECUTE format('GRANT UPDATE (id) ON agentes.veredictos TO %I', dono);
END $$;
