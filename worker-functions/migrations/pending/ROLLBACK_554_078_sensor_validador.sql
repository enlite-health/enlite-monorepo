-- ROLLBACK_554_078_sensor_validador.sql — par de rollback da migration 554 (sensor `validador` + PEDIDO_IA_APLICAR, spec 078 M4.4).
--
-- Mora em `migrations/pending/` (sem número): o runner só lê `migrations/` sem recursão. Só roda quando alguém aponta o caminho:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_554_078_sensor_validador.sql
--
-- ⚠️ Falha DE PROPÓSITO se já existir veredicto com sensor 'validador' (o CHECK antigo não o admite): veredicto é INSERT-only e
-- apagá-lo é decisão à parte. Idem o tipo de notificação: com eventos gravados, o DELETE bate na FK.
-- Se a 554 tiver sido registrada em schema_migrations, remover a linha à mão depois, para poder reaplicá-la.

ALTER TABLE agentes.veredictos DROP CONSTRAINT IF EXISTS veredictos_sensor_check;
ALTER TABLE agentes.veredictos ADD CONSTRAINT veredictos_sensor_check
  CHECK (sensor IN ('silente','handover_orfao','juiz','scrubber','notario'));
DELETE FROM notification_types WHERE code = 'PEDIDO_IA_APLICAR';
