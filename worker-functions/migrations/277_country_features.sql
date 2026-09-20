-- 277: iam.country_features — o que EXISTE em cada país (D115, desenho B)
--
-- POR QUÊ: "nem sempre uma tela da Argentina existe no Brasil; nem sempre as opções de
-- select/componentes de um país existem em outro" (Gabriel, 16/08). Isso é
-- DISPONIBILIDADE por país — configuração de produto — e é ortogonal a permissão
-- ("quem pode") e a escopo de país do grupo ("onde vê dado"). Padrão do mercado:
-- Stripe (capability por país), Shopify Markets, feature flags por atributo country;
-- e todos avisam: flag no cliente não é controle de acesso — o backend recusa (404).
--
-- MODELO: chave estável `screen:<slug>` | `options:<slug>` | `component:<slug>`,
-- estado por país + config opcional (ex.: a lista de opções daquele país). O DEFAULT
-- nasce em código (`country-features.manifest.ts`, sincronizado no boot pelo
-- `syncCountryFeatures()` com source='default'); o painel pode sobrescrever
-- (source='override', com reason). Override NÃO é apagado por um sync posterior.
--
-- SEM FK de domínio, SEM dado de titular (lex C10): config é validado por JSON schema
-- por tipo na borda; `reason`/`updated_by` são trilha de STAFF (retenção como a 280).
-- Candidato natural a serviço de configuração próprio (extração, D115 §7).

CREATE TABLE IF NOT EXISTS iam.country_features (
  country      VARCHAR(2)   NOT NULL CHECK (country IN ('AR', 'BR')),
  feature_key  VARCHAR(120) NOT NULL
               CHECK (feature_key ~ '^(screen|options|component):[a-z0-9][a-z0-9._-]*$'),
  enabled      BOOLEAN      NOT NULL DEFAULT false,
  config       JSONB,
  source       VARCHAR(8)   NOT NULL DEFAULT 'default' CHECK (source IN ('default', 'override')),
  reason       TEXT,
  updated_by   VARCHAR(128) NOT NULL DEFAULT 'system:manifest',
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (country, feature_key)
);
CREATE INDEX IF NOT EXISTS ix_country_features_key ON iam.country_features (feature_key);
COMMENT ON TABLE iam.country_features IS
  'Disponibilidade por país (tela/opção de select/componente). default = manifest em '
  'código; override = painel. Backend 404 onde enabled=false; front esconde. Sem dado '
  'de titular (lex C10).';
COMMENT ON COLUMN iam.country_features.config IS
  'Configuração da feature naquele país (ex.: options:* → lista). Validado por JSON '
  'schema por tipo na borda da API. Nunca dado de pessoa.';

-- Trilha append-only das mudanças (default→override, on→off, config anterior).
CREATE TABLE IF NOT EXISTS iam.country_feature_changes (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  country       VARCHAR(2)   NOT NULL,
  feature_key   VARCHAR(120) NOT NULL,
  prev_enabled  BOOLEAN,
  prev_config   JSONB,
  prev_source   VARCHAR(8),
  new_enabled   BOOLEAN      NOT NULL,
  new_config    JSONB,
  new_source    VARCHAR(8)   NOT NULL,
  reason        TEXT,
  changed_by    VARCHAR(128) NOT NULL,
  changed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_country_feature_changes_key
  ON iam.country_feature_changes (country, feature_key, changed_at DESC);
COMMENT ON TABLE iam.country_feature_changes IS
  'Append-only: histórico de disponibilidade por país (quem/quando/de→para). Trilha de staff.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    -- Leitura livre (o resolver e o middleware leem por request); escrita SÓ por
    -- SECURITY DEFINER (279) — a role do app não muda o que existe no país.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON iam.country_features FROM app_runtime, app_system;
    REVOKE UPDATE, DELETE, TRUNCATE ON iam.country_feature_changes FROM app_runtime, app_system;
    -- ⚠️ Sob a virada (D112) o processo NÃO conecta como owner: o sync do manifest no
    -- boot chama iam.sync_country_feature_default(...) (SECURITY DEFINER, 279) pelo
    -- pool de sistema; overrides do painel chamam iam.set_country_feature(...) (279).
  END IF;
END
$$;
