-- 541 — DROP das 9 colunas de link de reunião da vaga (spec 068, Fase B / PR B; D537/D538).
--   meet_link_1..3, meet_datetime_1..3 (mig 098) e meet_recurring_weekday/time/link (mig 291).
--
-- Por quê: o link de reunião é do ENQUADRE (enquadre_events.meet_link, mig 518), não da vaga. O PR A (#724) já tirou todo
-- leitor e escritor do código e está em prd; esta migration só apaga as colunas, que ninguém mais lê nem escreve.
--
-- Dependências conferidas em prd e na stage (22/10/2026, catálogo, só leitura) ANTES desta migration:
--   - pg_depend: SÓ 2 constraints CHECK dependem das colunas (job_postings_meet_recurring_complete e
--     job_postings_meet_recurring_weekday_check, da mig 291). Elas são dropadas aqui, nomeadas, ANTES das colunas.
--   - 0 views, 0 matviews, 0 funções (pg_proc.prosrc), 0 policies, 0 índices e 0 publicações citam as colunas.
--   - O único trigger de job_postings (update_job_postings_updated_at) não referencia as colunas.
-- SEM CASCADE de propósito: se aparecer dependente que a conferência não viu, a migration FALHA em vez de apagar o dependente.
--
-- Rollback: migrations/pending/ROLLBACK_541_drop_job_postings_meet_link_columns.sql (recria a estrutura, NÃO o dado).
-- Sem BEGIN/COMMIT próprio (o runner envolve cada arquivo numa transação). Idempotente (IF EXISTS em tudo).
-- ⚠️ Migrations rodam no boot: o merge na `main` executa este DROP em prd. O dado (links de 122 vagas) NÃO é recuperável
-- pelo app; recuperação = backup automático do Cloud SQL.

ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS job_postings_meet_recurring_complete;
ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS job_postings_meet_recurring_weekday_check;

ALTER TABLE job_postings
  DROP COLUMN IF EXISTS meet_link_1,
  DROP COLUMN IF EXISTS meet_datetime_1,
  DROP COLUMN IF EXISTS meet_link_2,
  DROP COLUMN IF EXISTS meet_datetime_2,
  DROP COLUMN IF EXISTS meet_link_3,
  DROP COLUMN IF EXISTS meet_datetime_3,
  DROP COLUMN IF EXISTS meet_recurring_weekday,
  DROP COLUMN IF EXISTS meet_recurring_time,
  DROP COLUMN IF EXISTS meet_recurring_link;
