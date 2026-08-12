-- 258_merge_audit_moved_fields_and_reparent_counts.sql
--
-- Fundação do vínculo self-service de contas (openspec: vinculo-contas-colisao-telefone).
--
-- fields_moved: campos de identidade únicos MOVIDOS do absorvido pro sobrevivente
--   (phone/phone_encrypted/whatsapp_phone_encrypted/ana_care_id). Diferente de
--   fields_filled (coalesce): mover exige limpar o casco antes, porque
--   idx_workers_phone_unique e idx_workers_ana_care_id_unique não filtram
--   merged_into_id (caso Edith, 04/08).
--
-- rows_reparented: contagem de LINHAS reparentadas por tabela (não de tabelas)
--   — alimenta o resumo "recuperamos N postulações" do fluxo self-service.

ALTER TABLE worker_merge_audit
  ADD COLUMN IF NOT EXISTS fields_moved JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE worker_merge_audit
  ADD COLUMN IF NOT EXISTS rows_reparented JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN worker_merge_audit.fields_moved IS
  'Campos de identidade únicos movidos absorvido→sobrevivente (limpando o casco antes, mesma tx)';
COMMENT ON COLUMN worker_merge_audit.rows_reparented IS
  'Linhas reparentadas por tabela FK (ex.: {"worker_job_applications": 2})';
