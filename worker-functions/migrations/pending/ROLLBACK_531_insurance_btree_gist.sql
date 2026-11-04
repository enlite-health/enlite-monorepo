-- ROLLBACK_531_insurance_btree_gist.sql — par de rollback da migration 531 (spec 058 Parte A).
-- Rodar SÓ depois dos rollbacks 537 e 536 (os EXCLUDE dependem da extensão). Sem CASCADE de propósito: se algo ainda
-- depende (ex.: `csa_sem_sobreposicao` da 529 na stage), o DROP falha em vez de apagar a constraint dos outros.
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_531_insurance_btree_gist.sql
DROP EXTENSION IF EXISTS btree_gist;
