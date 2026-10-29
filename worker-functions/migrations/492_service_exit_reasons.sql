-- Migration 492: catálogo de motivos de saída do serviço (change itinerario-trocas-motivos-e-figma, Fase 1)
--
-- Catálogo GLOBAL (sem país, sem RLS, sem texto de pessoa) das categorias genéricas de saída de um
-- prestador de um serviço — clone de `therapeutic_activities` (415) trocando: `code` estável
-- (o que as marcas e o registro vão referenciar, a partir da Fase 2) e sem `segment_id`.
-- Baixa = active=false + deactivated_at, nunca DELETE.
--
-- Célula ABAC `catalog_service_exit_reasons` × read|create|update semeada AQUI (molde 488): o sync
-- do catálogo de permissões está desligado em produção, então sem esta migration a tela sobe e
-- ninguém abre. Concessão SÓ ao Acesso Master (a0000000-0000-0000-0000-000000000001).
--
-- Idempotente (2×): IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS / ON CONFLICT.
-- Sem BEGIN/COMMIT próprio.
--
-- Rollback: `migrations/pending/ROLLBACK_492_service_exit_reasons.sql` (trava: recusa se algum
-- `code` for referenciado por FK).

CREATE TABLE IF NOT EXISTS service_exit_reasons (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT         NOT NULL,
  label          TEXT         NOT NULL,
  sort_order     INT          NOT NULL DEFAULT 0,
  active         BOOLEAN      NOT NULL DEFAULT true,
  deactivated_at TIMESTAMPTZ  NULL,
  created_by     VARCHAR(128) NOT NULL DEFAULT 'seed:492',
  updated_by     VARCHAR(128) NOT NULL DEFAULT 'seed:492',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ser_label_len CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  CONSTRAINT ser_active_pair CHECK ((active AND deactivated_at IS NULL) OR (NOT active AND deactivated_at IS NOT NULL)),
  CONSTRAINT ser_code_uq UNIQUE (code)
);

-- Rótulo único entre os ATIVOS (case-insensitive): desativar e recriar com o mesmo texto é permitido.
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_exit_reasons_label_ativo
  ON service_exit_reasons (lower(btrim(label))) WHERE active;
CREATE INDEX IF NOT EXISTS idx_service_exit_reasons_ordem ON service_exit_reasons (active, sort_order);

-- `code`: itens criados pelo admin não trazem código — o trigger usa o id; o código nunca muda depois
-- (é o que as marcas e o registro referenciam).
CREATE OR REPLACE FUNCTION fn_service_exit_reasons_code() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.code IS NULL THEN
      NEW.code := NEW.id::text;
    END IF;
  ELSIF NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'service_exit_reasons.code é imutável';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_service_exit_reasons_code ON service_exit_reasons;
CREATE TRIGGER trg_service_exit_reasons_code
  BEFORE INSERT OR UPDATE ON service_exit_reasons
  FOR EACH ROW EXECUTE FUNCTION fn_service_exit_reasons_code();

COMMENT ON TABLE service_exit_reasons IS
  'Catálogo global (sem país, sem PHI) dos motivos de saída do serviço (change itinerario-trocas-motivos-e-figma). '
  'Categorias genéricas, sem dado de saúde. `code` imutável (trigger). Baixa = active=false, nunca DELETE. '
  'Rótulo passa pela guarda de dado pessoal no servidor.';

-- Carga inicial: os 4 códigos que já existiam como CHECK na 481, com os rótulos que a tela mostra hoje.
INSERT INTO service_exit_reasons (code, label, sort_order) VALUES
  ('PERFIL_INADEQUADO_AO_SERVICO', 'Perfil no adecuado al servicio', 10),
  ('INDISPONIBILIDADE_DE_HORARIO', 'Sin disponibilidad horaria', 20),
  ('DESISTENCIA_DO_PRESTADOR', 'El prestador desistió', 30),
  ('OTHER', 'Otro', 90)
ON CONFLICT (code) DO NOTHING;

-- ── Célula ABAC (molde 488) ───────────────────────────────────────────────────
DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('catalog_service_exit_reasons', 'read',
       'Ver o catálogo de MOTIVOS DE SAÍDA do serviço (lista global de categorias genéricas, sem dado de paciente).',
       'Pacientes', 'worker-functions', NULL),
      ('catalog_service_exit_reasons', 'create',
       'Adicionar motivo de saída novo ao catálogo (backoffice).',
       'Pacientes', 'worker-functions', NULL),
      ('catalog_service_exit_reasons', 'update',
       'Renomear e desativar motivo de saída do catálogo (backoffice).',
       'Pacientes', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;

    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'catalog_service_exit_reasons'
    ON CONFLICT DO NOTHING;
  END IF;

  -- Espelho em public.* só se for tabela física (mesmo guard da 488).
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'permissions' AND c.relkind = 'r'
  ) THEN
    INSERT INTO public.permissions (resource, action, description, category)
    VALUES
      ('catalog_service_exit_reasons', 'read',
       'Ver o catálogo de MOTIVOS DE SAÍDA do serviço (lista global de categorias genéricas, sem dado de paciente).',
       'Pacientes'),
      ('catalog_service_exit_reasons', 'create',
       'Adicionar motivo de saída novo ao catálogo (backoffice).',
       'Pacientes'),
      ('catalog_service_exit_reasons', 'update',
       'Renomear e desativar motivo de saída do catálogo (backoffice).',
       'Pacientes')
    ON CONFLICT (resource, action) DO NOTHING;

    INSERT INTO public.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM public.permissions p
     WHERE p.resource = 'catalog_service_exit_reasons'
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;
