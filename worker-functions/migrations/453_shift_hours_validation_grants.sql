-- 453 — GRANTs faltantes em `shift_hours_validation` (change `promocao-stage-para-main`).
--
-- Por quê: a `437_anacare_shift_hours.sql` rodou em `enlite-prd` na versão SEM GRANT explícito
-- (o `main` havia portado o arquivo removendo os GRANT — ver cabeçalho da própria 437, linhas
-- 4-9). O runner (`run-migrations-docker.js`, `sortMigrationFiles`) chaveia por NOME COMPLETO de
-- arquivo já aplicado, então a 437 nunca reaplica em prd, mesmo que a versão em `stage`/`main`
-- já tenha os GRANT. Esta migration nova fecha só essa lacuna.
--
-- NÃO inclui `anacare_shift`: a `444_drop_anacare_shift.sql` a DROPA no mesmo trem de promoção —
-- conceder GRANT numa tabela que será removida na sequência é trabalho morto.

BEGIN;

GRANT SELECT, INSERT, UPDATE ON shift_hours_validation TO app_runtime, app_system;
GRANT USAGE, SELECT ON SEQUENCE shift_hours_validation_id_seq TO app_runtime, app_system;

COMMIT;
