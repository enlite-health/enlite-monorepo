-- ROLLBACK_515_admission_050_conference_started_at.sql — par de rollback da migration 515 (spec 050 F14).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Perde só o horário de início já gravado
-- (o evento `conference_started` na trilha é só-acréscimo e fica).
ALTER TABLE admission_appointments DROP COLUMN IF EXISTS conference_started_at;
