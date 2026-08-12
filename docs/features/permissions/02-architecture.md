# Permissões — Arquitetura Técnica (Fase 1)

> Parecer do Architect · 2026-06-15 · consome [01-requirements-and-decisions.md](01-requirements-and-decisions.md)
> Decisões formalizadas em ADR-005 (multi-tenant) e ADR-006 (Cerbos) — `docs/adr/`.
> Honra decisões travadas D1-D6 do [00-master-plan.md](00-master-plan.md).

## Estado atual (evidência)

- `migrations/003_create_users_base_table.sql:15` — `users` PK `firebase_uid`, `role`, `is_active BOOLEAN`. **Sem** `tenant_id`/`status`.
- `migrations/204` — última migration; próxima é **205**.
- `Auth.ts:16` — `Principal.tenantId?: string` **já existe** (opcional, nunca preenchido em prod).
- `SimplifiedAuthorizationEngine.ts:18` — allow-all em prod.
- `CerbosAuthorizationAdapter.ts:34` — adapter correto; problema é `roles` chegar vazio.
- `index.ts:117` — flag `USE_CERBOS` já existe.
- Frontend `CerbosAuthorizationRepository.ts:18` — **bug `roles:[]` hardcoded** nos 3 métodos. (Obs: o hook é `usePermissions`, não `useCheckPermission`.)

## Estratégia multi-tenant (fundação backend)

- Criar tabela `tenants` (id, name, region, status) + seed do tenant Enlite (`00000000-...-0001`).
- `tenant_id` **agora** nas tabelas IAM (NOT NULL) e em `users` (nullable + backfill).
- Tabelas de domínio (workers/job_postings/patients): **não** recebem filtro de tenant nesta fase → vira TD com flag `MULTI_TENANT_DOMAIN_ISOLATION`.
- Propagação: claim JWT `tenant_id` → middleware popula `AuthContext` → use cases IAM filtram explicitamente.
- **Filtro app-level, NÃO RLS Postgres** (pool compartilhado torna `SET app.current_tenant` frágil). RLS fica pra extração do permission-service com pool próprio.

## Ponte Cerbos ↔ grupos dinâmicos (núcleo de D2)

**Decisão:** grupos da UI **não** viram policies Cerbos. As permissões efetivas (UNION dos grupos) são calculadas no login via SQL e injetadas como claim `permissions[]` no JWT. O Cerbos avalia uma resource-policy por recurso com condição `'recurso:ação' in request.principal.attr.permissions`.

```
Login/refresh:
  GetAdminProfileUseCase → get_user_effective_permissions(uid) → ['worker:read', ...]
    → setCustomUserClaims(uid, { role, tenant_id, permissions[], last_permission_sync })
Request:
  AuthMiddleware → lê permissions[] do JWT (sem I/O) → CerbosAdapter injeta principal.attr.permissions
  Cerbos resource-policy: condition expr "'worker:read' in request.principal.attr.permissions"
Mudança de grupo:
  admin.auth().revokeRefreshTokens(userId)  → força re-emissão de claims (TTL 1h)
```

- **Sem Admin API sync** (Cerbos não é SSOT de grupos). Policies YAML estáticas por recurso (18 arquivos), versionadas no CI.
- **Bug `roles:[]`:** corrigir pra `roles:[currentUser.role]` (necessário p/ logs/auditoria Cerbos) antes de qualquer deploy com Cerbos.
- **Onde Cerbos roda:** Cloud Run dedicado `enlite-cerbos` (ingress interno), policies via bucket `gs://enlite-cerbos-policies-{env}/`, `min-instances=1`. Não é sidecar (Cloud Run não suporta).

## Modelo de dados — migration 205 (iam-ready)

Tabelas (schema público agora; prefixo `iam.` só na extração futura — renomeação trivial, nenhuma FK cruza pra domínio):

- `tenants` (id, name, region, status) + seed Enlite.
- `users` **ALTER**: `+tenant_id UUID REFERENCES tenants` (nullable+backfill), `+status VARCHAR(20) CHECK IN ('ACTIVE','PENDING_ONBOARDING','SUSPENDED','DEACTIVATED')`. Trigger mantém `is_active` em sync (deprecado, não remover).
- `permissions` (id, resource, action, description, category, UNIQUE(resource,action)) — seed da matriz de 18 recursos (01-requirements).
- `permission_groups` (id, **tenant_id**, name, description, is_system, created_by, UNIQUE(tenant_id,name)).
- `group_permissions` (group_id, permission_id) PK composta.
- `user_groups` (user_id, group_id, **tenant_id**, assigned_by, assigned_at).
- `user_departments` (user_id, department_name, **tenant_id**) — metadado multi-valor (D-P3).
- `permission_audit_log` (id, **tenant_id**, user_id, resource, action, resource_id, decision CHECK ALLOW/DENY, ip_address, created_at). **NUNCA grava PII/user_agent.**
- Função `get_user_effective_permissions(uid) → TEXT[]` (UNION dos grupos).
- Seed dos 5 grupos de sistema + auto-assign dos usuários existentes por role.

**`users` não é duplicada** — módulo referencia `firebase_uid` via FK. Na extração, `iam.users` nasce no permission-service só com o que precisa.

## Engine e ports (reuso vs criação)

- `IAuthorizationEngine` (port) — **reusar sem modificação**.
- `CerbosAuthorizationAdapter` — estender: `+permissions[]` no payload, `console.error`→`logger`, método batch.
- **Rollout fail-closed:** Fase A (`USE_GROUP_PERMISSIONS=true`, engine ainda allow-all → já bloqueia user sem grupo e PENDING_ONBOARDING). Fase B (`USE_CERBOS=true`) rota a rota, E2E de DENY antes de cada uma (worker:read primeiro, dedup:execute por último).
- Effective permissions: SQL no login (não por request); middleware lê do JWT; fallback banco com cache 60s se claim ausente. Endpoint `/api/admin/me/permissions` pro store do frontend.

## Mapa de implementação

~23 arquivos (13 backend, 6 frontend, 4 policies/infra). Destaques de risco alto: migration 205, `GetAdminProfileUseCase` (path de login — emissão de claims em try/catch com fallback), `AuthMiddleware` (todos endpoints). **Split obrigatório:** `AuthMiddleware.ts` já tem 375 linhas → extrair `requirePermission`/`requireStaff` pra `PermissionMiddleware.ts`. **`PermissionGate`** muda de API (`canRead/canWrite`→`resource/action`) — grep todos os callers antes (breaking). Detalhamento completo no parecer do Architect.

## Sequência de build

P0 ambiente → **P1 migration 205** (bloqueia tudo) → P2 domain + P3 infra (paralelos) → P4 use cases → P5 claims no login → P6 controller/routes + split middleware (liga Fase A) → P7 Cerbos Cloud Run + policies (paralelo) → P8 frontend (bug roles, store, hooks, gate) → P9 liga Cerbos rota a rota → P10 tela de gestão de grupos (bloqueada por sign-off Financeiro/Super Admin + design Figma).

## Riscos & mitigações (resumo)

- Login crítico → emissão de claims em try/catch + fallback banco.
- Bug `roles:[]` → pré-requisito de deploy + E2E com Cerbos real.
- 400 linhas `AuthMiddleware` → split no mesmo PR.
- Latência PDP → check rápido em `permissions[]` local; Cerbos só p/ ABAC camada DATA; `min-instances=1`.
- Extração futura → nenhuma FK IAM→domínio; FKs a `users` viram referência lógica.

## Vetos / alertas

- **VETO** criar `super_admin` no enum (é grupo de sistema).
- **VETO** RLS Postgres nesta fase.
- **VETO** `USE_CERBOS=true` sem E2E de DENY por rota.
- **VETO** deploy de qualquer código de permissão em prod antes da migration 205 validada em stg.
- **Bloqueado por sign-off Gabriel:** escopo do grupo "Financeiro"; semântica `PENDING_ONBOARDING`; semântica dos 2 campos "Departamento" (designer); confirmar `worker:write` vs `worker_structure:write` pro Super Admin.
- Usar `funnel`/`wja` como nome de recurso, **nunca `encuadre`** (ADR-002).

## ADRs

- **ADR-005** — Multi-tenant: fundação backend (filtro app-level; domínio não isola ainda; flag futura). Status: Proposed (aprovação Gabriel pendente).
- **ADR-006** — Cerbos como PDP via principal attributes `permissions[]` no JWT (sem Admin API sync; revogação de token na mudança de grupo). Status: Proposed.
