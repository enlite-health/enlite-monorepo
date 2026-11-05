-- ROLLBACK_568_078_veredictos_fk_check_do_dono.sql — par de rollback da migration 568 (spec 078).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho.
-- ⚠️ Desfazer devolve o defeito: com o dono sem UPDATE, todo veredicto COM achado volta a falhar
-- (`permission denied for table veredictos`). Nenhum dado é perdido.
DO $$
DECLARE
  dono text := pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'agentes.veredictos'::regclass));
BEGIN
  EXECUTE format('REVOKE UPDATE (id) ON agentes.veredictos FROM %I', dono);
END $$;
