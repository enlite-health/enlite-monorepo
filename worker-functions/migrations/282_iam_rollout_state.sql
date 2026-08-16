-- 282: iam.rollout_state — marcador de "a migração de dados já rodou NESTE ambiente"
--
-- POR QUÊ (lex C2, design 3): virar `PERMISSION_ENGINE_ENABLED` num ambiente onde a
-- migração de dados (grupo de sistema com país + staff sem grupo adotado) ainda não
-- rodou joga TODO o painel na tela de boas-vindas. O gate óbvio seria um assert de boot
-- que recusa subir — e é exatamente o que o lex vetou: worker-functions serve também a
-- app do prestador, os leads e os webhooks; derrubá-lo por causa do painel troca um
-- problema de acesso por uma indisponibilidade geral.
--
-- A saída é este marcador: o boot LÊ (barato, uma linha) e, se o engine está ligado sem
-- a marca, ACENDE ALERTA e segue servindo. Quem falha de verdade é o gate da virada
-- (`scripts/assert-no-staff-without-group.sql`), rodado pelo operador ANTES do flip.
--
-- Escrita: nenhuma role do app escreve aqui. Quem marca é o script da migração de dados
-- (grupo 5), rodado como owner via psql — o mesmo caminho da 278. Assim o marcador não
-- pode ser aceso pelo processo que ele governa.

CREATE TABLE IF NOT EXISTS iam.rollout_state (
  key        TEXT         PRIMARY KEY,
  value      TEXT         NOT NULL,
  note       TEXT,
  updated_by VARCHAR(128) NOT NULL DEFAULT 'system:migration',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE iam.rollout_state IS
  'Marcadores de rollout do IAM por AMBIENTE (ex.: permission_groups_migrated=done). '
  'Lido no boot para alertar (nunca para falhar — lex C2). Escrito só pelo script da '
  'migração de dados, como owner.';
COMMENT ON COLUMN iam.rollout_state.note IS
  'Contexto humano do marcador (data, quem rodou, quantas linhas) — sem dado de pessoa.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT ON iam.rollout_state TO app_runtime, app_system;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON iam.rollout_state FROM app_runtime, app_system;
  END IF;
END
$$;
