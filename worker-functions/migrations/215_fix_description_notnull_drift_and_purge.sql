-- Migration 215: reconcilia drift de schema em job_postings.description + purga PII.
--
-- CONTEXTO: a migration 058 (DROP NOT NULL em description) nunca foi aplicada em
-- PRODUÇÃO (prd é migrado manualmente). Em prod a coluna seguia NOT NULL, o que:
--   1. Fez a migration 214 (UPDATE ... SET NULL) falhar por violar NOT NULL —
--      a transação reverteu, nenhuma linha foi alterada.
--   2. Quebraria a criação de vagas após o deploy do PR #66, que removeu
--      `description` dos INSERTs (coluna NOT NULL sem default → violação).
--
-- Esta migration:
--   1. Torna `description` nullable (alinha prod ao estado já vigente em 058/local
--      e destrava os INSERTs que não passam mais a coluna).
--   2. Purga fisicamente a PII (UPDATE ... SET NULL) — agora permitido.
--
-- Idempotente: DROP NOT NULL em coluna já nullable é no-op; o UPDATE só toca
-- linhas ainda não nulas.

ALTER TABLE job_postings ALTER COLUMN description DROP NOT NULL;

UPDATE job_postings SET description = NULL WHERE description IS NOT NULL;
