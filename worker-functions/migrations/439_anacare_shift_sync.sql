-- 439 — Sync real do retrato de turnos do Ana Care (fase 2/4, F4 tasks 4.1-4.9 continuação).
--
-- Contexto medido 17/09 contra a API real (ver `AnaCareShiftsSourceReal`/`AnaCareEnliteDirectory`):
-- a LISTA por agência não existe na API (nenhum filtro `agency*` funciona), então a única forma
-- barata de popular `anacare_shift` é por RESERVA (`reservation_id=<id>`, filtra no servidor) —
-- as reservas da Enlite vêm do diretório raspado (`AnaCareEnliteDirectory`, 283 contas medidas).
-- Esta migration só ajusta o schema de 437 para o job de sync escrever de verdade.
--
-- 1. `is_finalized` — afirmação da FONTE de que o turno fechou (não é derivação nossa: a porta
--    `SourceShiftDTO.isFinalized` já existe desde a F1/F2, mas o retrato nunca gravava nada).
-- 2. `duration_hours` ganha o COMMENT que documenta o fato medido 17/09: é sempre o PREVISTO
--    (scheduledEnd - scheduledStart), preenchido mesmo sem check-in e mesmo turno não finalizado —
--    NUNCA usar para hora trabalhada (isso é sempre `checkin_at`→`checkout_at`, ver
--    `AnaCareHoursMapper.computeActualHours`).
-- 3. `anacare_directory_snapshot` — última contagem CONHECIDA do diretório Enlite (raspagem HTML,
--    quebra em silêncio devolvendo MENOS linhas em vez de erro). O runner de sync (4.1-4.9) compara
--    a contagem nova contra esta linha ANTES de sincronizar — queda abaixo do piso relativo
--    (80% do último conhecido, `AnaCareHoursSyncRunner`) aborta sem gravar nada. Linha única
--    (`id=1`), persiste entre execuções do Cloud Run (a raspagem falha silenciosamente, não dá pra
--    confiar só em memória de processo — cada instância nasce e morre). Sem histórico ainda
--    (primeira execução): nasce vazia, o runner só aplica o piso ABSOLUTO
--    (`ANACARE_DIRECTORY_MIN_ABSOLUTE`, default permissivo — decisão do Gabriel/dev: prod deve
--    configurar um piso realista via env, o valor medido de referência é 283 contas).
--
-- Nenhum índice novo: `idx_anacare_shift_period_patient`/`..._period_worker` (437) já cobrem
-- `listByMonth` (o leading column `period_month` serve a consulta mesmo sem filtro de paciente).
-- `uq_anacare_shift_source_id` (437) já serve o `ON CONFLICT` do upsert em lote.
--
-- Rollback:
--   ALTER TABLE anacare_shift DROP COLUMN IF EXISTS is_finalized;
--   DROP TABLE IF EXISTS anacare_directory_snapshot;

BEGIN;

ALTER TABLE anacare_shift ADD COLUMN IF NOT EXISTS is_finalized BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN anacare_shift.duration_hours IS
  'PREVISTO (planned_end - planned_start), afirmado pela fonte — medido 17/09 contra a API real: '
  'preenchido mesmo sem check-in e mesmo turno não finalizado (is_finalized=false). NUNCA usar '
  'para hora trabalhada: essa é SEMPRE checkin_at→checkout_at (ver AnaCareHoursMapper.computeActualHours).';

COMMENT ON COLUMN anacare_shift.is_finalized IS
  'Afirmação da FONTE de que o turno fechou (SourceShiftDTO.isFinalized). Não é derivação nossa — '
  'não confundir com status de validação (shift_hours_validation.status), que é workflow nosso.';

CREATE TABLE IF NOT EXISTS anacare_directory_snapshot (
  id                SMALLINT     PRIMARY KEY DEFAULT 1,
  last_total_count  INTEGER      NOT NULL,
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_anacare_directory_snapshot_singleton CHECK (id = 1)
);

COMMENT ON TABLE anacare_directory_snapshot IS
  'Última contagem CONHECIDA do diretório de reservas Enlite no Ana Care (AnaCareEnliteDirectory, '
  'raspagem HTML). Linha única (id=1). O runner de sync compara a contagem nova contra esta ANTES '
  'de gravar — queda abaixo do piso relativo (80% do último conhecido) aborta sem escrever nada '
  '(a raspagem quebra em silêncio devolvendo MENOS linhas, nunca erro de rede).';

GRANT SELECT, INSERT, UPDATE ON anacare_directory_snapshot TO app_runtime, app_system;

COMMIT;
