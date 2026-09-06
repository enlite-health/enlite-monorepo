-- ⛔ PROIBIDO RODAR — ver D218 (ebrain, 29/08/2026). Este arquivo é a receita exata do vazamento fechado pelo
-- scripts/create-mcp-ro-role.sql: SELECT ON ALL TABLES + ALTER DEFAULT PRIVILEGES. A role `enlite_readonly` NÃO
-- existe em prod (medido 29/08) e o secret não existe. Mantido só como histórico. Leitura do MCP: enlite_mcp_ro.
\echo 'PROIBIDO — ver D218'
\quit
-- Cria o role enlite_readonly com permissao apenas de SELECT no schema public.
--
-- Uso:
--   1. Gere uma senha forte e guarde no Secret Manager como "enlite-ar-db-password-readonly":
--        PASSWORD=$(openssl rand -base64 24)
--        echo -n "$PASSWORD" | gcloud secrets create enlite-ar-db-password-readonly \
--          --replication-policy=automatic --data-file=-
--
--   2. Conecte ao banco de producao como superuser (postgres) via Cloud SQL Proxy
--      e execute este script passando a mesma senha via variavel psql:
--        psql "host=127.0.0.1 port=5435 dbname=enlite_ar user=postgres" \
--          -v readonly_password="$PASSWORD" \
--          -f scripts/create-readonly-role.sql
--
-- Idempotente: pode ser re-executado com seguranca.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enlite_readonly') THEN
    EXECUTE format('CREATE ROLE enlite_readonly WITH LOGIN PASSWORD %L', :'readonly_password');
  ELSE
    EXECUTE format('ALTER ROLE enlite_readonly WITH LOGIN PASSWORD %L', :'readonly_password');
  END IF;
END
$$;

GRANT CONNECT ON DATABASE enlite_ar TO enlite_readonly;
GRANT USAGE ON SCHEMA public TO enlite_readonly;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO enlite_readonly;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO enlite_readonly;

-- Novas tabelas/sequences criadas por enlite_app ganham SELECT automaticamente.
ALTER DEFAULT PRIVILEGES FOR ROLE enlite_app IN SCHEMA public
  GRANT SELECT ON TABLES TO enlite_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE enlite_app IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO enlite_readonly;
