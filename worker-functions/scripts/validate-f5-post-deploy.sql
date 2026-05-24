-- ============================================================
-- Script de validação pós-deploy F5 (ADR-001)
-- Rodar após Migration 192 + Migration 193 + Code Deploy
-- ============================================================
-- Uso: psql $DATABASE_URL -f scripts/validate-f5-post-deploy.sql
-- Todos os resultados esperados estão nos comentários abaixo de cada query.
-- ============================================================

-- F6-Q1: Zero duplicatas
SELECT COUNT(*) FILTER (WHERE dup_count > 1) AS pares_com_duplicata,
       MAX(dup_count) AS max_duplicatas_por_par
FROM (SELECT worker_id, job_posting_id, COUNT(*) AS dup_count
      FROM encuadres WHERE worker_id IS NOT NULL AND job_posting_id IS NOT NULL
      GROUP BY worker_id, job_posting_id) t;
-- Esperado: pares_com_duplicata=0, max_duplicatas_por_par=1

-- F6-Q2: Constraint ativa
SELECT conname, contype FROM pg_constraint
WHERE conrelid = 'encuadres'::regclass AND conname = 'encuadres_worker_job_unique';
-- Esperado: 1 linha (contype='u')

-- F6-Q3: Sobreviventes com richness=0
SELECT COUNT(*) AS encuadres_richness_zero,
       COUNT(*) FILTER (WHERE origen IN ('backfill-td036','auto-trigger')) AS backfill_only
FROM encuadres
WHERE worker_id IS NOT NULL AND job_posting_id IS NOT NULL
  AND (CASE WHEN interview_date IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN resultado IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN attended IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN obs_encuadre IS NOT NULL AND obs_encuadre != '' THEN 1 ELSE 0 END +
       CASE WHEN recruiter_name IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN recruitment_date IS NOT NULL THEN 1 ELSE 0 END) = 0;
-- Informativo: encuadres sem dados operacionais (esperado: maioria = backfill_only)

-- F6-Q4: ON CONFLICT funciona (rodar com ROLLBACK automático)
BEGIN;
  INSERT INTO encuadres (worker_id, job_posting_id, origen, dedup_hash)
  SELECT worker_id, job_posting_id, 'test-conflict', md5('test-conflict|' || random()::text)
  FROM encuadres WHERE worker_id IS NOT NULL AND job_posting_id IS NOT NULL LIMIT 1
  ON CONFLICT (worker_id, job_posting_id) DO NOTHING;
ROLLBACK;
-- Esperado: INSERT 0 (conflito silencioso, ROLLBACK confirmado)

-- F6-Q5: Trigger 189 invariante WJA→encuadre
SELECT COUNT(*) AS wjas_sem_encuadre FROM worker_job_applications wja
WHERE wja.worker_id IS NOT NULL AND wja.job_posting_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM encuadres e
    WHERE e.worker_id = wja.worker_id AND e.job_posting_id = wja.job_posting_id
  );
-- Esperado: 0
