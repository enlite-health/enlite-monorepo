-- ROLLBACK_551_078_agentes_placar_reportes_pedidos.sql — par de rollback da migration 551
-- (schema `agentes`: placar, reportes e fila de pedidos, spec 078).
--
-- Mora em `migrations/pending/` (sem número): o runner só lê `migrations/` sem recursão. Só roda
-- quando alguém aponta o caminho explicitamente:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_551_078_agentes_placar_reportes_pedidos.sql
--
-- ⚠️ DESTRUTIVO: apaga o placar, os reportes e a TRILHA DE DECISÃO (`pedido_eventos`, auditoria do
-- item 51). As tabelas são INSERT-only por desenho — não há "desfazer parcial". Antes de rodar em
-- prd, exportar `agentes.pedido_eventos`. Nada fora do schema `agentes` referencia estas tabelas.
-- Se a migration 551 tiver sido registrada em schema_migrations, remover a linha à mão depois, para
-- poder reaplicá-la.

DROP SCHEMA IF EXISTS agentes CASCADE;
