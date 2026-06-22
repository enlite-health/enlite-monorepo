-- Migration 220: backfill de phone_normalized + detecção de colisões
--
-- CONTEXTO:
--   Migration 219 criou phone_normalized como coluna GENERATED ALWAYS STORED,
--   portanto o banco já calculou o valor para todas as linhas existentes no
--   momento do ALTER TABLE. Esta migration NÃO precisa fazer UPDATE de dados.
--
-- O QUE ESTA MIGRATION FAZ:
--   1. Detecta colisões (workers ativos com phone_normalized duplicado).
--   2. Registra as colisões numa tabela de auditoria temporária para a
--      parte 2 (merge-service). NÃO executa merge aqui.
--   3. Emite NOTICE com o total de grupos de colisão detectados.
--
-- IDEMPOTÊNCIA:
--   A tabela worker_phone_collisions usa CREATE TABLE IF NOT EXISTS +
--   INSERT ON CONFLICT DO NOTHING → re-executar é seguro.
--
-- NOTA SOBRE O ÍNDICE UNIQUE (migration 219):
--   O índice idx_workers_phone_normalized_unique existe mas NÃO bloqueia
--   os dados históricos pré-existentes — apenas impede novos inserts/updates
--   que criariam duplicatas. Os duplicados antigos continuam na tabela;
--   o merge-service (parte 2) vai resolvê-los e depois um re-index vai
--   confirmar que o índice está limpo.

-- ── Tabela de auditoria de colisões ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS worker_phone_collisions (
  id                  BIGSERIAL   PRIMARY KEY,
  phone_normalized    TEXT        NOT NULL,
  worker_ids          UUID[]      NOT NULL,
  worker_count        INT         NOT NULL,
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  merge_survivor_id   UUID        REFERENCES workers(id),
  notes               TEXT,

  CONSTRAINT uq_worker_phone_collisions_phone
    UNIQUE (phone_normalized)
);

COMMENT ON TABLE worker_phone_collisions IS
  'Colisões semânticas de telefone detectadas pela migration 220 (backfill). '
  'Cada linha representa um grupo de workers ativos com o mesmo phone_normalized. '
  'O merge-service (Track C parte 2) lê esta tabela, executa o merge '
  'e preenche resolved_at + merge_survivor_id.';

CREATE INDEX IF NOT EXISTS idx_worker_phone_collisions_unresolved
  ON worker_phone_collisions (phone_normalized)
  WHERE resolved_at IS NULL;

-- ── Detectar e persistir colisões ────────────────────────────────────────────

INSERT INTO worker_phone_collisions (phone_normalized, worker_ids, worker_count)
SELECT
  phone_normalized,
  array_agg(id ORDER BY created_at ASC) AS worker_ids,
  COUNT(*)::INT                          AS worker_count
FROM workers
WHERE phone_normalized IS NOT NULL
  AND merged_into_id IS NULL
GROUP BY phone_normalized
HAVING COUNT(*) > 1
ON CONFLICT (phone_normalized) DO NOTHING;

-- ── Emitir relatório de colisões ─────────────────────────────────────────────

DO $$
DECLARE
  total_collision_groups INT;
  total_workers_affected INT;
BEGIN
  SELECT
    COUNT(*),
    COALESCE(SUM(worker_count), 0)
  INTO
    total_collision_groups,
    total_workers_affected
  FROM worker_phone_collisions
  WHERE resolved_at IS NULL;

  RAISE NOTICE 'Migration 220 — phone_normalized backfill concluído';
  RAISE NOTICE '  Grupos de colisão detectados: %', total_collision_groups;
  RAISE NOTICE '  Workers envolvidos em colisões: %', total_workers_affected;

  IF total_collision_groups > 0 THEN
    RAISE NOTICE '  AÇÃO REQUERIDA: Execute o merge-service (Track C parte 2) para resolver as colisões.';
    RAISE NOTICE '  Consulte: SELECT phone_normalized, worker_count, worker_ids FROM worker_phone_collisions WHERE resolved_at IS NULL ORDER BY worker_count DESC;';
  ELSE
    RAISE NOTICE '  Nenhuma colisão detectada — índice UNIQUE já pode ser aplicado sem conflito.';
  END IF;
END;
$$;
