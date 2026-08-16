/**
 * src/modules/identity/permissions/domain/tenant.ts
 *
 * O tenant Enlite — UUID fixo semeado pela migration 206, e hoje o único. É o
 * mesmo valor do fallback de `iam.current_tenant_id()` (mig 276): as duas pontas
 * precisam concordar, senão o resolver do app e a policy do banco olhariam
 * tenants diferentes.
 *
 * Multi-tenant de verdade é Fase 7 do plano de junho (não-goal desta change).
 * Quando chegar, o tenant passa a vir do `users.tenant_id` do principal e esta
 * constante vira só o default de scripts.
 */

export const ENLITE_TENANT_ID = '00000000-0000-0000-0000-000000000001';
