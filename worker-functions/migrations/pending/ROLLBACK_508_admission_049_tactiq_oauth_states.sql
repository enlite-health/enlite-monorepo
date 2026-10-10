-- ROLLBACK_508_admission_049_tactiq_oauth_states.sql — par de rollback da migration 508 (spec 049).
-- Só apaga estados de OAuth em voo (10 min de vida): quem estava vinculando clica de novo. Reverter o código ANTES.
DROP TABLE IF EXISTS tactiq_oauth_states;
