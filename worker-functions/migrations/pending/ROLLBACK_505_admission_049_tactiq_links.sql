-- ROLLBACK_505_admission_049_tactiq_links.sql — par de rollback da migration 505 (spec 049).
-- ATENÇÃO: apaga todos os vínculos e tokens (cada operador terá de vincular de novo). Reverter o código ANTES.
DROP TABLE IF EXISTS tactiq_link_secrets;
DROP TABLE IF EXISTS tactiq_links;
