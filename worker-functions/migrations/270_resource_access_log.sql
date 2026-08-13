-- 270: resource_access_log — trilha de LEITURA de recurso sensível (ABAC país Fase 1)
--
-- Base do HIPAA §164.312(b) construída enquanto é barata (D108): 1 linha por ABERTURA
-- de dossiê (endpoint de detalhe de paciente/worker), não por linha SQL. Gravação
-- assíncrona fail-safe no app (task 3.4) — falha de audit nunca derruba a request.
--
-- Particionada por mês desde o dia 1 (HIPAA pede 6 anos de retenção; particionar
-- depois é caro). Partição DEFAULT como rede: INSERT de audit NUNCA pode falhar por
-- partição faltante. ⚠️ Runbook (task 5.2), duas regras da manutenção de janela:
--   1. ANTES de criar partição de um mês que já tenha linhas na DEFAULT, drenar a
--      DEFAULT (senão o CREATE PARTITION falha por conflito de constraint);
--   2. TODA partição nova criada fora desta migration precisa repetir o REVOKE
--      abaixo — os default privileges da 269 re-concedem DML a cada tabela nova.
--
-- lex C2: a trilha É dado pessoal (liga operador a paciente). Append-only para as
-- roles do app (INSERT via tabela-mãe, sem UPDATE/DELETE/TRUNCATE) e SELECT NEGADO —
-- leitura só pelo owner (admin/auditoria, vista da task 5.3). O REVOKE cobre a mãe
-- E cada partição: o ACL checado é o da relação NOMEADA na query, então partição
-- esquecida = trilha legível/apagável por nome direto. NUNCA expor à Luz nem ao
-- conector claude.ai sem capability nova explicitamente aprovada. Zero PII clínica.

CREATE TABLE IF NOT EXISTS resource_access_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  operator_uid TEXT NOT NULL,
  operator_role TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('same_country', 'group_grant', 'system')),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

COMMENT ON TABLE resource_access_log IS
  'Trilha de leitura de recurso sensível (quem ABRIU o quê). Append-only; SELECT restrito a papel de auditoria (lex C2). Partições mensais + DEFAULT.';
COMMENT ON COLUMN resource_access_log.origin IS
  'Como o operador alcançou o recurso: same_country | group_grant (via group_country_scopes) | system.';

-- Janela inicial: 2026-01 até 2027-12 (24 meses — os 7 meses retroativos são colchão
-- para occurred_at atrasado/backfill não envenenar a DEFAULT) + DEFAULT como rede.
DO $$
DECLARE
  m DATE := DATE '2026-01-01';
  part_name TEXT;
BEGIN
  WHILE m < DATE '2028-01-01' LOOP
    part_name := 'resource_access_log_' || to_char(m, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF resource_access_log FOR VALUES FROM (%L) TO (%L)',
      part_name, m, m + INTERVAL '1 month'
    );
    m := m + INTERVAL '1 month';
  END LOOP;
END
$$;

CREATE TABLE IF NOT EXISTS resource_access_log_default
  PARTITION OF resource_access_log DEFAULT;

-- Vistas da auditoria (task 5.3): "quem viu os dados da pessoa X" e "o que Z abriu".
CREATE INDEX IF NOT EXISTS idx_resource_access_log_resource
  ON resource_access_log (resource_type, resource_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_resource_access_log_operator
  ON resource_access_log (operator_uid, occurred_at);

-- Append-only de verdade: revoga na MÃE e em CADA partição (as partições nasceram
-- depois da 269, então cada uma carrega grant próprio dos default privileges — o
-- REVOKE só na mãe deixaria `SELECT ... FROM resource_access_log_2026_08` aberto).
REVOKE ALL ON resource_access_log FROM app_runtime, app_system;
GRANT INSERT ON resource_access_log TO app_runtime, app_system;

DO $$
DECLARE
  part RECORD;
BEGIN
  FOR part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'resource_access_log'::regclass
  LOOP
    EXECUTE format('REVOKE ALL ON %I FROM app_runtime, app_system', part.relname);
  END LOOP;
END
$$;
