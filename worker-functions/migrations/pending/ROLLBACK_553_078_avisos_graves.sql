-- ROLLBACK_553_078_avisos_graves.sql — par de rollback da migration 553 (aviso do pedido do Sol, spec 078 M3b-2).
--
-- Mora em `migrations/pending/` (sem número): o runner só lê `migrations/` sem recursão. Só roda quando alguém aponta o caminho:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_553_078_avisos_graves.sql
--
-- ⚠️ DESTRUTIVO: apaga a trilha de aviso (`agentes.avisos_enviados`); exportar antes em prd. Os tipos de notificação só são
-- removidos se nenhum evento os usa (FK); com eventos gravados, o DELETE falha de propósito — apagar notificação é decisão à parte.
-- Se a 553 tiver sido registrada em schema_migrations, remover a linha à mão depois, para poder reaplicá-la.

DROP TABLE IF EXISTS agentes.avisos_enviados;
DELETE FROM notification_types WHERE code IN ('PEDIDO_IA_NOVO', 'PEDIDO_IA_GRAVE');
