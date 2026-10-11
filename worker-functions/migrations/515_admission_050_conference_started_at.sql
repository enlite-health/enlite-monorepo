-- 515 — Início real da reunião (spec 050, F14, R-7).
--
-- Coluna nova `admission_appointments.conference_started_at` = o MENOR `startTime` das conferências do espaço do Meet, gravado pelo job
-- de 15 min enquanto a reunião ainda está aberta (o `conference_ended_at` da 503 é o MAIOR `endTime`, gravado quando todas terminam).
--
-- O QUE `NULL` SIGNIFICA (uma coisa só): "o job nunca observou uma conferência deste espaço". Não distingue "ninguém entrou ainda" de
-- "a reunião é anterior a esta coluna": as duas são a mesma afirmação (nada observado) e nenhuma linha antiga é preenchida (sem backfill).
--
-- Aditiva: coluna anulável, sem DEFAULT e sem índice; nenhuma linha existente muda. Sem BEGIN/COMMIT próprio (o runner cuida disso).
-- Idempotente (2×): ADD COLUMN IF NOT EXISTS. VOLTA: pending/ROLLBACK_515_*.sql (perde só o horário de início já gravado).

ALTER TABLE admission_appointments
  ADD COLUMN IF NOT EXISTS conference_started_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN admission_appointments.conference_started_at IS
  'Menor startTime das conferências do espaço do Meet (job de 15 min). NULL = o job nunca observou conferência deste espaço.';
