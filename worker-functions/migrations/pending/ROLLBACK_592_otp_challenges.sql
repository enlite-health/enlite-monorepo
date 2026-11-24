-- ROLLBACK_592_otp_challenges.sql — par de rollback da migration 592 (spec 077, D758).
--
-- Mora em `migrations/pending/` (sem número): o runner só lê `migrations/` sem recursão. Só roda apontado:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_592_otp_challenges.sql
-- Derruba a tabela (índice e CHECKs vão junto). Códigos pendentes se perdem: quem pediu código pede outro.
DROP TABLE IF EXISTS otp_challenges;
