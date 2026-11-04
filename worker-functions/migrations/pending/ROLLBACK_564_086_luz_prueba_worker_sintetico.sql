-- ROLLBACK_564_086_luz_prueba_worker_sintetico.sql — par de rollback da migration 564 (spec 086).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Apaga só a sintética (telefone fixo E is_test).
DELETE FROM workers WHERE phone = '+5490000000000' AND is_test = true;
