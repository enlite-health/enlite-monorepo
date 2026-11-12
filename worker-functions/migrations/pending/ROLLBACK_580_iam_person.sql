-- ROLLBACK_580_iam_person.sql — par de rollback da migration 580 (spec acesso-do-cliente, F1).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho.
-- ⚠️ Só vale ANTES de existir iam.area_membership (580+1) e de os ganchos de merge estarem no código:
-- depois disso apagar a pessoa derruba a FK e o gancho. Apaga as pessoas/logins (a trilha de identidade).
DROP FUNCTION IF EXISTS iam._backfill_person();
DROP FUNCTION IF EXISTS iam.remove_login(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS iam.unmerge_person(BIGINT);
DROP FUNCTION IF EXISTS iam.merge_person(TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS iam._merge_roots(TEXT, TEXT, BIGINT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS iam.ensure_person(TEXT, TEXT);
DROP FUNCTION IF EXISTS iam.person_login_uids(UUID);
DROP FUNCTION IF EXISTS iam.person_tree(UUID);
DROP FUNCTION IF EXISTS iam.person_root(UUID);
DROP FUNCTION IF EXISTS iam.resolve_person(TEXT, TEXT);
DROP FUNCTION IF EXISTS iam._is_synthetic_uid(TEXT);
DROP TABLE IF EXISTS iam.person_login;
DROP TABLE IF EXISTS iam.person;
DROP FUNCTION IF EXISTS iam._person_login_guard();
DROP FUNCTION IF EXISTS iam._person_guard();
DROP FUNCTION IF EXISTS iam._person_no_delete();
