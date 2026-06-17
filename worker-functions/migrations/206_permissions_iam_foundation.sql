-- Migration 206: Fundação IAM para ABAC (Fase 2)
--
-- Cria o esquema completo de permissões multi-tenant:
--   1. tenants (seed do tenant Enlite, UUID fixo)
--   2. ALTER users: +tenant_id, +status; backfill; trigger sync is_active
--   3. permissions (seed exato da matriz 18 recursos × ações do 01-requirements)
--   4. permission_groups (tenant_id NOT NULL, UNIQUE por tenant)
--   5. group_permissions (PK composta, CASCADE)
--   6. user_groups (user_id→firebase_uid, tenant_id, assigned_by)
--   7. user_departments (user_id, department_name, tenant_id)
--   8. permission_audit_log (sem PII/user_agent; índices por user_id/resource/tenant)
--   9. função get_user_effective_permissions(p_user_id) → TEXT[]
--  10. seed dos 5 grupos de sistema + auto-assign por role + Super Admin members
--
-- Referências: docs/features/permissions/01-requirements-and-decisions.md
--              docs/features/permissions/02-architecture.md
-- ADR-005 (multi-tenant) · ADR-006 (Cerbos via permissions[] no JWT)

-- ═══════════════════════════════════════════════════════════════
-- 1. TABELA tenants
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(255) NOT NULL,
  region     VARCHAR(50)  NOT NULL CHECK (region IN ('SA', 'NA', 'EU', 'APAC')),
  status     VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenants IS 'Tenants da plataforma. Fase 1: Enlite é single-tenant (UUID fixo 00000000-...-0001). Multi-tenant completo é roadmap Fase 7.';

-- Seed: tenant Enlite com UUID canônico fixo
INSERT INTO tenants (id, name, region, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Enlite', 'SA', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 2. ALTER users: +tenant_id, +status; backfill; trigger is_active
-- ═══════════════════════════════════════════════════════════════

-- 2a. Adicionar colunas (nullable para ALTER seguro em banco com dados)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS status    VARCHAR(20) DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PENDING_ONBOARDING', 'SUSPENDED', 'DEACTIVATED'));

COMMENT ON COLUMN users.tenant_id IS 'Tenant do usuário. Nullable na transição; backfill para tenant Enlite. Será NOT NULL pós-migração de prod.';
COMMENT ON COLUMN users.status    IS 'Status operacional do usuário (enum). Mantido em sync com is_active via trigger. PENDING_ONBOARDING = acesso zero (só tela de onboarding).';

-- 2b. Backfill: todos os usuários existentes → tenant Enlite
UPDATE users
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

-- 2c. Backfill: status a partir de is_active
UPDATE users
SET status = CASE
  WHEN is_active = true  THEN 'ACTIVE'
  WHEN is_active = false THEN 'DEACTIVATED'
  ELSE 'ACTIVE'
END
WHERE status IS NULL;

-- 2d. Trigger: mantém is_active em sync com status (deprecated, não remover)
CREATE OR REPLACE FUNCTION sync_user_status_to_is_active()
RETURNS TRIGGER AS $$
BEGIN
  NEW.is_active := (NEW.status = 'ACTIVE');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sync_user_status_to_is_active() IS
  'Mantém users.is_active em sync com users.status durante período de transição. is_active é deprecated mas não removido (compatibilidade).';

DROP TRIGGER IF EXISTS trg_sync_user_status_to_is_active ON users;
CREATE TRIGGER trg_sync_user_status_to_is_active
  BEFORE INSERT OR UPDATE OF status ON users
  FOR EACH ROW
  EXECUTE FUNCTION sync_user_status_to_is_active();

-- ═══════════════════════════════════════════════════════════════
-- 3. TABELA permissions (seed exato da matriz 01-requirements)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS permissions (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  resource    VARCHAR(100) NOT NULL,
  action      VARCHAR(50)  NOT NULL,
  description TEXT,
  category    VARCHAR(100),
  UNIQUE (resource, action)
);

COMMENT ON TABLE permissions IS 'Permissões atômicas do sistema. Seed fixo da matriz 18 recursos × ações (01-requirements-and-decisions.md). Total: 41 permissões.';

-- Seed: matriz completa 18 recursos
-- Trabalhadores
INSERT INTO permissions (resource, action, description, category) VALUES
  ('worker',          'read',     'Visualizar dados básicos de workers',                 'Trabalhadores'),
  ('worker',          'write',    'Criar e editar dados básicos de workers',             'Trabalhadores'),
  ('worker',          'delete',   'Remover workers do sistema',                          'Trabalhadores'),
  ('worker',          'export',   'Exportar listagem de workers',                        'Trabalhadores'),
  ('worker_pii',      'read',     'Visualizar PII sensível de workers (CPF, endereço)',  'Trabalhadores'),
  ('worker_document', 'read',     'Visualizar documentos de workers',                   'Trabalhadores'),
  ('worker_document', 'write',    'Fazer upload de documentos de workers',               'Trabalhadores'),
  ('worker_document', 'delete',   'Remover documentos de workers',                       'Trabalhadores'),
  ('worker_document', 'validate', 'Validar/aprovar documentos de workers',               'Trabalhadores'),
-- Vagas e Funil
  ('vacancy',         'read',     'Visualizar vagas',                                    'Vagas e Funil'),
  ('vacancy',         'write',    'Criar e editar vagas',                                'Vagas e Funil'),
  ('vacancy',         'delete',   'Remover vagas',                                       'Vagas e Funil'),
  ('funnel',          'read',     'Visualizar funil de candidatos',                      'Vagas e Funil'),
  ('funnel',          'write',    'Mover candidatos no funil',                           'Vagas e Funil'),
  ('interview',       'read',     'Visualizar entrevistas',                              'Vagas e Funil'),
  ('interview',       'write',    'Agendar e editar entrevistas',                        'Vagas e Funil'),
  ('interview',       'delete',   'Cancelar/remover entrevistas',                        'Vagas e Funil'),
  ('match',           'read',     'Visualizar resultados de matching',                   'Vagas e Funil'),
  ('match',           'execute',  'Executar algoritmo de matching',                      'Vagas e Funil'),
-- Pacientes
  ('patient',         'read',     'Visualizar dados de pacientes (PII sensível)',        'Pacientes'),
  ('patient',         'write',    'Criar e editar dados de pacientes',                   'Pacientes'),
-- Recrutamento
  ('recruitment',     'read',     'Visualizar processos de recrutamento',                'Recrutamento'),
  ('recruitment',     'write',    'Gerenciar processos de recrutamento',                 'Recrutamento'),
  ('talentum',        'read',     'Visualizar dados do Talentum',                        'Recrutamento'),
  ('talentum',        'write',    'Sincronizar e editar dados do Talentum',              'Recrutamento'),
  ('prescreening',    'read',     'Visualizar prescreenings',                            'Recrutamento'),
  ('prescreening',    'write',    'Criar e editar prescreenings',                        'Recrutamento'),
-- Analytics / Operações
  ('analytics',       'read',     'Visualizar relatórios e analytics',                   'Analytics'),
  ('analytics',       'export',   'Exportar dados de analytics',                         'Analytics'),
  ('dedup',           'read',     'Visualizar duplicatas de workers',                     'Operações'),
  ('dedup',           'execute',  'Executar deduplicação de workers',                     'Operações'),
  ('dashboard',       'read',     'Visualizar dashboard operacional',                    'Operações'),
-- Comunicação
  ('messaging',       'read',     'Visualizar mensagens e conversas',                    'Comunicação'),
  ('messaging',       'send',     'Enviar mensagens (WhatsApp/notificações)',             'Comunicação'),
-- Importação
  ('upload',          'read',     'Visualizar arquivos importados',                      'Importação'),
  ('upload',          'write',    'Fazer upload e importar arquivos',                    'Importação'),
-- Administração
  ('user_management',       'read',   'Visualizar usuários do painel',                  'Administração'),
  ('user_management',       'write',  'Criar e editar usuários do painel',              'Administração'),
  ('user_management',       'delete', 'Remover usuários do painel',                     'Administração'),
  ('permission_management', 'read',   'Visualizar grupos e permissões',                  'Administração'),
  ('permission_management', 'write',  'Criar e editar grupos e permissões',              'Administração')
ON CONFLICT (resource, action) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 4. TABELA permission_groups
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS permission_groups (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id),
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  is_system   BOOLEAN      NOT NULL DEFAULT false,
  created_by  VARCHAR(128) REFERENCES users(firebase_uid),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

COMMENT ON TABLE permission_groups IS 'Grupos de permissão por tenant. Grupos is_system não são deletáveis nem renomeáveis (enforced na aplicação).';
COMMENT ON COLUMN permission_groups.is_system IS 'Grupos de sistema (Acesso Master, Recrutador, etc.) não são deletáveis via UI.';

-- ═══════════════════════════════════════════════════════════════
-- 5. TABELA group_permissions
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS group_permissions (
  group_id      UUID NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id)       ON DELETE CASCADE,
  PRIMARY KEY (group_id, permission_id)
);

COMMENT ON TABLE group_permissions IS 'Relação N:N entre grupos e permissões. CASCADE em deleção de grupo.';

-- ═══════════════════════════════════════════════════════════════
-- 6. TABELA user_groups
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_groups (
  user_id     VARCHAR(128) NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
  group_id    UUID         NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
  tenant_id   UUID         NOT NULL REFERENCES tenants(id),
  assigned_by VARCHAR(128) REFERENCES users(firebase_uid),
  assigned_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, group_id)
);

COMMENT ON TABLE user_groups IS 'Membros de cada grupo por tenant. PK(user_id, group_id). tenant_id desnormalizado para queries de isolation futuras.';

-- ═══════════════════════════════════════════════════════════════
-- 7. TABELA user_departments
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_departments (
  user_id         VARCHAR(128) NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
  department_name VARCHAR(100) NOT NULL,
  tenant_id       UUID         NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (user_id, department_name)
);

COMMENT ON TABLE user_departments IS 'Departamentos multi-valor por usuário (metadado). Scoping por departamento fica para Fase 8. Não é duplicata de users.department (que é lotação RH single-value).';

-- ═══════════════════════════════════════════════════════════════
-- 8. TABELA permission_audit_log
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS permission_audit_log (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id),
  user_id     VARCHAR(128) NOT NULL,
  resource    VARCHAR(100) NOT NULL,
  action      VARCHAR(50)  NOT NULL,
  resource_id TEXT,
  decision    VARCHAR(10)  NOT NULL CHECK (decision IN ('ALLOW', 'DENY')),
  ip_address  INET,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- NUNCA gravar PII nem user_agent nesta tabela (HIPAA 45 CFR 164.312(b) / LGPD).
COMMENT ON TABLE permission_audit_log IS
  'Audit log de decisões de acesso. NUNCA gravar PII (nome, email, telefone) nem user_agent. Logar DENY sempre + ALLOW só de PII/destrutivo (configurado por rota).';
COMMENT ON COLUMN permission_audit_log.user_id IS 'firebase_uid sem FK (permite log de tentativas de usuários não cadastrados).';
COMMENT ON COLUMN permission_audit_log.ip_address IS 'IP do cliente. Tipo INET (sem dados pessoais além do IP, aceito por HIPAA para audit).';

-- Índices de performance para queries de auditoria
CREATE INDEX IF NOT EXISTS idx_permission_audit_user_date
  ON permission_audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_permission_audit_resource_action
  ON permission_audit_log (resource, action);

CREATE INDEX IF NOT EXISTS idx_permission_audit_tenant_date
  ON permission_audit_log (tenant_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- 9. FUNÇÃO get_user_effective_permissions
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_user_effective_permissions(p_user_id VARCHAR)
RETURNS TEXT[] AS $$
  SELECT ARRAY(
    SELECT DISTINCT p.resource || ':' || p.action
    FROM user_groups ug
    JOIN group_permissions gp ON gp.group_id = ug.group_id
    JOIN permissions p         ON p.id        = gp.permission_id
    WHERE ug.user_id = p_user_id
    ORDER BY 1
  );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION get_user_effective_permissions(VARCHAR) IS
  'Retorna array TEXT[] com permissões efetivas do usuário no formato "resource:action". UNION dos grupos sem precedência negativa (Fase 1). Usado no login para emitir claims JWT.';

-- ═══════════════════════════════════════════════════════════════
-- 10. SEED: 5 grupos de sistema + group_permissions + auto-assign + Super Admin
-- ═══════════════════════════════════════════════════════════════

-- UUIDs fixos para os grupos de sistema (idempotência)
-- Acesso Master:       a0000000-0000-0000-0000-000000000001
-- Recrutador:          a0000000-0000-0000-0000-000000000002
-- Community Manager:   a0000000-0000-0000-0000-000000000003
-- Financeiro:          a0000000-0000-0000-0000-000000000004
-- Super Admin:         a0000000-0000-0000-0000-000000000005

DO $$
DECLARE
  v_tenant_id UUID := '00000000-0000-0000-0000-000000000001';

  -- Group UUIDs
  v_g_master UUID := 'a0000000-0000-0000-0000-000000000001';
  v_g_rec    UUID := 'a0000000-0000-0000-0000-000000000002';
  v_g_cm     UUID := 'a0000000-0000-0000-0000-000000000003';
  v_g_fin    UUID := 'a0000000-0000-0000-0000-000000000004';
  v_g_super  UUID := 'a0000000-0000-0000-0000-000000000005';

BEGIN

  -- ── Criar os 5 grupos ──────────────────────────────────────────
  INSERT INTO permission_groups (id, tenant_id, name, description, is_system)
  VALUES
    (v_g_master, v_tenant_id, 'Acesso Master',
     'Acesso completo a todas as permissões do sistema. Equivalente ao role admin.', true),
    (v_g_rec, v_tenant_id, 'Recrutador',
     'Pipeline completo de recrutamento. Sem worker:delete, dedup:execute, user_management:write/delete, permission_management:*.', true),
    (v_g_cm, v_tenant_id, 'Community Manager',
     'Leitura + comunicação com ATs. Sem escrita em vagas, entrevistas, Talentum, prescreening ou dedup.', true),
    (v_g_fin, v_tenant_id, 'Financeiro',
     'Placeholder — escopo defensivo (analytics, worker:read, vacancy:read, dashboard:read). Sign-off Gabriel pendente.', true),
    (v_g_super, v_tenant_id, 'Super Admin',
     'Permissões estruturais exclusivas (edição de perfil de worker, operações irreversíveis). Membros: gabriel.stein@, diego.trevisan@enlite.health.', true)
  ON CONFLICT (tenant_id, name) DO NOTHING;

  -- ── Acesso Master: todas as 43 permissões ─────────────────────
  INSERT INTO group_permissions (group_id, permission_id)
  SELECT v_g_master, id FROM permissions
  ON CONFLICT DO NOTHING;

  -- ── Recrutador: pipeline completo sem delete/dedup/user mgmt/permission mgmt ──
  INSERT INTO group_permissions (group_id, permission_id)
  SELECT v_g_rec, id FROM permissions
  WHERE NOT (
    (resource = 'worker'            AND action = 'delete')
    OR (resource = 'dedup'          AND action = 'execute')
    OR (resource = 'user_management'  AND action IN ('write', 'delete'))
    OR (resource = 'permission_management')
  )
  ON CONFLICT DO NOTHING;

  -- ── Community Manager: read + comunicação + dashboard ─────────
  -- Sem write em vacancy, sem interview/talentum/prescreening/dedup, sem user_mgmt/perm_mgmt
  INSERT INTO group_permissions (group_id, permission_id)
  SELECT v_g_cm, id FROM permissions
  WHERE (resource, action) IN (
    ('worker',          'read'),
    ('worker_pii',      'read'),
    ('worker_document', 'read'),
    ('funnel',          'read'),
    ('vacancy',         'read'),
    ('dashboard',       'read'),
    ('messaging',       'read'),
    ('messaging',       'send'),
    ('analytics',       'read'),
    ('upload',          'read')
  )
  ON CONFLICT DO NOTHING;

  -- ── Financeiro: escopo defensivo (placeholder — aguarda sign-off) ─
  INSERT INTO group_permissions (group_id, permission_id)
  SELECT v_g_fin, id FROM permissions
  WHERE (resource, action) IN (
    ('analytics', 'read'),
    ('analytics', 'export'),
    ('worker',    'read'),
    ('vacancy',   'read'),
    ('dashboard', 'read')
  )
  ON CONFLICT DO NOTHING;

  -- ── Super Admin: todas as permissões (placeholder — membros gerenciados via UI) ──
  -- Por ora recebe o mesmo conjunto do Acesso Master; permissões exclusivas serão
  -- adicionadas quando houver sign-off do Gabriel sobre worker:write estrutural.
  INSERT INTO group_permissions (group_id, permission_id)
  SELECT v_g_super, id FROM permissions
  ON CONFLICT DO NOTHING;

  -- ── Auto-assign de usuários existentes por role ───────────────
  -- admin → Acesso Master
  INSERT INTO user_groups (user_id, group_id, tenant_id)
  SELECT firebase_uid, v_g_master, v_tenant_id
  FROM users
  WHERE role = 'admin'
  ON CONFLICT (user_id, group_id) DO NOTHING;

  -- recruiter → Recrutador
  INSERT INTO user_groups (user_id, group_id, tenant_id)
  SELECT firebase_uid, v_g_rec, v_tenant_id
  FROM users
  WHERE role = 'recruiter'
  ON CONFLICT (user_id, group_id) DO NOTHING;

  -- community_manager → Community Manager
  INSERT INTO user_groups (user_id, group_id, tenant_id)
  SELECT firebase_uid, v_g_cm, v_tenant_id
  FROM users
  WHERE role = 'community_manager'
  ON CONFLICT (user_id, group_id) DO NOTHING;

  -- ── Super Admin members: gabriel.stein@ e diego.trevisan@ ─────
  -- INSERT só se existirem em users (NÃO falha se não existirem ainda)
  INSERT INTO user_groups (user_id, group_id, tenant_id)
  SELECT firebase_uid, v_g_super, v_tenant_id
  FROM users
  WHERE email IN ('gabriel.stein@enlite.health', 'diego.trevisan@enlite.health')
  ON CONFLICT (user_id, group_id) DO NOTHING;

END $$;

DO $$ BEGIN
  RAISE NOTICE 'Migration 206: IAM foundation criada. tenants, users.tenant_id/status, permissions (41), permission_groups (5 sistema), group_permissions, user_groups, user_departments, permission_audit_log, get_user_effective_permissions().';
END $$;
