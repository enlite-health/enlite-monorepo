<!-- RECUPERADO de refs/heads/backup/vacancy-refactor-2026-05-06 (2026-06-15). Status: SUPERSEDED — base histórica.
     Foi escrito DB-DRIVEN + SINGLE-TENANT. Decisão atual reverte para CERBOS + MULTI-TENANT.
     Use como esqueleto de schema/use-cases/testes, NÃO como decisão arquitetural vigente.
     Plano vigente: docs/features/permissions/00-master-plan.md -->

# Sistema de Permissões Dinâmico — Especificação Completa

## Contexto

A Enlite opera com dados de saúde (ATs, pacientes, supervisão clínica) e precisa de um sistema de permissões que:

1. Permita ao admin **criar grupos** via tela e **atribuir permissões** a cada grupo
2. Controle acesso a **telas**, **componentes**, **edição** e **visualização**
3. Atenda requisitos de **LGPD** e **HIPAA** (audit trail, minimum necessary access, PII segregation)

### O que já existe no projeto (REUTILIZAR — não duplicar)

| Componente | Arquivo | Status |
|---|---|---|
| `EnliteRole` enum (admin/recruiter/community_manager) | `worker-functions/src/domain/entities/EnliteRole.ts` e `enlite-frontend/src/domain/entities/EnliteRole.ts` | Ativo — MANTER como role base |
| `AuthMiddleware` com `requireAuth`, `requireStaff`, `requireAdmin`, `requirePermission` | `worker-functions/src/interfaces/middleware/AuthMiddleware.ts` | Ativo — ESTENDER |
| `Auth.ts` com `ResourceType`, `Action`, `AuthContext`, `Principal`, `AccessDecision` | `worker-functions/src/domain/interfaces/Auth.ts` | Ativo — ESTENDER os enums |
| `SimplifiedAuthorizationEngine` (allow-all) | `worker-functions/src/infrastructure/services/SimplifiedAuthorizationEngine.ts` | Ativo — SUBSTITUIR |
| `CerbosAuthorizationAdapter` | `worker-functions/src/infrastructure/services/CerbosAuthorizationAdapter.ts` | Desligado — MANTER para futuro ABAC |
| `PermissionGate` component | `enlite-frontend/src/presentation/components/features/auth/PermissionGate.tsx` | Pronto — ADAPTAR data source |
| `usePermissions` hook | `enlite-frontend/src/presentation/hooks/usePermissions.ts` | Pronto — ADAPTAR data source |
| `CerbosAuthorizationRepository` + DI Container | `enlite-frontend/src/infrastructure/repositories/CerbosAuthorizationRepository.ts` | Pronto — MANTER, adicionar alternativa DB-driven |
| Sidebar com propriedade `enabled` no `AppSidebarNavItem` | `enlite-frontend/src/presentation/config/adminNavigation.tsx` | Pronto — USAR para filtrar menus |
| `adminAuthStore` (Zustand) com `adminProfile` | `enlite-frontend/src/presentation/stores/adminAuthStore.ts` | Ativo — ESTENDER com permissions |
| `AdminApiService` (HTTP client) | `enlite-frontend/src/infrastructure/http/AdminApiService.ts` | Ativo — ADICIONAR endpoints |
| `admins_extension.permissions` JSONB column | `worker-functions/migrations/005_create_future_role_tables.sql` | Existe — DEPRECAR em favor de groups |
| `GetAdminProfileUseCase` | `worker-functions/src/application/use-cases/GetAdminProfileUseCase.ts` | Ativo — ESTENDER para retornar permissions |
| `AdminRepository` | `worker-functions/src/infrastructure/repositories/AdminRepository.ts` | Ativo — ESTENDER |

---

## Decisões arquiteturais

### Por que DB-driven e não Cerbos puro?

O Cerbos (`@cerbos/http` v0.26.0) já está integrado mas precisa de um servidor separado e suas policies são YAML estático. O requisito é **grupos dinâmicos criados via UI**, o que não combina com policy-as-code.

**Decisão**: DB-driven para RBAC (90% dos casos), Cerbos reservado para futuro ABAC (condições baseadas em atributos como "só vê workers da sua zona"). O switch `USE_CERBOS` permanece para ativação futura.

### Por que manter EnliteRole?

`EnliteRole` (`admin`, `recruiter`, `community_manager`) é o **role base** gravado em `users.role` e nos Firebase custom claims. Ele define **quem é staff** (pode acessar `/admin`). O sistema de grupos é uma camada ACIMA que define **o que cada staff pode fazer**.

Fluxo: `requireStaff()` → confere se é staff → `requireGroupPermission()` → confere se tem a permission específica.

### Por que permissions são seed e não criadas via UI?

Cada permission (`worker:read`, `vacancy:write`) é amarrada a um `if` no código — um `PermissionGate` no frontend ou um middleware no backend. Uma permission criada via UI sem código que a verifique não faz nada. O dev cria a permission (1 linha SQL), o admin combina permissions em grupos.

---

## FASE 1 — Schema de banco (BLOQUEANTE)

### Migration 103: Sistema de permissões

**Arquivo**: `worker-functions/migrations/103_permission_system.sql`

```sql
-- ============================================================================
-- SISTEMA DE PERMISSOES DINAMICO
-- Tabelas: permissions, permission_groups, group_permissions, user_groups
-- ============================================================================

-- 1. PERMISSIONS — "átomos" do sistema. Seed-only, não editável via UI.
-- Cada row mapeia 1:1 para um PermissionGate no frontend ou middleware no backend.
CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource VARCHAR(50) NOT NULL,    -- ex: 'worker', 'vacancy', 'worker_pii'
    action VARCHAR(50) NOT NULL,      -- ex: 'read', 'write', 'delete', 'export'
    description TEXT NOT NULL,        -- descrição legível para a UI de grupos
    category VARCHAR(50) NOT NULL,    -- agrupamento visual na UI: 'Trabalhadores', 'Vagas', etc.
    UNIQUE(resource, action)
);

-- 2. PERMISSION_GROUPS — grupos criados pelo admin via tela.
CREATE TABLE permission_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT false,  -- true = não pode ser deletado (Admin, Recrutador, etc.)
    created_by VARCHAR(128) REFERENCES users(firebase_uid),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_permission_groups_updated_at
    BEFORE UPDATE ON permission_groups
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 3. GROUP_PERMISSIONS — quais permissions um grupo tem (checkboxes na UI).
CREATE TABLE group_permissions (
    group_id UUID NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, permission_id)
);

-- 4. USER_GROUPS — quais grupos um usuário pertence.
-- Um usuário pode pertencer a múltiplos grupos. Effective permissions = UNION de todos.
CREATE TABLE user_groups (
    user_id VARCHAR(128) NOT NULL REFERENCES users(firebase_uid) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
    assigned_by VARCHAR(128) REFERENCES users(firebase_uid),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, group_id)
);

-- 5. AUDIT LOG — quem acessou qual recurso (HIPAA/LGPD obrigatório)
CREATE TABLE permission_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(128) NOT NULL,
    resource VARCHAR(50) NOT NULL,
    action VARCHAR(50) NOT NULL,
    resource_id VARCHAR(255),         -- ID do recurso acessado (worker_id, vacancy_id, etc.)
    decision VARCHAR(10) NOT NULL,    -- 'ALLOW' ou 'DENY'
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Particionar por mês para performance (audit logs crescem rápido)
CREATE INDEX idx_permission_audit_log_user ON permission_audit_log(user_id);
CREATE INDEX idx_permission_audit_log_created ON permission_audit_log(created_at);
CREATE INDEX idx_permission_audit_log_resource ON permission_audit_log(resource, action);

-- 6. INDEXES
CREATE INDEX idx_user_groups_user ON user_groups(user_id);
CREATE INDEX idx_user_groups_group ON user_groups(group_id);
CREATE INDEX idx_group_permissions_group ON group_permissions(group_id);
CREATE INDEX idx_permissions_resource ON permissions(resource);
CREATE INDEX idx_permissions_category ON permissions(category);

-- 7. COMMENTS
COMMENT ON TABLE permissions IS 'Permissões atômicas do sistema. Seed-only — cada row mapeia para um check no código.';
COMMENT ON TABLE permission_groups IS 'Grupos de permissão. Admin cria/edita via tela. is_system=true não pode ser deletado.';
COMMENT ON TABLE group_permissions IS 'Associação grupo ↔ permissão. Admin edita via checkboxes na tela de grupos.';
COMMENT ON TABLE user_groups IS 'Associação usuário ↔ grupo. Um user pode ter N grupos. Effective permissions = UNION.';
COMMENT ON TABLE permission_audit_log IS 'Audit trail de acessos. HIPAA/LGPD obrigatório. Nunca deletar.';

-- ============================================================================
-- SEED: PERMISSIONS (átomos do sistema)
-- ============================================================================

INSERT INTO permissions (resource, action, description, category) VALUES
    -- Trabalhadores (Workers)
    ('worker', 'read', 'Ver lista e detalhe de workers/ATs', 'Trabalhadores'),
    ('worker', 'write', 'Criar e editar workers/ATs', 'Trabalhadores'),
    ('worker', 'delete', 'Deletar workers/ATs', 'Trabalhadores'),
    ('worker', 'export', 'Exportar dados de workers', 'Trabalhadores'),
    ('worker_pii', 'read', 'Ver dados pessoais sensíveis (nome, CPF, telefone, endereço)', 'Trabalhadores'),

    -- Vagas (Vacancies)
    ('vacancy', 'read', 'Ver lista e detalhe de vagas', 'Vagas'),
    ('vacancy', 'write', 'Criar e editar vagas', 'Vagas'),
    ('vacancy', 'delete', 'Deletar vagas', 'Vagas'),

    -- Encuadres & Kanban
    ('encuadre', 'read', 'Ver encuadres e funnel kanban', 'Vagas'),
    ('encuadre', 'write', 'Mover encuadres no kanban e editar resultados', 'Vagas'),

    -- Recrutamento
    ('recruitment', 'read', 'Ver dashboard de recrutamento e métricas', 'Recrutamento'),
    ('recruitment', 'write', 'Calcular reemplazos e executar ações de recrutamento', 'Recrutamento'),

    -- Analytics & BI
    ('analytics', 'read', 'Ver analytics, BI e dashboards', 'Analytics'),
    ('analytics', 'export', 'Exportar relatórios de analytics', 'Analytics'),

    -- Dedup (operação destrutiva)
    ('dedup', 'read', 'Ver candidatos duplicados', 'Analytics'),
    ('dedup', 'execute', 'Executar merge de duplicados', 'Analytics'),

    -- Entrevistas
    ('interview', 'read', 'Ver slots de entrevista', 'Entrevistas'),
    ('interview', 'write', 'Criar, agendar e cancelar entrevistas', 'Entrevistas'),

    -- Mensageria (WhatsApp/SMS)
    ('messaging', 'read', 'Ver histórico de mensagens', 'Comunicação'),
    ('messaging', 'send', 'Enviar mensagens via WhatsApp/SMS', 'Comunicação'),

    -- Dashboard Coordenadores
    ('dashboard', 'read', 'Ver dashboard de coordenadores e alertas', 'Dashboard'),

    -- Importação de arquivos
    ('upload', 'read', 'Ver histórico de importações', 'Importação'),
    ('upload', 'write', 'Importar planilhas Excel', 'Importação'),

    -- Gerenciamento de usuários staff
    ('user_management', 'read', 'Ver lista de usuários do painel admin', 'Administração'),
    ('user_management', 'write', 'Criar e editar usuários do painel', 'Administração'),
    ('user_management', 'delete', 'Deletar usuários do painel', 'Administração'),

    -- Gerenciamento de grupos/permissões
    ('permission_management', 'read', 'Ver grupos e permissões', 'Administração'),
    ('permission_management', 'write', 'Criar/editar grupos e atribuir permissões', 'Administração');

-- ============================================================================
-- SEED: SYSTEM GROUPS (não deletáveis)
-- ============================================================================

INSERT INTO permission_groups (name, description, is_system) VALUES
    ('Administrador', 'Acesso total ao sistema. Gerencia usuários, grupos e configurações.', true),
    ('Recrutador', 'Pipeline de recrutamento: workers, vagas, encuadres, entrevistas.', true),
    ('Community Manager', 'Operação e comunicação: workers, mensageria, acompanhamento.', true);

-- Administrador: TODAS as permissions
INSERT INTO group_permissions (group_id, permission_id)
SELECT pg.id, p.id
FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.name = 'Administrador';

-- Recrutador: acesso operacional completo, sem admin
INSERT INTO group_permissions (group_id, permission_id)
SELECT pg.id, p.id
FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.name = 'Recrutador'
  AND (p.resource, p.action) IN (
    ('worker', 'read'), ('worker', 'write'), ('worker_pii', 'read'),
    ('vacancy', 'read'), ('vacancy', 'write'), ('vacancy', 'delete'),
    ('encuadre', 'read'), ('encuadre', 'write'),
    ('recruitment', 'read'), ('recruitment', 'write'),
    ('analytics', 'read'),
    ('dedup', 'read'),
    ('interview', 'read'), ('interview', 'write'),
    ('messaging', 'read'), ('messaging', 'send'),
    ('dashboard', 'read'),
    ('upload', 'read'), ('upload', 'write'),
    ('user_management', 'read')
  );

-- Community Manager: leitura + comunicação, sem gestão de vagas
INSERT INTO group_permissions (group_id, permission_id)
SELECT pg.id, p.id
FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.name = 'Community Manager'
  AND (p.resource, p.action) IN (
    ('worker', 'read'), ('worker', 'write'), ('worker_pii', 'read'),
    ('vacancy', 'read'),
    ('encuadre', 'read'),
    ('recruitment', 'read'),
    ('analytics', 'read'),
    ('messaging', 'read'), ('messaging', 'send'),
    ('dashboard', 'read'),
    ('upload', 'read'),
    ('user_management', 'read')
  );

-- ============================================================================
-- AUTO-ASSIGN: vincular usuários existentes aos grupos do sistema
-- ============================================================================

-- Admins existentes → grupo "Administrador"
INSERT INTO user_groups (user_id, group_id)
SELECT u.firebase_uid, pg.id
FROM users u
CROSS JOIN permission_groups pg
WHERE u.role = 'admin' AND pg.name = 'Administrador'
ON CONFLICT DO NOTHING;

-- Recruiters existentes → grupo "Recrutador"
INSERT INTO user_groups (user_id, group_id)
SELECT u.firebase_uid, pg.id
FROM users u
CROSS JOIN permission_groups pg
WHERE u.role = 'recruiter' AND pg.name = 'Recrutador'
ON CONFLICT DO NOTHING;

-- Community Managers existentes → grupo "Community Manager"
INSERT INTO user_groups (user_id, group_id)
SELECT u.firebase_uid, pg.id
FROM users u
CROSS JOIN permission_groups pg
WHERE u.role = 'community_manager' AND pg.name = 'Community Manager'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- FUNCTION: get_user_effective_permissions(firebase_uid)
-- Retorna ARRAY de strings 'resource:action' para o usuário.
-- Chamada pelo backend no login e pelo middleware em cada request (com cache).
-- ============================================================================

CREATE OR REPLACE FUNCTION get_user_effective_permissions(p_user_id VARCHAR)
RETURNS TEXT[] AS $$
    SELECT COALESCE(
        ARRAY_AGG(DISTINCT p.resource || ':' || p.action ORDER BY p.resource || ':' || p.action),
        ARRAY[]::TEXT[]
    )
    FROM user_groups ug
    JOIN group_permissions gp ON gp.group_id = ug.group_id
    JOIN permissions p ON p.id = gp.permission_id
    WHERE ug.user_id = p_user_id;
$$ LANGUAGE sql STABLE;

-- ============================================================================
-- FUNCTION: get_user_groups(firebase_uid)
-- Retorna os grupos do usuário como JSON array.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_user_groups(p_user_id VARCHAR)
RETURNS JSONB AS $$
    SELECT COALESCE(
        jsonb_agg(jsonb_build_object(
            'id', pg.id,
            'name', pg.name,
            'isSystem', pg.is_system
        )),
        '[]'::jsonb
    )
    FROM user_groups ug
    JOIN permission_groups pg ON pg.id = ug.group_id
    WHERE ug.user_id = p_user_id;
$$ LANGUAGE sql STABLE;
```

### O que a IA DEVE GARANTIR nesta migration

- [ ] **BLOQUEANTE**: Todas as 28 permissions do seed existem na tabela `permissions` após execução
- [ ] **BLOQUEANTE**: Os 3 grupos de sistema existem com `is_system = true`
- [ ] **BLOQUEANTE**: O grupo "Administrador" tem TODAS as 28 permissions
- [ ] **BLOQUEANTE**: Todos os `users` existentes com `role IN ('admin','recruiter','community_manager')` foram vinculados ao grupo correspondente na `user_groups`
- [ ] A function `get_user_effective_permissions` retorna `TEXT[]` — ex: `{'worker:read','worker:write','vacancy:read'}`
- [ ] A function `get_user_groups` retorna `JSONB` — ex: `[{"id":"uuid","name":"Recrutador","isSystem":true}]`
- [ ] **BLOQUEANTE**: `ON DELETE CASCADE` em todas as FKs — deletar um grupo remove suas `group_permissions` e `user_groups`
- [ ] A tabela `permission_audit_log` existe com indexes em `user_id`, `created_at`, e `(resource, action)`
- [ ] **Testar localmente**: `SELECT get_user_effective_permissions('<firebase_uid_de_um_admin>');` retorna array com todas as 28 permissions

---

## FASE 2 — Backend: endpoints e middleware (BLOQUEANTE)

### 2.1 — Domain: interfaces e entidades

**Arquivo a ESTENDER**: `worker-functions/src/domain/interfaces/Auth.ts`

Adicionar ao enum `ResourceType` os recursos do sistema de permissões:

```typescript
// ADICIONAR — NÃO substituir os existentes
VACANCY = 'vacancy',
ENCUADRE = 'encuadre',
RECRUITMENT = 'recruitment',
ANALYTICS = 'analytics',
DEDUP = 'dedup',
INTERVIEW = 'interview',
MESSAGING = 'messaging',
DASHBOARD = 'dashboard',
UPLOAD = 'upload',
USER_MANAGEMENT = 'user_management',
PERMISSION_MANAGEMENT = 'permission_management',
WORKER_PII = 'worker_pii',
```

Adicionar ao enum `Action`:

```typescript
// ADICIONAR — NÃO substituir os existentes
EXPORT = 'export',
SEND = 'send',
```

**O que a IA DEVE GARANTIR**:
- [ ] Os valores existentes do enum `ResourceType` NÃO foram removidos ou renomeados
- [ ] Os valores existentes do enum `Action` NÃO foram removidos ou renomeados
- [ ] Não houve breaking change em nenhum import que usa esses enums

---

### 2.2 — Domain: entidades do sistema de permissões

**Arquivo NOVO**: `worker-functions/src/domain/entities/Permission.ts`

```typescript
export interface Permission {
  id: string;
  resource: string;
  action: string;
  description: string;
  category: string;
}

export interface PermissionGroup {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  permissions?: Permission[];   // populado quando necessário
  memberCount?: number;         // populado em listagens
}

export interface UserGroupAssignment {
  userId: string;
  groupId: string;
  assignedBy: string | null;
  assignedAt: string;
}

/** Array de strings 'resource:action' retornado por get_user_effective_permissions() */
export type EffectivePermissions = string[];

/** Formato usado pelo frontend para decidir visibilidade */
export interface PermissionSet {
  permissions: EffectivePermissions;
  groups: Array<{ id: string; name: string; isSystem: boolean }>;
}
```

**O que a IA DEVE GARANTIR**:
- [ ] As interfaces estão em `domain/entities/` seguindo Clean Architecture
- [ ] Nenhuma dependência de infraestrutura (sem imports de Express, pg, etc.)

---

### 2.3 — Infrastructure: PermissionRepository

**Arquivo NOVO**: `worker-functions/src/infrastructure/repositories/PermissionRepository.ts`

Este repositório encapsula TODAS as queries do sistema de permissões.

**Métodos obrigatórios**:

| Método | SQL | Retorno |
|---|---|---|
| `listPermissions()` | `SELECT * FROM permissions ORDER BY category, resource, action` | `Permission[]` |
| `listGroups()` | `SELECT pg.*, COUNT(ug.user_id) as member_count FROM permission_groups pg LEFT JOIN user_groups ug...` | `PermissionGroup[]` (com `memberCount`) |
| `getGroupById(id)` | `SELECT pg.*, permissions via group_permissions JOIN` | `PermissionGroup` (com `permissions[]`) |
| `createGroup(name, description, createdBy)` | `INSERT INTO permission_groups...` | `PermissionGroup` |
| `updateGroup(id, name, description)` | `UPDATE permission_groups SET... WHERE id=$1 AND is_system=false` — **BLOQUEANTE**: NÃO permitir renomear grupo de sistema | `PermissionGroup` |
| `deleteGroup(id)` | `DELETE FROM permission_groups WHERE id=$1 AND is_system=false` — **BLOQUEANTE**: NÃO deletar grupo de sistema | `boolean` |
| `setGroupPermissions(groupId, permissionIds[])` | Dentro de transaction: `DELETE FROM group_permissions WHERE group_id=$1` + `INSERT INTO group_permissions...` batch | `void` |
| `listGroupMembers(groupId)` | `SELECT u.firebase_uid, u.email, u.display_name, u.role FROM users u JOIN user_groups ug...` | `Array<{userId, email, displayName, role}>` |
| `addUserToGroup(userId, groupId, assignedBy)` | `INSERT INTO user_groups... ON CONFLICT DO NOTHING` | `void` |
| `removeUserFromGroup(userId, groupId)` | `DELETE FROM user_groups WHERE user_id=$1 AND group_id=$2` | `void` |
| `getUserEffectivePermissions(userId)` | `SELECT get_user_effective_permissions($1)` | `string[]` — ex: `['worker:read','vacancy:write']` |
| `getUserGroups(userId)` | `SELECT get_user_groups($1)` | `Array<{id, name, isSystem}>` |
| `logAccess(userId, resource, action, resourceId, decision, ipAddress, userAgent)` | `INSERT INTO permission_audit_log...` | `void` |
| `getDefaultGroupForRole(role)` | `SELECT id FROM permission_groups WHERE name = CASE role WHEN 'admin' THEN 'Administrador' WHEN 'recruiter' THEN 'Recrutador' WHEN 'community_manager' THEN 'Community Manager' END` | `string` (group ID) |

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: `deleteGroup` tem cláusula `AND is_system = false`. Se o grupo é de sistema, retorna `false` sem deletar
- [ ] **BLOQUEANTE**: `setGroupPermissions` usa TRANSACTION (BEGIN/COMMIT/ROLLBACK) para evitar estado inconsistente
- [ ] **BLOQUEANTE**: `logAccess` NUNCA loga PII (nome, email, CPF). Apenas `userId` (firebase_uid), `resource`, `action`, `resourceId`
- [ ] `getUserEffectivePermissions` chama a function SQL `get_user_effective_permissions()` — NÃO reimplementa a lógica em TypeScript
- [ ] O repositório recebe `Pool` via constructor (mesmo padrão de `AdminRepository`)
- [ ] Testes unitários com mock de `Pool` seguindo o padrão existente em `src/interfaces/controllers/__tests__/`

---

### 2.4 — Application: Use Cases

**Arquivos NOVOS** em `worker-functions/src/application/use-cases/`:

#### 2.4.1 — `ListPermissionsUseCase.ts`
- Input: nenhum
- Output: `Permission[]` agrupadas por `category`
- Lógica: chama `permissionRepo.listPermissions()`
- Usado pela tela de edição de grupo (mostra checkboxes por categoria)

#### 2.4.2 — `ListGroupsUseCase.ts`
- Input: nenhum
- Output: `PermissionGroup[]` com `memberCount`
- Lógica: chama `permissionRepo.listGroups()`

#### 2.4.3 — `GetGroupDetailUseCase.ts`
- Input: `groupId: string`
- Output: `PermissionGroup` com `permissions[]` e membros
- Lógica: chama `getGroupById` + `listGroupMembers`

#### 2.4.4 — `CreateGroupUseCase.ts`
- Input: `{ name, description, createdBy }`
- Validação Zod: `name` min 3, max 100, único
- Output: `PermissionGroup`
- **BLOQUEANTE**: Se o nome já existe, retornar erro claro (`Group name already exists`)

#### 2.4.5 — `UpdateGroupUseCase.ts`
- Input: `{ groupId, name?, description?, permissionIds[] }`
- **BLOQUEANTE**: Se `is_system = true`, permite alterar `description` e `permissionIds`, mas NÃO o `name`
- Se `permissionIds` foi fornecido, chama `setGroupPermissions` dentro de transaction
- Output: `PermissionGroup` atualizado

#### 2.4.6 — `DeleteGroupUseCase.ts`
- Input: `groupId`
- **BLOQUEANTE**: Se `is_system = true`, retorna `Result.fail('Cannot delete system group')`
- **BLOQUEANTE**: Se o grupo tem membros, retorna `Result.fail('Group has N members. Remove members before deleting.')`
- Output: `Result<void>`

#### 2.4.7 — `AssignUserToGroupUseCase.ts`
- Input: `{ userId, groupId, assignedBy }`
- Validação: verifica se user e group existem
- Output: `Result<void>`

#### 2.4.8 — `RemoveUserFromGroupUseCase.ts`
- Input: `{ userId, groupId }`
- **BLOQUEANTE**: Se for o ÚLTIMO admin no grupo "Administrador", retornar `Result.fail('Cannot remove the last administrator')`. Isso evita lockout total.
- Output: `Result<void>`

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: Cada use case tem validação de input com Zod
- [ ] **BLOQUEANTE**: Nenhum use case contém lógica de HTTP (req, res) — Clean Architecture
- [ ] **BLOQUEANTE**: `RemoveUserFromGroupUseCase` implementa a proteção contra lockout (último admin)
- [ ] **BLOQUEANTE**: `DeleteGroupUseCase` verifica `is_system` E `memberCount > 0`
- [ ] Todos os use cases retornam `Result<T>` seguindo o padrão existente em `domain/shared/Result.ts`

---

### 2.5 — Interface: PermissionController

**Arquivo NOVO**: `worker-functions/src/interfaces/controllers/PermissionController.ts`

**Endpoints**:

| Método | Path | Middleware | Descrição |
|---|---|---|---|
| GET | `/api/admin/permissions` | `requireStaff()` | Lista todas as permissions (seed) agrupadas por category |
| GET | `/api/admin/permission-groups` | `requireStaff()` | Lista todos os grupos com memberCount |
| GET | `/api/admin/permission-groups/:id` | `requireStaff()` | Detalhe de um grupo com permissions e membros |
| POST | `/api/admin/permission-groups` | `requireGroupPermission('permission_management','write')` | Cria grupo novo |
| PUT | `/api/admin/permission-groups/:id` | `requireGroupPermission('permission_management','write')` | Atualiza grupo (nome, description, permissions) |
| DELETE | `/api/admin/permission-groups/:id` | `requireGroupPermission('permission_management','write')` | Deleta grupo (non-system, sem membros) |
| POST | `/api/admin/permission-groups/:id/members` | `requireGroupPermission('permission_management','write')` | Adiciona membro ao grupo. Body: `{ userId }` |
| DELETE | `/api/admin/permission-groups/:id/members/:userId` | `requireGroupPermission('permission_management','write')` | Remove membro do grupo |

**O que a IA DEVE GARANTIR**:
- [ ] Controller não contém lógica de negócio — delega tudo ao use case correspondente
- [ ] Respostas seguem o padrão `{ success: true, data: ... }` ou `{ success: false, error: '...' }`
- [ ] Todos os endpoints estão registrados em `index.ts`
- [ ] Endpoints de escrita (POST/PUT/DELETE) exigem `permission_management:write`
- [ ] Endpoints de leitura (GET) exigem `requireStaff()` — qualquer staff pode visualizar

---

### 2.6 — Middleware: requireGroupPermission (BLOQUEANTE)

**Arquivo a ESTENDER**: `worker-functions/src/interfaces/middleware/AuthMiddleware.ts`

Adicionar novo método ao `AuthMiddleware`:

```typescript
/**
 * Verifica se o usuário autenticado tem a permission 'resource:action'
 * baseada nos seus grupos.
 *
 * Fluxo:
 * 1. requireAuth() → extrai firebase_uid
 * 2. Busca effective permissions do user (com cache em req)
 * 3. Verifica se 'resource:action' está no array
 * 4. Loga acesso no audit log (ALLOW ou DENY)
 */
requireGroupPermission(resource: string, action: string) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        await this.requireStaff()(req, res, async () => {
            const user = (req as any).user;
            const permKey = `${resource}:${action}`;

            // Cache permissions no request para evitar N queries na mesma request
            if (!(req as any)._effectivePermissions) {
                (req as any)._effectivePermissions =
                    await this.permissionRepo.getUserEffectivePermissions(user.uid);
            }

            const perms: string[] = (req as any)._effectivePermissions;
            const allowed = perms.includes(permKey);

            // Audit log (fire-and-forget — não bloqueia a request)
            this.permissionRepo.logAccess(
                user.uid, resource, action,
                req.params.id || null,
                allowed ? 'ALLOW' : 'DENY',
                req.ip || 'unknown',
                req.headers['user-agent'] || null
            ).catch(() => {}); // Não falha a request se o log falhar

            if (!allowed) {
                res.status(403).json({
                    success: false,
                    error: 'Permission denied',
                    required: permKey,
                });
                return;
            }

            next();
        });
    };
}
```

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: O `AuthMiddleware` recebe `PermissionRepository` via constructor. Atualizar a instanciação em `index.ts`
- [ ] **BLOQUEANTE**: Permissions são cacheadas em `req._effectivePermissions` para evitar múltiplas queries na mesma request
- [ ] **BLOQUEANTE**: Audit log é fire-and-forget (`catch(() => {})`) — falha no log NUNCA bloqueia a request
- [ ] **BLOQUEANTE**: O middleware chama `requireStaff()` internamente — se não é staff, retorna 403 antes de verificar permissions
- [ ] O padrão `requirePermission(resourceType, action)` que já existe continua funcionando — NÃO quebrá-lo

---

### 2.7 — Estender GetAdminProfileUseCase (BLOQUEANTE)

**Arquivo a ESTENDER**: `worker-functions/src/application/use-cases/GetAdminProfileUseCase.ts`

Após buscar o `adminRecord`, adicionar:

```typescript
const permissions = await this.permissionRepo.getUserEffectivePermissions(firebaseUid);
const groups = await this.permissionRepo.getUserGroups(firebaseUid);

return Result.ok({
    ...adminRecord,
    permissions,   // string[] — ex: ['worker:read','vacancy:write']
    groups,        // Array<{id, name, isSystem}>
});
```

**Auto-provisioning**: Quando um `@enlite.health` loga pela primeira vez, o use case já cria o user com role `recruiter`. Adicionar:

```typescript
// Após criar o user com create_user_with_role:
const defaultGroupId = await this.permissionRepo.getDefaultGroupForRole(provisionedRole);
if (defaultGroupId) {
    await this.permissionRepo.addUserToGroup(firebaseUid, defaultGroupId, 'system');
}
```

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: O response de `/api/admin/auth/profile` agora inclui `permissions: string[]` e `groups: Array<{id, name, isSystem}>`
- [ ] **BLOQUEANTE**: Novos usuários auto-provisionados são automaticamente vinculados ao grupo default do seu role
- [ ] O `AdminRecord` type/interface é atualizado para incluir `permissions` e `groups`
- [ ] Testes existentes em `GetAdminProfileUseCase.test.ts` são atualizados para mockar `permissionRepo`
- [ ] Testes novos verificam: (a) permissions retornadas, (b) auto-assign de grupo no provisioning

---

### 2.8 — Migrar rotas existentes para requireGroupPermission

**Arquivo a MODIFICAR**: `worker-functions/src/index.ts`

Substituir gradualmente `requireStaff()` por `requireGroupPermission()` nas rotas de dados:

```typescript
// ANTES:
app.get('/api/admin/workers', authMiddleware.requireStaff(), ...)

// DEPOIS:
app.get('/api/admin/workers', authMiddleware.requireGroupPermission('worker', 'read'), ...)
```

**Mapeamento completo de rotas → permissions**:

| Rota | Permission |
|---|---|
| `GET /api/admin/workers` | `worker:read` |
| `GET /api/admin/workers/:id` | `worker:read` |
| `GET /api/admin/workers/stats` | `worker:read` |
| `GET /api/admin/workers/by-phone` | `worker:read` |
| `GET /api/admin/vacancies` | `vacancy:read` |
| `GET /api/admin/vacancies/stats` | `vacancy:read` |
| `GET /api/admin/vacancies/:id` | `vacancy:read` |
| `POST /api/admin/vacancies` | `vacancy:write` |
| `PUT /api/admin/vacancies/:id` | `vacancy:write` |
| `DELETE /api/admin/vacancies/:id` | `vacancy:delete` |
| `GET /api/admin/vacancies/:id/match-results` | `vacancy:read` |
| `POST /api/admin/vacancies/:id/match` | `vacancy:write` |
| `POST /api/admin/vacancies/:id/enrich` | `vacancy:write` |
| `PUT /api/admin/vacancies/:id/meet-links` | `vacancy:write` |
| `GET /api/admin/vacancies/:id/funnel` | `encuadre:read` |
| `PUT /api/admin/encuadres/:id/move` | `encuadre:write` |
| `PUT /api/admin/encuadres/:id/result` | `encuadre:write` |
| `GET /api/admin/recruitment/*` | `recruitment:read` |
| `POST /api/admin/recruitment/calculate-reemplazos` | `recruitment:write` |
| `GET /analytics/*` (exceto dedup) | `analytics:read` |
| `GET /analytics/dedup/candidates` | `dedup:read` |
| `POST /analytics/dedup/run` | `dedup:execute` |
| `GET /api/admin/dashboard/*` | `dashboard:read` |
| `POST /api/admin/vacancies/:id/interview-slots` | `interview:write` |
| `GET /api/admin/vacancies/:id/interview-slots` | `interview:read` |
| `POST /api/admin/interview-slots/:slotId/book` | `interview:write` |
| `DELETE /api/admin/interview-slots/:slotId` | `interview:write` |
| `* /api/admin/messaging/*` | `messaging:send` |
| `GET /api/admin/users` | `user_management:read` |
| `POST /api/admin/users` | `user_management:write` |
| `DELETE /api/admin/users/:id` | `user_management:delete` |
| `POST /api/admin/users/:id/reset-password` | `user_management:write` |

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: TODAS as rotas acima foram migradas de `requireStaff()`/`requireAdmin()` para `requireGroupPermission(resource, action)`
- [ ] **BLOQUEANTE**: A rota `GET /api/admin/auth/profile` continua com `requireAuth()` — NUNCA colocar requireGroupPermission aqui (deadlock no primeiro login)
- [ ] **BLOQUEANTE**: Nenhuma rota ficou sem proteção — verificar com `grep -n "requireStaff\|requireAdmin" src/index.ts` que só restam rotas intencionais
- [ ] Testes E2E existentes continuam passando (as permissions default dos grupos de sistema cobrem os fluxos testados)

---

## FASE 3 — Frontend (BLOQUEANTE)

### 3.1 — Domain: entidades de permissão no frontend

**Arquivo NOVO**: `enlite-frontend/src/domain/entities/Permission.ts`

Mesmo conteúdo das interfaces de `Permission`, `PermissionGroup`, `PermissionSet` definidas na Fase 2.2, mas sem helpers de backend.

**Arquivo a ESTENDER**: `enlite-frontend/src/domain/entities/AdminUser.ts`

```typescript
// ADICIONAR ao interface AdminUser:
permissions: string[];                                    // ['worker:read', 'vacancy:write', ...]
groups: Array<{ id: string; name: string; isSystem: boolean }>;
```

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: A interface `AdminUser` inclui `permissions` e `groups`
- [ ] Todos os mocks em testes que criam `AdminUser` são atualizados com `permissions: []` e `groups: []` como default
- [ ] O `createMockAdminUser` factory em `adminAuthStore.test.ts` é atualizado

---

### 3.2 — Zustand store: adminAuthStore (BLOQUEANTE)

**Arquivo a ESTENDER**: `enlite-frontend/src/presentation/stores/adminAuthStore.ts`

O store já armazena `adminProfile: AdminUser | null`. Como `AdminUser` agora inclui `permissions` e `groups`, os dados já estarão disponíveis após `fetchProfile()`.

Adicionar helper:

```typescript
// Dentro do store ou como selector exportado:
hasPermission: (permKey: string) => boolean
    → verifica se `state.adminProfile?.permissions?.includes(permKey)`
```

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: `hasPermission('worker:read')` retorna `true` se o user tem essa permission, `false` caso contrário
- [ ] **BLOQUEANTE**: Se `adminProfile` é `null` (não logado), `hasPermission` SEMPRE retorna `false`
- [ ] O `fetchProfile()` não precisa mudar — ele já chama `AdminApiService.getProfile()` que agora retorna `permissions` e `groups`

---

### 3.3 — Hook usePermissions: adaptar para DB-driven (BLOQUEANTE)

**Arquivo a MODIFICAR**: `enlite-frontend/src/presentation/hooks/usePermissions.ts`

O hook atualmente chama Cerbos via DI Container. Trocar para ler do Zustand store:

```typescript
export function usePermissions(resourceType: string) {
    const adminProfile = useAdminAuthStore((s) => s.adminProfile);

    const permissions: UserPermissions = useMemo(() => {
        if (!adminProfile?.permissions) {
            return { canRead: false, canWrite: false, canDelete: false, canManage: false };
        }
        const perms = adminProfile.permissions;
        return {
            canRead: perms.includes(`${resourceType}:read`),
            canWrite: perms.includes(`${resourceType}:write`),
            canDelete: perms.includes(`${resourceType}:delete`),
            canManage: perms.includes(`${resourceType}:write`) && perms.includes(`${resourceType}:delete`),
        };
    }, [adminProfile?.permissions, resourceType]);

    return { permissions, isLoading: false };
}
```

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: `isLoading` é SEMPRE `false` — permissions vêm do store (já carregado no login), não de uma chamada assíncrona
- [ ] **BLOQUEANTE**: `canManage` é `true` quando o user tem TANTO `write` QUANTO `delete` naquele resource
- [ ] O `PermissionGate` component NÃO precisa mudar — ele já usa `usePermissions` que agora lê do store
- [ ] A referência a `Container.getInstance()` e Cerbos é removida deste hook
- [ ] Import de `UserPermissions` de `@domain/entities/User` continua funcionando

---

### 3.4 — Sidebar: filtrar menus por permission (BLOQUEANTE)

**Arquivo a MODIFICAR**: `enlite-frontend/src/presentation/config/adminNavigation.tsx`

Cada menu item recebe a permission necessária. Adicionar ao `AppSidebarNavItem` um campo `requiredPermission`:

```typescript
export const useAdminNavItems = (): AppSidebarNavItem[] => {
    const { t } = useTranslation();
    const hasPermission = useAdminAuthStore((s) => s.hasPermission);

    return [
        {
            icon: /* svg */,
            label: t('admin.nav.users', 'Usuarios'),
            href: '/admin',
            enabled: hasPermission('user_management:read'),
        },
        {
            icon: /* svg */,
            label: t('admin.nav.uploads', 'Importar Archivos'),
            href: '/admin/uploads',
            enabled: hasPermission('upload:read'),
        },
        {
            icon: /* svg */,
            label: t('admin.nav.vacancies', 'Vacantes'),
            href: '/admin/vacancies',
            enabled: hasPermission('vacancy:read'),
        },
        {
            icon: /* svg */,
            label: t('admin.nav.workers', 'Workers'),
            href: '/admin/workers',
            enabled: hasPermission('worker:read'),
        },
        {
            icon: /* svg */,
            label: t('admin.nav.recruitment', 'Reclutamiento'),
            href: '/admin/recruitment',
            enabled: hasPermission('recruitment:read'),
        },
        {
            icon: /* svg */,
            label: t('admin.nav.coordinatorDashboard', 'Coordinadores'),
            href: '/admin/dashboard/coordinators',
            enabled: hasPermission('dashboard:read'),
        },
        {
            icon: /* svg */,
            label: t('admin.nav.permissions', 'Permisos'),
            href: '/admin/permissions',
            enabled: hasPermission('permission_management:read'),
        },
    ];
};
```

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: Menu "Permisos" aparece APENAS para quem tem `permission_management:read` (por default, só admin)
- [ ] **BLOQUEANTE**: Menus que o user não tem permission NÃO aparecem na sidebar (filtro via `enabled: false` já funciona no `AppSidebar`)
- [ ] A propriedade `enabled` já é filtrada em `AppSidebar.tsx` linha 75: `.filter((item) => item.enabled !== false)`
- [ ] O layout dos ícones e labels existentes NÃO muda — apenas adiciona `enabled` e o novo item "Permisos"
- [ ] **EM TELA**: um recruiter com grupo default vê 6 menus (tudo menos Permisos). Um admin vê 7 menus (inclui Permisos)

---

### 3.5 — Rota e página: tela de gerenciamento de permissões

**Arquivo a MODIFICAR**: `enlite-frontend/src/presentation/App.tsx`

Adicionar rota dentro do bloco `/admin`:

```typescript
<Route path="permissions" element={<AdminPermissionsPage />} />
```

**Arquivo NOVO**: `enlite-frontend/src/presentation/pages/admin/AdminPermissionsPage.tsx`

A página tem 2 tabs:

#### Tab 1: "Grupos"

- Lista todos os grupos em cards ou tabela
- Cada card mostra: nome, descrição, badge "Sistema" se is_system, contagem de membros
- Botão "+ Novo Grupo" (visível se `permission_management:write`)
- Ações por grupo: "Editar", "Deletar" (disabled se is_system)
- Ao clicar "Editar", abre drawer/modal com:
  - Campo nome (disabled se is_system)
  - Campo descrição
  - Grid de permissions agrupadas por `category`:
    ```
    ┌─────────────────┬──────┬────────┬────────┬─────────┐
    │ Trabalhadores   │  Ver │ Editar │Deletar │Exportar │
    ├─────────────────┼──────┼────────┼────────┼─────────┤
    │ Workers         │  ☑   │   ☑    │   ☐    │   ☐     │
    │ Workers PII     │  ☑   │   -    │   -    │   -     │
    ├─────────────────┼──────┼────────┼────────┼─────────┤
    │ Vagas           │      │        │        │         │
    ├─────────────────┼──────┼────────┼────────┼─────────┤
    │ Vagas           │  ☑   │   ☑    │   ☑    │   -     │
    │ Encuadres       │  ☑   │   ☑    │   -    │   -     │
    └─────────────────┴──────┴────────┴────────┴─────────┘
    ```
  - O grid é gerado dinamicamente da tabela `permissions` — NÃO hardcodado
  - Botão "Salvar" envia `PUT /api/admin/permission-groups/:id` com `{ name, description, permissionIds: [...] }`

#### Tab 2: "Membros" (quando um grupo está selecionado)

- Lista de membros do grupo selecionado: avatar, nome, email, role base
- Botão "+ Adicionar membro" → abre modal de busca por email
  - Input de busca → chama `GET /api/admin/users?search=email` (reutilizar endpoint existente)
  - Ao selecionar, chama `POST /api/admin/permission-groups/:id/members { userId }`
- Botão remover membro em cada row → `DELETE /api/admin/permission-groups/:id/members/:userId`
- Se é o último admin no grupo "Administrador", o botão remover fica disabled com tooltip explicando

**O que a IA DEVE GARANTIR EM TELA**:
- [ ] **BLOQUEANTE**: Grid de permissions é DINÂMICO — renderizado a partir do response de `GET /api/admin/permissions` agrupado por `category`
- [ ] **BLOQUEANTE**: Grupos de sistema (`is_system: true`) mostram badge visual "Sistema" e NÃO podem ser deletados. Botão "Deletar" deve estar desabilitado ou ausente
- [ ] **BLOQUEANTE**: Ao salvar permissions de um grupo, a tela atualiza imediatamente (otimistic update ou re-fetch)
- [ ] Validação de nome: mín 3 caracteres, máx 100. Mostrar erro inline se duplicado (backend retorna erro)
- [ ] Usar componentes existentes do projeto: `Typography`, `Badge`, e padrões de Tailwind do projeto
- [ ] A página respeita o limite de 400 linhas — extrair subcomponentes se necessário (`PermissionGrid.tsx`, `GroupMembersList.tsx`, `CreateGroupModal.tsx`)
- [ ] Responsividade: grid de permissions scrollable horizontalmente em mobile
- [ ] i18n: todas as labels usam `useTranslation` com chaves em `admin.permissions.*`

---

### 3.6 — AdminApiService: endpoints de permissões

**Arquivo a ESTENDER**: `enlite-frontend/src/infrastructure/http/AdminApiService.ts`

Adicionar métodos:

```typescript
// Permissions
async listPermissions(): Promise<Permission[]>
async listGroups(): Promise<PermissionGroup[]>
async getGroupDetail(id: string): Promise<PermissionGroup>
async createGroup(data: { name: string; description: string }): Promise<PermissionGroup>
async updateGroup(id: string, data: { name?: string; description?: string; permissionIds?: string[] }): Promise<PermissionGroup>
async deleteGroup(id: string): Promise<void>
async addGroupMember(groupId: string, userId: string): Promise<void>
async removeGroupMember(groupId: string, userId: string): Promise<void>
```

**O que a IA DEVE GARANTIR**:
- [ ] Todos os métodos usam o padrão `this.request<T>(method, path, body?)` existente no `AdminApiService`
- [ ] Os tipos importados vêm de `@domain/entities/Permission`

---

### 3.7 — PermissionGate: uso em componentes existentes

Após o sistema funcionar, envolver componentes sensíveis com `PermissionGate`:

```tsx
// Exemplo em AdminWorkersPage — botão de deletar:
<PermissionGate resourceType="worker" action="delete">
    <button onClick={handleDelete}>Deletar Worker</button>
</PermissionGate>

// Exemplo em AdminWorkersPage — botão de exportar:
<PermissionGate resourceType="worker" action="export">
    <button onClick={handleExport}>Exportar</button>
</PermissionGate>

// Exemplo em WorkerDetailPage — campos PII:
<PermissionGate resourceType="worker_pii" action="read" fallback={<MaskedField />}>
    <Field label="Telefone" value={phone} />
    <Field label="CPF" value={cpf} />
</PermissionGate>
```

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: Dados PII (nome real, telefone, CPF, endereço) estão envolvidos por `<PermissionGate resourceType="worker_pii" action="read">` com fallback de campo mascarado (`***`)
- [ ] Botões de CRUD são envolvidos pelo `PermissionGate` correspondente — user sem permission não vê o botão
- [ ] `PermissionGate` com `fallback` mostra o fallback (não `null`) para campos que o user sabe que existem mas não pode ver

---

## FASE 4 — Testes (BLOQUEANTE)

### 4.1 — Backend: testes unitários — cenários obrigatórios

Cada cenário listado abaixo é um `it(...)` que DEVE existir e passar.

#### `PermissionRepository.test.ts`

```
describe('listPermissions')
  it('retorna todas as 28 permissions seed')
  it('cada permission tem id, resource, action, description, category')

describe('listGroups')
  it('retorna os 3 grupos de sistema com memberCount')
  it('memberCount reflete a quantidade real de user_groups')

describe('getGroupById')
  it('retorna grupo com array de permissions populado')
  it('retorna null para id inexistente')

describe('createGroup')
  it('cria grupo com name, description e createdBy')
  it('grupo criado tem is_system = false')
  it('lança erro se name já existe (UNIQUE constraint)')

describe('updateGroup')
  it('atualiza name e description de grupo non-system')
  it('NÃO atualiza grupo com is_system = true — retorna sem alteração')

describe('deleteGroup')
  it('deleta grupo non-system e retorna true')
  it('retorna false para grupo is_system = true — NÃO deleta')
  it('CASCADE: group_permissions são removidas junto')

describe('setGroupPermissions')
  it('substitui todas as permissions de um grupo dentro de transaction')
  it('grupo fica com exatamente os permissionIds passados, sem extras')
  it('rollback se INSERT falhar — estado anterior mantido')

describe('addUserToGroup / removeUserFromGroup')
  it('addUserToGroup vincula user ao grupo')
  it('addUserToGroup com ON CONFLICT DO NOTHING não lança erro para duplicata')
  it('removeUserFromGroup desvincula user do grupo')

describe('getUserEffectivePermissions')
  it('retorna UNION de permissions de todos os grupos do user')
  it('retorna array vazio para user sem grupos')
  it('user em 2 grupos: retorna permissions sem duplicatas')

describe('logAccess')
  it('insere row na permission_audit_log com todos os campos')
  it('NÃO inclui PII — apenas userId, resource, action, resourceId')
```

#### `CreateGroupUseCase.test.ts`

```
it('cria grupo com nome válido e retorna PermissionGroup')
it('retorna Result.fail quando nome tem menos de 3 caracteres')
it('retorna Result.fail quando nome já existe')
it('grupo criado NÃO é is_system')
```

#### `DeleteGroupUseCase.test.ts`

```
it('deleta grupo non-system sem membros — Result.ok')
it('retorna Result.fail("Cannot delete system group") para is_system=true')
it('retorna Result.fail("Group has N members...") quando grupo tem membros')
```

#### `RemoveUserFromGroupUseCase.test.ts`

```
it('remove user de grupo — Result.ok')
it('retorna Result.fail("Cannot remove the last administrator") quando é o último admin no grupo Administrador')
it('permite remover admin quando há pelo menos 2 admins no grupo')
```

#### `UpdateGroupUseCase.test.ts`

```
it('atualiza name + description de grupo non-system')
it('NÃO permite renomear grupo is_system — mantém name original')
it('permite alterar permissionIds de grupo is_system')
it('chama setGroupPermissions quando permissionIds é fornecido')
```

#### `PermissionController.test.ts`

```
describe('GET /api/admin/permissions')
  it('200 — retorna lista de permissions agrupadas por category')
  it('403 — user não-staff recebe forbidden')

describe('GET /api/admin/permission-groups')
  it('200 — retorna lista de grupos com memberCount')

describe('GET /api/admin/permission-groups/:id')
  it('200 — retorna grupo com permissions[] e membros[]')
  it('404 — id inexistente')

describe('POST /api/admin/permission-groups')
  it('201 — cria grupo com name e description')
  it('400 — name vazio ou < 3 chars')
  it('400 — name duplicado')
  it('403 — user sem permission_management:write')

describe('PUT /api/admin/permission-groups/:id')
  it('200 — atualiza grupo com novas permissions')
  it('200 — grupo is_system: aceita alterar permissions, ignora rename')
  it('403 — user sem permission_management:write')

describe('DELETE /api/admin/permission-groups/:id')
  it('200 — deleta grupo non-system sem membros')
  it('400 — grupo is_system')
  it('400 — grupo com membros')
  it('403 — user sem permission_management:write')

describe('POST /api/admin/permission-groups/:id/members')
  it('200 — adiciona membro ao grupo')
  it('403 — user sem permission_management:write')

describe('DELETE /api/admin/permission-groups/:id/members/:userId')
  it('200 — remove membro do grupo')
  it('400 — último admin no grupo Administrador')
  it('403 — user sem permission_management:write')
```

#### `AuthMiddleware.test.ts` (estender)

```
describe('requireGroupPermission')
  it('200 — user com permission "worker:read" acessa rota protegida por worker:read')
  it('403 — user SEM permission "worker:read" recebe { error: "Permission denied", required: "worker:read" }')
  it('403 — user não-staff recebe "Staff access required" antes de verificar permissions')
  it('grava row na permission_audit_log com decision ALLOW')
  it('grava row na permission_audit_log com decision DENY')
  it('cache: segunda chamada na mesma request NÃO faz nova query ao banco')
```

#### `GetAdminProfileUseCase.test.ts` (estender)

```
it('response inclui permissions: string[] com permissions efetivas do user')
it('response inclui groups: Array<{id, name, isSystem}>')
it('auto-provisioning: novo user @enlite.health recebe grupo default "Recrutador"')
it('auto-provisioning: user provisionado tem permissions do grupo Recrutador no response')
```

---

### 4.2 — Frontend: testes unitários — cenários obrigatórios

#### `adminAuthStore.test.ts` (estender)

```
describe('hasPermission')
  it('retorna true quando adminProfile.permissions inclui a permKey')
  it('retorna false quando adminProfile.permissions NÃO inclui a permKey')
  it('retorna false quando adminProfile é null (não logado)')
  it('retorna false quando adminProfile.permissions é array vazio')
```

#### `usePermissions.test.ts`

```
describe('usePermissions')
  it('canRead=true quando store tem "worker:read"')
  it('canRead=false quando store NÃO tem "worker:read"')
  it('canWrite=true quando store tem "worker:write"')
  it('canDelete=true quando store tem "worker:delete"')
  it('canManage=true SOMENTE quando store tem TANTO write QUANTO delete')
  it('canManage=false quando store tem write mas NÃO delete')
  it('isLoading é SEMPRE false')
  it('retorna tudo false quando adminProfile é null')
```

#### `adminNavigation.test.tsx`

```
describe('useAdminNavItems')
  it('admin com todas as permissions vê 7 menus incluindo Permisos')
  it('recruiter default (sem permission_management:read) vê 6 menus, SEM Permisos')
  it('user com APENAS worker:read vê somente o menu Workers')
  it('user sem nenhuma permission vê 0 menus')
  it('cada item com enabled=false NÃO aparece no render da sidebar')
```

**GARANTIR VISUALMENTE**: renderizar o componente `AppSidebar` com os navItems e verificar via `screen.queryByText`:
- Admin: `screen.getByText('Permisos')` existe
- Recruiter: `screen.queryByText('Permisos')` retorna `null`

#### `RequirePermission.test.tsx`

```
describe('RequirePermission')
  it('renderiza children quando user tem a permission')
  it('renderiza AccessDeniedPage quando user NÃO tem a permission')
  it('AccessDeniedPage mostra texto "Sem permissão" visível na tela')
  it('AccessDeniedPage mostra botão "Voltar" que linka para /admin')
```

**GARANTIR VISUALMENTE**: 
- `expect(screen.getByText(/sem permissão/i)).toBeInTheDocument()`
- `expect(screen.getByRole('link', { name: /voltar/i })).toHaveAttribute('href', '/admin')`

#### `PermissionGate.test.tsx` (estender)

```
describe('PermissionGate com store DB-driven')
  it('renderiza children quando user tem resourceType:action no store')
  it('renderiza fallback quando user NÃO tem a permission')
  it('renderiza null (nada) quando NÃO tem permission e NÃO tem fallback')
  it('PII mascarado: fallback mostra "***" para campos sensíveis')
```

**GARANTIR VISUALMENTE**:
- User com `worker_pii:read`: `screen.getByText('+54 9 11 8888-8888')` — telefone visível
- User sem `worker_pii:read`: `screen.getByText('***')` — campo mascarado
- `screen.queryByText('+54 9 11 8888-8888')` retorna `null` quando sem permission

#### `AdminPermissionsPage.test.tsx`

```
describe('Tab Grupos')
  it('renderiza lista de grupos com nome, descrição e badge "Sistema"')
  it('grupo "Administrador" mostra badge "Sistema" visível')
  it('grupo custom NÃO mostra badge "Sistema"')
  it('cada grupo mostra contagem de membros: "N membros"')
  it('botão "+ Novo Grupo" visível para user com permission_management:write')
  it('botão "+ Novo Grupo" AUSENTE para user sem permission_management:write')
  it('botão "Deletar" está desabilitado (disabled) para grupo is_system')
  it('botão "Deletar" está habilitado para grupo non-system')

describe('Modal editar grupo — grid de permissions')
  it('renderiza grid com checkboxes agrupados por category')
  it('categorias visíveis: "Trabalhadores", "Vagas", "Recrutamento", etc.')
  it('checkbox marcado para permissions que o grupo já tem')
  it('checkbox desmarcado para permissions que o grupo NÃO tem')
  it('marcar checkbox e salvar envia PUT com permissionIds atualizado')
  it('campo nome desabilitado para grupo is_system')
  it('campo nome habilitado para grupo non-system')

describe('Tab Membros')
  it('renderiza lista de membros com nome, email e role')
  it('botão "+ Adicionar membro" abre modal de busca')
  it('buscar por email e selecionar chama POST com userId')
  it('botão remover membro chama DELETE')
  it('botão remover DESABILITADO quando é último admin no grupo Administrador')
```

**GARANTIR VISUALMENTE em cada teste**:
- Badge "Sistema": `expect(screen.getByText('Sistema')).toBeInTheDocument()` — visível como badge com estilo diferenciado
- Grid checkboxes: `expect(screen.getByRole('checkbox', { name: /ver.*workers/i })).toBeChecked()`
- Botão disabled: `expect(screen.getByRole('button', { name: /deletar/i })).toBeDisabled()`
- Contagem: `expect(screen.getByText(/3 membros/i)).toBeInTheDocument()`
- Campo nome disabled: `expect(screen.getByLabelText(/nome/i)).toBeDisabled()`
- Modal visível: `expect(screen.getByRole('dialog')).toBeInTheDocument()`

#### `PermissionDeniedError.test.tsx` (tratamento de 403)

```
describe('tratamento de 403 Permission Denied')
  it('AdminWorkersPage mostra mensagem "Sem permissão" quando API retorna 403')
  it('NÃO mostra tela branca — componente continua renderizado')
  it('mensagem de erro é visível ao usuário')
```

**GARANTIR VISUALMENTE**:
- `expect(screen.getByText(/sem permissão/i)).toBeInTheDocument()`
- `expect(screen.queryByText(/error/i)).not.toBeInTheDocument()` — sem crash de React

---

### 4.3 — Resumo de cobertura

| Área | Suites | Cenários (it) |
|---|---|---|
| Backend: Repository | 1 | 16 |
| Backend: Use Cases | 4 | 14 |
| Backend: Controller | 1 | 15 |
| Backend: Middleware | 1 (ext) | 6 |
| Backend: Profile | 1 (ext) | 4 |
| **Backend total** | **8** | **55** |
| Frontend: Store | 1 (ext) | 4 |
| Frontend: usePermissions | 1 | 8 |
| Frontend: Navigation | 1 | 5 |
| Frontend: RequirePermission | 1 | 4 |
| Frontend: PermissionGate | 1 (ext) | 4 |
| Frontend: AdminPermissionsPage | 1 | 16 |
| Frontend: 403 handling | 1 | 3 |
| **Frontend total** | **7** | **44** |
| **TOTAL** | **15** | **99** |

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: Os 99 cenários (it) listados acima existem e passam
- [ ] **BLOQUEANTE**: Testes existentes que foram modificados continuam passando — 0 regressões
- [ ] **BLOQUEANTE**: `npm test` no backend = 0 falhas. `pnpm test:run` no frontend = 0 falhas
- [ ] Mocks de `AdminUser` em TODOS os testes incluem `permissions: []` e `groups: []`
- [ ] Cada teste de frontend que valida comportamento visual usa `screen.getByText`, `screen.getByRole`, `toBeDisabled()`, `toBeChecked()`, `toBeInTheDocument()` — NÃO verifica apenas lógica, verifica o que o USUÁRIO VÊ
- [ ] Cada teste de frontend que valida AUSÊNCIA visual usa `screen.queryByText` + `not.toBeInTheDocument()` ou `toBeNull()`

---

## FASE 5 — Compliance LGPD/HIPAA

### 5.1 — Audit trail (já coberto pela tabela `permission_audit_log`)

A tabela `permission_audit_log` é populada automaticamente pelo `requireGroupPermission` middleware. Cada acesso a qualquer recurso protegido gera uma row com:
- Quem (`user_id`)
- O que (`resource`, `action`, `resource_id`)
- Quando (`created_at`)
- Resultado (`decision`: ALLOW ou DENY)
- De onde (`ip_address`, `user_agent`)

**BLOQUEANTE**: Sem PII no log. Apenas `user_id` (firebase_uid), nunca email ou nome.

### 5.2 — Minimum necessary access (HIPAA)

O sistema de grupos garante que cada user só vê o que seu grupo permite. O admin pode criar grupos mínimos como "Visualizador" com apenas `worker:read`, sem acesso a PII.

### 5.3 — PII segregation

A permission `worker_pii:read` é separada de `worker:read`. Um user pode ver a lista de workers (nomes anonimizados) sem poder ver telefone, CPF, endereço. O `PermissionGate` no frontend mascara os campos; o backend pode omitir campos encrypted se o user não tem `worker_pii:read`.

### 5.4 — Deprecação de `admins_extension.permissions` JSONB

A coluna `admins_extension.permissions` (migration 005) existe mas nunca foi populada de forma estruturada. Com o novo sistema de grupos, essa coluna é **obsoleta**. 

**Ação**: NÃO remover a coluna agora (migrações são aditivas). Apenas ignorá-la no código. Em uma migration futura (após estabilização), remover com:

```sql
ALTER TABLE admins_extension DROP COLUMN IF EXISTS permissions;
```

**O que a IA DEVE GARANTIR**:
- [ ] Nenhum código novo lê ou escreve em `admins_extension.permissions`
- [ ] O `AdminRepository.findByFirebaseUid` NÃO retorna esse campo (já não retorna hoje)

---

### 5.5 — Proteção de rota direta no frontend (BLOQUEANTE)

Se o user digitar `/admin/workers` na URL sem ter `worker:read`, a sidebar não mostra o menu, mas a página carrega. Precisamos de um guard por rota.

**Arquivo a MODIFICAR**: `enlite-frontend/src/presentation/App.tsx`

Criar um wrapper `<RequirePermission>` que envolve cada rota:

```tsx
function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
    const hasPermission = useAdminAuthStore((s) => s.hasPermission);
    
    if (!hasPermission(permission)) {
        return <AccessDeniedPage />;
    }
    
    return <>{children}</>;
}
```

Usar nas rotas:

```tsx
<Route path="/admin" element={
    <AdminProtectedRoute><AdminLayout /></AdminProtectedRoute>
}>
    <Route index element={<RequirePermission permission="user_management:read"><AdminUsersPage /></RequirePermission>} />
    <Route path="uploads" element={<RequirePermission permission="upload:read"><AdminUploadsPage /></RequirePermission>} />
    <Route path="vacancies" element={<RequirePermission permission="vacancy:read"><AdminVacanciesPage /></RequirePermission>} />
    <Route path="workers" element={<RequirePermission permission="worker:read"><AdminWorkersPage /></RequirePermission>} />
    <Route path="recruitment" element={<RequirePermission permission="recruitment:read"><AdminRecruitmentPage /></RequirePermission>} />
    <Route path="dashboard/coordinators" element={<RequirePermission permission="dashboard:read"><CoordinatorDashboardPage /></RequirePermission>} />
    <Route path="permissions" element={<RequirePermission permission="permission_management:read"><AdminPermissionsPage /></RequirePermission>} />
    {/* Sub-rotas herdam a permission da rota pai */}
    <Route path="vacancies/:id" element={<RequirePermission permission="vacancy:read"><VacancyDetailPage /></RequirePermission>} />
    <Route path="vacancies/:id/match" element={<RequirePermission permission="vacancy:read"><VacancyMatchPage /></RequirePermission>} />
    <Route path="vacancies/:id/kanban" element={<RequirePermission permission="encuadre:read"><VacancyKanbanPage /></RequirePermission>} />
    <Route path="workers/:id" element={<RequirePermission permission="worker:read"><WorkerDetailPage /></RequirePermission>} />
</Route>
```

**`AccessDeniedPage`**: componente simples que mostra "Você não tem permissão para acessar esta página" com botão para voltar ao `/admin`.

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: TODA rota dentro de `/admin` está envolvida por `<RequirePermission>`
- [ ] **BLOQUEANTE**: Acessar uma URL diretamente sem permission mostra `AccessDeniedPage`, NÃO uma tela em branco ou erro
- [ ] O componente `RequirePermission` fica em `enlite-frontend/src/presentation/components/features/auth/RequirePermission.tsx`
- [ ] O componente `AccessDeniedPage` fica em `enlite-frontend/src/presentation/pages/admin/AccessDeniedPage.tsx`
- [ ] **EM TELA**: user sem `worker:read` acessa `/admin/workers` direto → vê "Sem permissão" com botão de voltar

---

### 5.6 — Tratamento de 403 no frontend (BLOQUEANTE)

Quando o admin remove uma permission de um user, o backend passa a retornar 403 nas rotas protegidas. O frontend precisa tratar isso de forma consistente — NÃO crashar, NÃO mostrar tela em branco.

**Arquivo a MODIFICAR**: `enlite-frontend/src/infrastructure/http/AdminApiService.ts`

No handler de response (ou interceptor HTTP), adicionar tratamento global de 403:

```typescript
// No método request() ou no interceptor do httpClient:
if (response.status === 403) {
    const json = await response.json();
    
    // Se a mensagem indica falta de permission, mostrar toast/notificação
    // e NÃO lançar exceção que quebraria a tela
    if (json.error === 'Permission denied') {
        // Emitir evento ou callback que o frontend pode escutar
        this.onPermissionDenied?.(json.required);
        throw new PermissionDeniedError(json.required, json.error);
    }
    
    // 403 por motivos de auth (não-staff) continua como antes
    throw new ApiError(403, json.error || 'Access denied');
}
```

**Na página/componente que faz a chamada**:

```typescript
try {
    const workers = await AdminApiService.listWorkers(filters);
    setWorkers(workers);
} catch (error) {
    if (error instanceof PermissionDeniedError) {
        // Mostrar mensagem amigável em vez de crashar
        setError('Você não tem permissão para acessar este recurso');
        return;
    }
    // Outros erros: tratamento normal
    setError('Erro ao carregar dados');
}
```

**O que a IA DEVE GARANTIR**:
- [ ] **BLOQUEANTE**: Um 403 com `error: 'Permission denied'` NUNCA causa tela branca ou crash no React
- [ ] **BLOQUEANTE**: O user vê uma mensagem clara ("Sem permissão para acessar este recurso") — NÃO um erro genérico
- [ ] A classe `PermissionDeniedError` é criada em `enlite-frontend/src/domain/errors/PermissionDeniedError.ts`
- [ ] Todas as páginas admin que fazem fetch de dados tratam `PermissionDeniedError` no catch
- [ ] **EM TELA**: Admin remove `worker:read` do grupo de um user → user está na tela de workers → a próxima interação (paginar, filtrar) mostra "Sem permissão", NÃO tela branca

---

### 5.7 — Futuro: o que NÃO está neste escopo

- **Session timeout** (idle 15-30min) — implementar separado
- **SAR** (Subject Access Request — worker exporta seus dados) — endpoint futuro
- **Right to be forgotten** (exclusão completa) — endpoint futuro
- **Consent management** — registro de consentimento dos workers
- **Breach notification** — processo + alerta automatizado
- **ABAC via Cerbos** — ativar quando precisar de condições como "só vê workers da sua zona"

---

## Checklist final de execução

Antes de considerar DONE, verificar:

- [ ] **BANCO**: Migration 103 executada localmente e em produção
- [ ] **BANCO**: `SELECT COUNT(*) FROM permissions` = 28
- [ ] **BANCO**: `SELECT COUNT(*) FROM permission_groups WHERE is_system = true` = 3
- [ ] **BANCO**: Todos os users existentes vinculados ao grupo correto
- [ ] **BANCO**: `SELECT get_user_effective_permissions('<uid_admin>')` retorna 28 permissions
- [ ] **BACKEND**: Build sem erros TypeScript
- [ ] **BACKEND**: Todos os testes passam (0 falhas)
- [ ] **BACKEND**: `GET /api/admin/auth/profile` retorna `permissions[]` e `groups[]`
- [ ] **BACKEND**: `requireGroupPermission('worker','read')` funciona nas rotas
- [ ] **BACKEND**: Audit log está sendo gravado em `permission_audit_log`
- [ ] **BACKEND**: 403 retornado quando user sem permission tenta acessar rota protegida
- [ ] **FRONTEND**: Build sem erros TypeScript
- [ ] **FRONTEND**: Todos os testes passam (0 falhas)
- [ ] **FRONTEND**: Sidebar filtra menus baseado em permissions
- [ ] **FRONTEND**: Tela `/admin/permissions` funciona: criar grupo, editar permissions, adicionar/remover membros
- [ ] **FRONTEND**: `PermissionGate` funciona em pelo menos 1 componente real (ex: botão de deletar worker)
- [ ] **FRONTEND**: PII mascarado quando user não tem `worker_pii:read`
- [ ] **FRONTEND**: `RequirePermission` protege TODAS as rotas — URL direta sem permission mostra AccessDeniedPage
- [ ] **FRONTEND**: 403 do backend é tratado com mensagem clara, NUNCA tela branca
- [ ] **TELA**: Admin vê menu "Permisos", recruiter NÃO vê
- [ ] **TELA**: Criar grupo "Estagiário" com apenas `worker:read` + `vacancy:read` → user desse grupo só vê Workers e Vacantes no sidebar
- [ ] **TELA**: Tentar deletar grupo "Administrador" → erro
- [ ] **TELA**: Tentar remover último admin do grupo "Administrador" → erro
- [ ] **TELA**: User sem permission acessa URL direta → vê "Sem permissão" com botão de voltar
- [ ] **TELA**: Admin remove permission de user em tempo real → próxima request do user retorna 403 → mensagem amigável
