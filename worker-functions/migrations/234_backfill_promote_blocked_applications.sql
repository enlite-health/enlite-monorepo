-- Migration 234: backfill de promoção de tentativas bloqueadas históricas.
--
-- INVARIANTE: as guardas abaixo espelham EXATAMENTE
-- PromoteBlockedApplicationsUseCase.ts (src/modules/matching/application/) —
-- fonte de verdade das regras de promoção. Qualquer mudança nas guardas do
-- use case (vaga válida, WJA inexistente, worker REGISTERED não-merged) deve
-- ser refletida aqui se este backfill for reexecutado manualmente.
--
-- Contexto: antes desta feature, worker_blocked_applications registrava a
-- tentativa bloqueada mas nunca promovia automaticamente quando o worker
-- completava o cadastro depois — o card ficava "preso" mesmo com o worker já
-- REGISTERED. Este backfill promove os órfãos históricos (~44 em prod) de uma
-- vez; daqui pra frente PromoteBlockedApplicationsUseCase cobre o fluxo
-- contínuo via evento worker.registration_completed.
--
-- Guardas por linha (worker_blocked_applications WHERE promoted_at IS NULL):
--   a. vaga existe, deleted_at IS NULL, is_draft = false, status <> 'CLOSED'
--   b. NOT EXISTS worker_job_applications para o par (worker_id, job_posting_id)
--      em QUALQUER stage — nunca ressuscita um WJA REJECTED.
--   c. worker.status = 'REGISTERED' e merged_into_id IS NULL
--
-- Cria worker_job_applications (source='manual', stage='INVITED',
-- acquisition_channel da linha bloqueada, applied_at=NOW()) + encuadre
-- condicional (mesmo shape de CreateManualWjaWithEncuadreUseCase — sem
-- worker_raw_name/phone pois a migration não decripta KMS; puramente
-- rastreabilidade, não é usado como fonte de exibição — o Kanban usa
-- workers.first_name_encrypted via JOIN).
--
-- Resiliente: por linha, com EXCEPTION WHEN OTHERS → RAISE NOTICE e continua
-- (padrão da migration 213). Idempotente: filtra promoted_at IS NULL.

DO $$
DECLARE
  r RECORD;
  v_wja_id UUID;
  v_channel TEXT;
  v_dedup_hash TEXT;
  promoted INT := 0;
  skipped INT := 0;
BEGIN
  FOR r IN
    SELECT
      wba.id,
      wba.worker_id,
      wba.job_posting_id,
      wba.acquisition_channel
    FROM worker_blocked_applications wba
    WHERE wba.promoted_at IS NULL
  LOOP
    BEGIN
      -- Guarda (c): worker REGISTERED e não-merged
      IF NOT EXISTS (
        SELECT 1 FROM workers w
        WHERE w.id = r.worker_id
          AND w.status = 'REGISTERED'
          AND w.merged_into_id IS NULL
      ) THEN
        skipped := skipped + 1;
        CONTINUE;
      END IF;

      -- Guarda (a): vaga válida
      IF NOT EXISTS (
        SELECT 1 FROM job_postings jp
        WHERE jp.id = r.job_posting_id
          AND jp.deleted_at IS NULL
          AND jp.is_draft = false
          AND jp.status <> 'CLOSED'
      ) THEN
        skipped := skipped + 1;
        CONTINUE;
      END IF;

      -- Guarda (b): NOT EXISTS WJA para o par, em qualquer stage
      IF EXISTS (
        SELECT 1 FROM worker_job_applications wja
        WHERE wja.worker_id = r.worker_id AND wja.job_posting_id = r.job_posting_id
      ) THEN
        skipped := skipped + 1;
        CONTINUE;
      END IF;

      v_channel := COALESCE(r.acquisition_channel, 'blocked_promotion');

      INSERT INTO worker_job_applications
        (worker_id, job_posting_id, source, acquisition_channel, application_funnel_stage, applied_at)
      VALUES
        (r.worker_id, r.job_posting_id, 'manual', v_channel, 'INVITED', NOW())
      RETURNING id INTO v_wja_id;

      v_dedup_hash := md5('social-link|' || r.worker_id::text || '|' || r.job_posting_id::text);

      INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash)
      SELECT r.worker_id, r.job_posting_id, v_channel, v_dedup_hash
      WHERE NOT EXISTS (
        SELECT 1 FROM encuadres e
        WHERE e.worker_id = r.worker_id AND e.job_posting_id = r.job_posting_id
      )
      ON CONFLICT (worker_id, job_posting_id) DO NOTHING;

      UPDATE worker_blocked_applications
      SET promoted_at = NOW(), promoted_wja_id = v_wja_id
      WHERE id = r.id;

      promoted := promoted + 1;
    EXCEPTION WHEN OTHERS THEN
      skipped := skipped + 1;
      RAISE NOTICE 'mig234 skip blocked_application % (worker=%, job_posting=%): %', r.id, r.worker_id, r.job_posting_id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'mig234: promovidos=% pulados=%', promoted, skipped;
END $$;
