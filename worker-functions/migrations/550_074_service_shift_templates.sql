-- Migration 550: catálogo de GUARDIAS PREDEFINIDAS (spec 074, D558, D560)
--
-- Catálogo GLOBAL (sem país, sem RLS, sem dado de paciente) de modelos de turnos: uma guardia é um
-- conjunto de faixas (início + duração). Baixa = active=false + deactivated_at, nunca DELETE.
-- Aplicar uma guardia COPIA os horários para as faixas do serviço; a faixa não guarda referência
-- ao modelo (por isso nada referencia este catálogo por FK).
--
-- Sobreposição DENTRO da guardia: barrada no banco, medida no dia circular de 24 h (D560: uma
-- guardia é a divisão de um dia). Um turno que passa da meia-noite (20:00 por 720) ocupa
-- [1200,1440) e [0,480) do mesmo dia — por isso 06:00 por 120 conflita com ele.
--
-- Célula ABAC `catalog_service_shift_templates` × read|create|update semeada AQUI (molde 492):
-- o sync do catálogo de permissões está desligado em produção. Concessão SÓ ao Acesso Master
-- (a0000000-0000-0000-0000-000000000001).
--
-- Idempotente (2×): IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS / ON CONFLICT.
-- Sem BEGIN/COMMIT próprio.
--
-- Rollback: `migrations/pending/ROLLBACK_550_074_service_shift_templates.sql`.

-- Minutos do dia ocupados por um turno (multirange no dia circular de 24 h; passa da meia-noite = 2 pedaços).
CREATE OR REPLACE FUNCTION shift_template_day_minutes(p_start time, p_duration int)
RETURNS int4multirange LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN (extract(hour from p_start)::int * 60 + extract(minute from p_start)::int) + p_duration <= 1440
      THEN int4multirange(int4range(
             extract(hour from p_start)::int * 60 + extract(minute from p_start)::int,
             extract(hour from p_start)::int * 60 + extract(minute from p_start)::int + p_duration))
    ELSE int4multirange(
           int4range(extract(hour from p_start)::int * 60 + extract(minute from p_start)::int, 1440),
           int4range(0, extract(hour from p_start)::int * 60 + extract(minute from p_start)::int + p_duration - 1440))
  END
$$;

CREATE TABLE IF NOT EXISTS service_shift_templates (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT         NOT NULL,
  label          TEXT         NOT NULL,
  sort_order     INT          NOT NULL DEFAULT 0,
  active         BOOLEAN      NOT NULL DEFAULT true,
  deactivated_at TIMESTAMPTZ  NULL,
  created_by     VARCHAR(128) NOT NULL DEFAULT 'seed:550',
  updated_by     VARCHAR(128) NOT NULL DEFAULT 'seed:550',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT sst_label_len CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  CONSTRAINT sst_active_pair CHECK ((active AND deactivated_at IS NULL) OR (NOT active AND deactivated_at IS NOT NULL)),
  CONSTRAINT sst_code_uq UNIQUE (code)
);

-- Rótulo único entre os ATIVOS (case-insensitive): desativar e recriar com o mesmo texto é permitido.
CREATE UNIQUE INDEX IF NOT EXISTS sst_label_ativo_unico
  ON service_shift_templates (lower(btrim(label))) WHERE active;

-- `code`: itens criados pelo admin não trazem código — o trigger usa o id; o código nunca muda depois.
CREATE OR REPLACE FUNCTION fn_service_shift_templates_code() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.code IS NULL THEN
      NEW.code := NEW.id::text;
    END IF;
  ELSIF NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'service_shift_templates.code é imutável';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sst_code_imutavel ON service_shift_templates;
CREATE TRIGGER sst_code_imutavel
  BEFORE INSERT OR UPDATE ON service_shift_templates
  FOR EACH ROW EXECUTE FUNCTION fn_service_shift_templates_code();

COMMENT ON TABLE service_shift_templates IS
  'Catálogo global (sem país, sem PHI) de guardias predefinidas (spec 074). `code` imutável (trigger). '
  'Baixa = active=false, nunca DELETE. Aplicar copia os horários; a faixa do serviço não guarda referência ao modelo.';

CREATE TABLE IF NOT EXISTS service_shift_template_items (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id      uuid         NOT NULL REFERENCES service_shift_templates(id) ON DELETE RESTRICT,
  start_time       time         NOT NULL,
  duration_minutes integer      NOT NULL,
  day_minutes      int4multirange GENERATED ALWAYS AS (shift_template_day_minutes(start_time, duration_minutes)) STORED,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ssti_duracao CHECK (duration_minutes BETWEEN 1 AND 1440)
);

-- No-op: a 526 já cria a extensão; mantida para a 550 não depender da ordem.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssti_sem_sobreposicao') THEN
    ALTER TABLE service_shift_template_items ADD CONSTRAINT ssti_sem_sobreposicao
      EXCLUDE USING gist (template_id WITH =, day_minutes WITH &&);
  END IF;
END $$;

-- Carga inicial (FR-01).
INSERT INTO service_shift_templates (code, label, sort_order) VALUES
  ('GUARDIAS_8_14_20', 'Guardias 8–14 · 14–20 · 20–8', 10),
  ('GUARDIA_24H', '24 h', 20)
ON CONFLICT (code) DO NOTHING;

INSERT INTO service_shift_template_items (template_id, start_time, duration_minutes)
SELECT t.id, v.s::time, v.d
  FROM service_shift_templates t
 CROSS JOIN (VALUES ('08:00',360),('14:00',360),('20:00',720)) AS v(s,d)
 WHERE t.code = 'GUARDIAS_8_14_20'
   AND NOT EXISTS (SELECT 1 FROM service_shift_template_items i
                     JOIN service_shift_templates t2 ON t2.id = i.template_id
                    WHERE t2.code = 'GUARDIAS_8_14_20');

INSERT INTO service_shift_template_items (template_id, start_time, duration_minutes)
SELECT t.id, v.s::time, v.d
  FROM service_shift_templates t
 CROSS JOIN (VALUES ('08:00',1440)) AS v(s,d)
 WHERE t.code = 'GUARDIA_24H'
   AND NOT EXISTS (SELECT 1 FROM service_shift_template_items i
                     JOIN service_shift_templates t2 ON t2.id = i.template_id
                    WHERE t2.code = 'GUARDIA_24H');

-- Baixa é active=false: sem DELETE na guardia. Nos ITENS não se revoga (o PATCH substitui os itens).
REVOKE DELETE ON service_shift_templates FROM app_runtime, app_system;

-- ── Célula ABAC (molde 492) ───────────────────────────────────────────────────
DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('catalog_service_shift_templates', 'read',
       'Ver o catálogo de GUARDIAS PREDEFINIDAS (modelos globais de turnos, sem dado de paciente).',
       'Pacientes', 'worker-functions', NULL),
      ('catalog_service_shift_templates', 'create',
       'Adicionar guardia predefinida ao catálogo (backoffice).',
       'Pacientes', 'worker-functions', NULL),
      ('catalog_service_shift_templates', 'update',
       'Renomear, trocar os turnos e desativar guardia predefinida (backoffice).',
       'Pacientes', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;

    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'catalog_service_shift_templates'
    ON CONFLICT DO NOTHING;
  END IF;

  -- Espelho em public.* só se for tabela física (mesmo guard da 488).
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'permissions' AND c.relkind = 'r'
  ) THEN
    INSERT INTO public.permissions (resource, action, description, category)
    VALUES
      ('catalog_service_shift_templates', 'read',
       'Ver o catálogo de GUARDIAS PREDEFINIDAS (modelos globais de turnos, sem dado de paciente).',
       'Pacientes'),
      ('catalog_service_shift_templates', 'create',
       'Adicionar guardia predefinida ao catálogo (backoffice).',
       'Pacientes'),
      ('catalog_service_shift_templates', 'update',
       'Renomear, trocar os turnos e desativar guardia predefinida (backoffice).',
       'Pacientes')
    ON CONFLICT (resource, action) DO NOTHING;

    INSERT INTO public.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM public.permissions p
     WHERE p.resource = 'catalog_service_shift_templates'
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;
