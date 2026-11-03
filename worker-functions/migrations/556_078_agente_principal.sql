-- Migration 556: o agente como pessoa no ABAC (spec 078, fase M2, itens 30-36)
--
-- Data: 03/11/2026. Contrato: `contratos-M2/migration-556.md` (ebrain), ajustado pelas "Decisões do lote 0" do plano-M2.
-- Seções (a ordem importa; NENHUMA FK nova, e REVOKE só sobre FUNÇÃO nova):
--   1  users.account_type aceita 'agent'                       (M2.1.1)
--   2  classe de grupo AGENT + função de células vedadas + 3 triggers   (M2.1.3)
--   3  iam.permission_audit_log: actor_kind, gatilho_id, registro_versao (M2.1.5)
--   4  seed: linha `agent:luz` e grupo AGENT "Luz — espelho Recrutador" (VAZIO) (M2.1.7)
-- Idempotente (IF NOT EXISTS / DROP ... IF EXISTS / ON CONFLICT DO NOTHING). Sem BEGIN/COMMIT próprio (o runner envolve).
-- Sem texto clínico. A migration NÃO concede célula a grupo nenhum.
-- Rollback: `migrations/pending/ROLLBACK_556_078_agente_principal.sql` (manual, destrutivo, exige backup e o "vai" do Gabriel).

-- ── 1. users.account_type aceita `agent` ─────────────────────────────────────────
-- `agent` NÃO é staff (isStaffAccount segue false: fail-closed). A ponte `account_type_for_role` (414) e o COMMENT da 414 NÃO mudam.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('staff', 'worker', 'agent'));
