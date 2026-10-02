-- ROLLBACK_499_workers_email_nullable.sql — par de rollback da migration 499 (workers.email anulável, spec 040 F3).
--
-- Mora em `migrations/pending/` (sem número) pela mesma razão do ROLLBACK_498: o runner não lê subpastas, então
-- o arquivo fica versionado mas só roda quando alguém aponta o caminho explicitamente.
--
-- Como rodar (reversão manual e intencional):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_499_workers_email_nullable.sql
--
-- TRAVA: só roda com 0 workers sem e-mail — recolocar NOT NULL com linha NULL falharia no meio e, pior, mascarar
-- worker criado só com telefone pelo sync da Talentum. Preencha ou arquive esses cadastros antes.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM workers WHERE email IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK_499 abortado: % worker(s) sem e-mail — preencha antes de recolocar NOT NULL', n;
  END IF;
  ALTER TABLE workers ALTER COLUMN email SET NOT NULL;
END $$;
