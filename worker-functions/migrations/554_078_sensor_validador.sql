-- Migration 554: sensor `validador` + aviso PEDIDO_IA_APLICAR (spec 078, M4.4 — plano-M4 D2 último parágrafo e D4)
--
-- 1) `agentes.veredictos.sensor` ganha `validador` (os validadores determinísticos por NUNCA, do triage). A 551 NÃO é alterada: já está
--    publicada; aqui troca-se só o CHECK (nome fixo `veredictos_sensor_check`, o que o Postgres deu ao CHECK inline da 551).
--    As CHECKs de nota/versão (`nota_so_do_juiz`, `versao_so_do_juiz`) seguem valendo: `validador` não tem nota nem versão de juiz.
-- 2) Tipo de notificação `PEDIDO_IA_APLICAR` (molde 553): pedido ACEITO em degrau 3/4 -> avisa os decisores de que é hora de aplicar.
--    Payload só-ids ({pedido_id, degrau, grave, prazo}); nunca assunto/descrição/PII.
--
-- Idempotente (2x). Sem BEGIN/COMMIT próprio (o runner envolve).
-- Rollback: `migrations/pending/ROLLBACK_554_078_sensor_validador.sql`.

ALTER TABLE agentes.veredictos DROP CONSTRAINT IF EXISTS veredictos_sensor_check;
ALTER TABLE agentes.veredictos ADD CONSTRAINT veredictos_sensor_check
  CHECK (sensor IN ('silente','handover_orfao','juiz','scrubber','notario','validador'));

INSERT INTO notification_types (code, description) VALUES
  ('PEDIDO_IA_APLICAR', 'Aviso automático: pedido do Sol ACEITO em degrau 3/4 aguarda aplicação (hoje se grave, na semana se não; só ids, sem texto)')
ON CONFLICT (code) DO NOTHING;
