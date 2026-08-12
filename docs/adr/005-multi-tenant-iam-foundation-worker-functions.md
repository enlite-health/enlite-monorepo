# ADR 005: Multi-Tenant IAM Foundation — worker-functions

- **Status:** Proposed
- **Data:** 2026-06-15
- **Decisor(es):** architect + PO
- **Contexto técnico:** worker-functions/src/modules/identity/ + migrations/

## Context

Enlite é hoje single-tenant. A arquitetura-alvo (architecture/EnLite_Bloco6_Microservicos.md, architecture/db_architecture_enlite_F03_F04_F05.md) define schema `iam` com `iam.tenants` e `iam.users.tenant_id`. A feature de permissões (D1 do plano-mestre docs/features/permissions/00-master-plan.md) exige que a fundação multi-tenant exista no backend agora, antes de qualquer UI. A tabela `users` em migrations/003_create_users_base_table.sql não tem `tenant_id`. Nenhuma migration até 204 adiciona `tenant_id` a qualquer tabela de domínio.

## Decision

Criar tabela `tenants` e adicionar `tenant_id` nas tabelas IAM (permission_groups, user_groups, user_departments, permission_audit_log) e em `users` (nullable, com backfill para o tenant Enlite `00000000-0000-0000-0000-000000000001`). Filtro por tenant em application layer (NÃO RLS Postgres). Queries de domínio (workers, job_postings, patients) NÃO filtram por tenant ainda — trilha subsequente gated por flag `MULTI_TENANT_DOMAIN_ISOLATION`. Adicionar também `users.status` enum (VARCHAR+CHECK: ACTIVE, PENDING_ONBOARDING, SUSPENDED, DEACTIVATED) substituindo semanticamente `is_active` (mantido em sync por trigger, não removido).

Mudanças concretas:
- Criar tabela `tenants` (migration 205)
- Adicionar `tenant_id UUID` em `permission_groups`, `user_groups`, `user_departments`, `permission_audit_log` e `users`
- Backfill `users.tenant_id` para `00000000-0000-0000-0000-000000000001` (tenant Enlite canônico)
- Adicionar `users.status VARCHAR CHECK('ACTIVE','PENDING_ONBOARDING','SUSPENDED','DEACTIVATED')`
- Criar trigger para manter `users.is_active` em sync com `users.status`
- Queries IAM passam a filtrar `WHERE tenant_id = $1` em application layer
- Flag `MULTI_TENANT_DOMAIN_ISOLATION` (default off) controla extensão do filtro para tabelas de domínio

## Consequences

### Positivas
- Tabelas IAM nascem multi-tenant; extração para permission-service futuro não exige mudança de schema
- JWT claim `tenant_id` pode ser propagado desde o início sem retrabalho
- `users.status` suporta `PENDING_ONBOARDING`, necessário para o fluxo D1 de permissões

### Negativas
- Backfill de `users.tenant_id` em prod exige cuidado transacional + validação pós-migration (risco de falha parcial)
- Queries IAM novas precisam de `WHERE tenant_id=$1` explícito — risco de esquecer em use case novo sem lint rule

### Neutras
- `is_active` continua em sync via trigger; remoção definitiva é TD futuro (após estabilização de `users.status`)
- Prefixo `iam.` é trabalho da extração futura do permission-service, não desta migration

## Alternatives Considered

### Alternativa A: RLS Postgres por tenant
Postgres Row-Level Security com `SET app.current_tenant` por conexão. Cada query seria isolada automaticamente.

**Descartada porque:** Pool de conexões compartilhado sem SET garantido por request é frágil (contaminação entre requests); RLS com pool PgBouncer em transaction mode não suporta `SET LOCAL`; não-testável em Jest sem mock de sessão Postgres.

### Alternativa B: Adiar multi-tenant para a extração do permission-service
Não tocar em `tenant_id` agora; adicionar apenas quando o serviço for extraído para NestJS próprio.

**Descartada porque:** D1 do plano-mestre trava "infra + backend completos agora"; adiar implica retrabalho de schema em todas as tabelas IAM no momento da extração, bloqueando o timeline da feature de permissões.

## Rollback

Migration 205 é aditiva (adiciona colunas e tabela, não remove nem altera existentes). Reverter exige `DROP COLUMN tenant_id` nas tabelas IAM e `DROP TABLE tenants` — operação irreversível se dados foram inseridos com `tenant_id` preenchido. Mitigação obrigatória: backup transacional (pg_dump) do banco de produção imediatamente antes de executar a migration. Snapshot Cloud SQL (enlite-prd) via `gcloud sql backups create` como segunda camada de segurança.

## Implementation Notes

- Migrations envolvidas: 205 (criar `tenants`, adicionar `tenant_id` + `users.status` + trigger)
- Feature flags: `MULTI_TENANT_DOMAIN_ISOLATION` (default off) — controla extensão do filtro para workers/job_postings/patients
- Follow-up TD (em `docs/FOLLOWUPS.md`): TD-052

## References

- architecture/EnLite_Bloco6_Microservicos.md
- architecture/db_architecture_enlite_F03_F04_F05.md
- docs/features/permissions/00-master-plan.md
- migrations/003_create_users_base_table.sql
