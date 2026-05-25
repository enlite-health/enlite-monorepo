-- Migration 188: Backfill encuadres for orphan WJAs (TD-036 Fase 2)
--
-- Contexto:
--   Bug #1/#2 do POSTMORTEM_KANBAN_FUNNEL_BUGS.md: ~215 WJAs em prod sem encuadre
--   correspondente ficavam invisíveis no Kanban (fix Fase 1: query invertida).
--   Esta migration backfilla encuadres mínimos para WJAs ainda órfãs, garantindo
--   que o join LATERAL no EncuadreFunnelController encontre dados mesmo para WJAs
--   sem entrevista real.
--
-- Campos NULL intencionalmente:
--   worker_raw_name, worker_raw_phone — COALESCE com workers na query do Kanban
--   resultado — encuadre não passou por entrevista real, semanticamente correto
--   recruitment_date — não inventar data que confunda com entrevista real
--
-- Idempotente: ON CONFLICT (dedup_hash) DO NOTHING. Rodar 2x é seguro.
-- Risco: LOW. Sem ALTER TABLE, sem lock. INSERT-only.
-- Rollback manual (executar via psql se necessário):
--   SELECT id FROM encuadres WHERE import_source_audit = 'backfill-td036';
--   -- Depois remover os IDs retornados conforme necessário.

INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash)
SELECT
  wja.worker_id,
  wja.job_posting_id,
  'backfill-td036',
  md5('backfill-td036|' || wja.worker_id::text || '|' || wja.job_posting_id::text)
FROM worker_job_applications wja
WHERE NOT EXISTS (
  SELECT 1 FROM encuadres e
  WHERE e.worker_id = wja.worker_id
    AND e.job_posting_id = wja.job_posting_id
)
ON CONFLICT (dedup_hash) DO NOTHING;
