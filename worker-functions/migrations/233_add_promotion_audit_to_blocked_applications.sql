-- Migration 233: auditoria de promoção em worker_blocked_applications.
--
-- Feature "coluna BLOQUEADO no kanban + promoção automática de tentativas
-- bloqueadas": quando um worker que tentou postular sem estar REGISTERED
-- completa o cadastro, a tentativa bloqueada é promovida automaticamente
-- para um worker_job_application (source='manual', stage='INVITED').
--
-- promoted_at / promoted_wja_id registram QUANDO e PARA QUAL WJA a tentativa
-- foi promovida — permite:
--   - PromoteBlockedApplicationsUseCase filtrar `WHERE promoted_at IS NULL`
--     (idempotência: não reprocessa linhas já promovidas).
--   - Auditoria/debug: rastrear qual WJA nasceu de qual tentativa bloqueada.
--
-- Aditiva — sem DROP, sem NOT NULL sem default. Sem FK para
-- worker_job_applications (mesma filosofia de isolamento da migration 209:
-- tolera soft-delete/merge sem quebrar a linha de auditoria).

ALTER TABLE worker_blocked_applications
  ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS promoted_wja_id UUID NULL;

COMMENT ON COLUMN worker_blocked_applications.promoted_at IS
  'Timestamp em que a tentativa bloqueada foi promovida a worker_job_application '
  '(worker completou o cadastro). NULL = ainda não promovida. '
  'PromoteBlockedApplicationsUseCase é a fonte de verdade das guardas de promoção.';

COMMENT ON COLUMN worker_blocked_applications.promoted_wja_id IS
  'ID do worker_job_applications criado pela promoção. Sem FK (mesma tolerância '
  'a soft-delete/merge das demais colunas desta tabela) — apenas rastreabilidade.';

-- Índice parcial: a query de promoção sempre filtra WHERE worker_id = $1 AND
-- promoted_at IS NULL — cobre o caso comum (poucas linhas não promovidas por
-- worker) sem inflar o índice com linhas já promovidas (maioria, em regime).
CREATE INDEX IF NOT EXISTS idx_wba_worker_id_unpromoted
  ON worker_blocked_applications (worker_id)
  WHERE promoted_at IS NULL;

DO $$ BEGIN
  RAISE NOTICE 'Migration 233 done: promoted_at/promoted_wja_id added to worker_blocked_applications.';
END $$;
