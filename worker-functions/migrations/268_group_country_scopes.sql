-- 268: group_country_scopes — exceções cross-país por grupo nomeado (ABAC país Fase 1)
--
-- Change OpenSpec abac-pais-fase1 (ebrain), decisão D108: staff sem grupo enxerga só o
-- próprio país; a exceção é um grant vivo aqui, auditável (granted_by/reason NOT NULL)
-- e revogável com efeito imediato (revoked_at — a policy só considera revoked_at IS NULL,
-- resolvido no banco a cada request, nunca no token).
--
-- Consumidores: policy RLS de patients (migration 271) via user_groups → aqui;
-- criação/revogação de grupo = INSERT/UPDATE auditado via runbook (task 5.2 da change).

CREATE TABLE IF NOT EXISTS group_country_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
  country CHAR(2) NOT NULL CHECK (country IN ('AR', 'BR')),
  granted_by VARCHAR(128) NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

COMMENT ON TABLE group_country_scopes IS
  'Escopo de país concedido a um permission_group (exceção ao isolamento por país da RLS). Grant vivo = revoked_at IS NULL.';
COMMENT ON COLUMN group_country_scopes.granted_by IS 'firebase_uid de quem concedeu — obrigatório (trilha).';
COMMENT ON COLUMN group_country_scopes.reason IS 'Justificativa da concessão — obrigatória (trilha).';

-- Um único grant VIVO por (grupo, país); histórico de revogados fica preservado.
-- O mesmo índice serve o lookup da policy (group_id + country, filtrado por vivo).
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_country_scopes_live
  ON group_country_scopes (group_id, country)
  WHERE revoked_at IS NULL;
