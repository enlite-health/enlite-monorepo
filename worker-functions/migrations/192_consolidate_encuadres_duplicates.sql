-- ============================================================
-- Migration 192: Consolidação de duplicatas em encuadres (F5)
-- ============================================================
-- Parte do plano WJA/Encuadre (docs/features/worker-job-applications/README.md).
-- ADR-001: docs/adr/001-encuadres-unique-worker-job-posting-constraint.md
--
-- Pré-condições:
--   1. encuadres_backup_pre_f5 será criada pela migration (idempotente via IF NOT EXISTS)
--   2. encuadre_ambiguity_queue: FK ON DELETE CASCADE — registros que apontam
--      para encuadres deletados somem automaticamente.
--
-- Janela de execução recomendada: madrugada AR (00h-05h GMT-3) — zero tráfego Talentum.
-- Retenção do backup: 14 dias (sincroniza com TD-041 dropar dedup_hash UNIQUE).
-- Idempotente: segunda execução é no-op (auditoria check + WHERE NOT EXISTS).
-- ============================================================

BEGIN;

-- 1. Backup (idempotente — só cria se não existir)
CREATE TABLE IF NOT EXISTS encuadres_backup_pre_f5 AS SELECT * FROM encuadres;

-- 2. Tabela de auditoria de consolidação
CREATE TABLE IF NOT EXISTS encuadres_consolidation_audit (
  id                    BIGSERIAL PRIMARY KEY,
  sobrevivente_id       UUID NOT NULL,
  deletado_id           UUID NOT NULL,
  worker_id             UUID,
  job_posting_id        UUID,
  sobrevivente_richness INTEGER,
  deletado_richness     INTEGER,
  sobrevivente_origen   TEXT,
  deletado_origen       TEXT,
  deleted_at            TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Consolidação: richness score + recência, DELETE duplicatas, auditoria
-- (Remoção de duplicatas aprovada por ADR-001 — operação destrutiva intencional
--  com backup idempotente acima e tabela de auditoria para rollback granular.)
WITH ranked AS (
  SELECT
    id, worker_id, job_posting_id, origen, created_at,
    (
      (CASE WHEN interview_date         IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN resultado              IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN attended               IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN accepts_case           IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN rejection_reason       IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN obs_encuadre           IS NOT NULL AND obs_encuadre      != '' THEN 1 ELSE 0 END) +
      (CASE WHEN obs_reclutamiento      IS NOT NULL AND obs_reclutamiento != '' THEN 1 ELSE 0 END) +
      (CASE WHEN obs_adicionales        IS NOT NULL AND obs_adicionales   != '' THEN 1 ELSE 0 END) +
      (CASE WHEN recruiter_name         IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN recruitment_date       IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN has_cv                 IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN has_dni                IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN worker_email_encrypted IS NOT NULL THEN 1 ELSE 0 END)
    ) AS richness,
    ROW_NUMBER() OVER (
      PARTITION BY worker_id, job_posting_id
      ORDER BY
        (
          (CASE WHEN interview_date         IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN resultado              IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN attended               IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN accepts_case           IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN rejection_reason       IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN obs_encuadre           IS NOT NULL AND obs_encuadre      != '' THEN 1 ELSE 0 END) +
          (CASE WHEN obs_reclutamiento      IS NOT NULL AND obs_reclutamiento != '' THEN 1 ELSE 0 END) +
          (CASE WHEN obs_adicionales        IS NOT NULL AND obs_adicionales   != '' THEN 1 ELSE 0 END) +
          (CASE WHEN recruiter_name         IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN recruitment_date       IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN has_cv                 IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN has_dni                IS NOT NULL THEN 1 ELSE 0 END) +
          (CASE WHEN worker_email_encrypted IS NOT NULL THEN 1 ELSE 0 END)
        ) DESC,
        created_at DESC,
        id ASC
    ) AS rn
  FROM encuadres
  WHERE worker_id IS NOT NULL AND job_posting_id IS NOT NULL
),
survivors AS (
  SELECT id AS sobrevivente_id, worker_id, job_posting_id, richness, origen
  FROM ranked WHERE rn = 1
),
to_delete AS (
  SELECT r.id AS deletado_id, r.worker_id, r.job_posting_id,
         r.richness AS deletado_richness, r.origen AS deletado_origen,
         s.sobrevivente_id, s.richness AS sobrevivente_richness, s.origen AS sobrevivente_origen
  FROM ranked r
  JOIN survivors s ON s.worker_id = r.worker_id AND s.job_posting_id = r.job_posting_id
  WHERE r.rn > 1
    AND NOT EXISTS (
      SELECT 1 FROM encuadres_consolidation_audit a WHERE a.deletado_id = r.id
    )
),
audit_insert AS (
  INSERT INTO encuadres_consolidation_audit
    (sobrevivente_id, deletado_id, worker_id, job_posting_id,
     sobrevivente_richness, deletado_richness, sobrevivente_origen, deletado_origen)
  SELECT sobrevivente_id, deletado_id, worker_id, job_posting_id,
         sobrevivente_richness, deletado_richness, sobrevivente_origen, deletado_origen
  FROM to_delete
  RETURNING deletado_id
)
DELETE
  FROM encuadres WHERE id IN (SELECT deletado_id FROM audit_insert);

-- 4. Verificação pós-remoção: falha a transaction se ainda houver duplicatas
DO $$
DECLARE dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT worker_id, job_posting_id FROM encuadres
    WHERE worker_id IS NOT NULL AND job_posting_id IS NOT NULL
    GROUP BY worker_id, job_posting_id HAVING COUNT(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Migration 192 FALHOU: % pares ainda com duplicatas', dup_count;
  END IF;
  RAISE NOTICE 'Migration 192 OK: zero duplicatas restantes';
END $$;

COMMIT;
