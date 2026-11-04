-- ROLLBACK_567_086_luz_prueba_turnos.sql — par de rollback da migration 567 (spec 086).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Perde só a contagem de turnos do dia (sem dado de negócio).
DROP TABLE IF EXISTS agentes.luz_prueba_turnos;
