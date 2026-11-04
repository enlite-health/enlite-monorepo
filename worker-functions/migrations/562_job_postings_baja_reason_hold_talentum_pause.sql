-- 562 — spec 084 (vagas antigas: baixa sem apagar, volta só pelo serviço)
--
-- Três colunas aditivas em job_postings (nenhuma linha existente viola nada; nasce tudo NULL):
--
--  * baja_reason  — POR QUE a vaga está em DE_BAJA (P2): 'MANUAL' (dada à mão), 'CUTOFF' (linha de corte),
--                   'SERVICE' (o serviço foi dado de baixa). Reativar o serviço só devolve as vagas 'SERVICE'
--                   (R17: vaga sem serviço contratado nunca volta). Backfill: a vaga que já está em DE_BAJA hoje
--                   só pode ter entrado pelo gatilho do serviço (nenhuma rota escrevia DE_BAJA) -> 'SERVICE'.
--  * status_before_hold — status anterior ao ON_HOLD ("En espera", R18); "Retomar" devolve a ele (F5).
--  * talentum_pause_state — o que o Talentum respondeu (R13): 'PAUSED' (pausado por API), 'MANUAL_PAUSE'
--                   (recusou: pausar à mão), 'MANUAL_RESUME' (recusou a retomada: retomar à mão). 'PENDING_PAUSE' /
--                   'PENDING_RESUME' são gravados na MESMA transação da baixa/volta, ANTES de qualquer chamada ao
--                   Talentum: se o trabalho pós-resposta for descartado (Cloud Run sem CPU), a vaga fica visível na lista
--                   manual em vez de NULL calado. NULL = nada a fazer (vaga sem projeto no Talentum).
--
--  * talentum_prescreenings.held_for_baja — candidato que ainda chegou por um projeto de vaga DADA DE BAJA (F4): a resposta é
--                   GUARDADA (nada se perde), mas não entra no Kanban de trabalho e fica marcada aqui.
--
-- Roda como enlite_app (dono) em prd: só ALTER TABLE ... ADD COLUMN / ADD CONSTRAINT / UPDATE na própria tabela e
-- CREATE INDEX — nenhum GRANT/REVOKE, nada que exija superuser.

ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS baja_reason TEXT NULL;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS status_before_hold TEXT NULL;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS talentum_pause_state TEXT NULL;

ALTER TABLE talentum_prescreenings ADD COLUMN IF NOT EXISTS held_for_baja BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN talentum_prescreenings.held_for_baja IS
  'Spec 084 (F4): true = a resposta chegou por projeto de vaga DE_BAJA; guardada, fora do Kanban de trabalho (sem WJA/encuadre/evento).';

-- Backfill ANTES do CHECK, e só onde ainda é NULL (idempotente).
UPDATE job_postings SET baja_reason = 'SERVICE'
 WHERE status = 'DE_BAJA' AND baja_reason IS NULL;

ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS job_postings_baja_reason_check;
ALTER TABLE job_postings ADD CONSTRAINT job_postings_baja_reason_check
  CHECK (baja_reason IS NULL OR baja_reason IN ('MANUAL', 'CUTOFF', 'SERVICE'));

ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS job_postings_talentum_pause_state_check;
ALTER TABLE job_postings ADD CONSTRAINT job_postings_talentum_pause_state_check
  CHECK (talentum_pause_state IS NULL OR talentum_pause_state IN ('PAUSED', 'MANUAL_PAUSE', 'MANUAL_RESUME', 'PENDING_PAUSE', 'PENDING_RESUME'));

-- Gatilho de coerência: o motivo acompanha o status, inclusive para a revisão ANTERIOR do código (que ainda roda
-- durante o deploy e baixa a vaga pelo serviço SEM conhecer a coluna): DE_BAJA sem motivo = 'SERVICE' (o único
-- caminho que escrevia DE_BAJA antes desta spec); sair de DE_BAJA apaga o motivo.
CREATE OR REPLACE FUNCTION job_postings_baja_reason_sync() RETURNS trigger AS $fn$
BEGIN
  IF NEW.status = 'DE_BAJA' AND NEW.baja_reason IS NULL THEN
    NEW.baja_reason := 'SERVICE';
  ELSIF NEW.status IS DISTINCT FROM 'DE_BAJA' THEN
    NEW.baja_reason := NULL;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_job_postings_baja_reason_sync ON job_postings;
CREATE TRIGGER trg_job_postings_baja_reason_sync
  BEFORE INSERT OR UPDATE OF status, baja_reason ON job_postings
  FOR EACH ROW EXECUTE FUNCTION job_postings_baja_reason_sync();

-- Toda vaga em DE_BAJA tem motivo (e só ela).
ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS job_postings_baja_reason_iff_de_baja;
ALTER TABLE job_postings ADD CONSTRAINT job_postings_baja_reason_iff_de_baja
  CHECK ((status = 'DE_BAJA') = (baja_reason IS NOT NULL));

-- A lista manual do Talentum é pequena e filtrada na tela de vacantes.
CREATE INDEX IF NOT EXISTS idx_job_postings_talentum_manual
  ON job_postings (id) WHERE talentum_pause_state IN ('MANUAL_PAUSE', 'MANUAL_RESUME', 'PENDING_PAUSE', 'PENDING_RESUME') AND deleted_at IS NULL;

COMMENT ON COLUMN job_postings.baja_reason IS
  'Spec 084 (P2): motivo do DE_BAJA — MANUAL | CUTOFF | SERVICE. NOT NULL sse status = DE_BAJA. Só SERVICE volta, e só pela reativação do serviço (R17).';
COMMENT ON COLUMN job_postings.status_before_hold IS
  'Spec 084 (F5/R18): status antes de ON_HOLD ("En espera"); "Retomar" devolve a ele.';
COMMENT ON COLUMN job_postings.talentum_pause_state IS
  'Spec 084 (R13): PAUSED | MANUAL_PAUSE | MANUAL_RESUME. MANUAL_* = o Talentum recusou (403): a pessoa age à mão no Talentum.';

DO $$ BEGIN RAISE NOTICE 'Migration 562: baja_reason, status_before_hold, talentum_pause_state em job_postings'; END $$;
