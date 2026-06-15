# ADR 006: Cerbos PDP — Grupos Dinâmicos via Principal Attributes

- **Status:** Proposed
- **Data:** 2026-06-15
- **Decisor(es):** architect + PO
- **Contexto técnico:** worker-functions/src/modules/identity/infrastructure/ + enlite-frontend/src/infrastructure/repositories/

## Context

D2 do plano-mestre (docs/features/permissions/00-master-plan.md) trava Cerbos como engine de autorização. O legacy-roadmap foi DB-driven porque "grupos dinâmicos via UI não combinam com policy-as-code" — essa tensão é o nó central da decisão. `CerbosAuthorizationAdapter` existe (worker-functions/src/modules/identity/infrastructure/CerbosAuthorizationAdapter.ts:34) mas está desligado. O frontend envia `roles:[]` hardcoded (enlite-frontend/src/infrastructure/repositories/CerbosAuthorizationRepository.ts:18), o que significa que toda avaliação Cerbos retorna negativo atualmente.

## Decision

Representar permissões efetivas como array `permissions[]` no JWT custom claim, calculadas via SQL `get_user_effective_permissions()` (UNION dos grupos do usuário) no momento do login/refresh. O Cerbos avalia resource-policies com condition `'recurso:ação' in request.principal.attr.permissions`. Não se usa Admin API sync nem principal_policies estáticas. O `CerbosAuthorizationAdapter` injeta `principal.attr.permissions` a partir do claim JWT. Mudanças de grupo revogam refresh token via `admin.auth().revokeRefreshTokens()`. O bug `roles:[]` é corrigido como pré-requisito de deploy, não como consequência.

Mudanças concretas:
- Implementar função SQL `get_user_effective_permissions(user_id)` (UNION de todos os grupos do usuário)
- Adicionar custom claim `permissions[]` ao JWT no login e no refresh token
- Atualizar `CerbosAuthorizationAdapter` para injetar `principal.attr.permissions` a partir do claim
- Escrever resource-policies Cerbos (18 YAML estimados) com condition `'recurso:ação' in request.principal.attr.permissions`
- Implementar revogação de refresh token via `admin.auth().revokeRefreshTokens()` ao alterar grupos
- Corrigir bug `roles:[]` hardcoded em `CerbosAuthorizationRepository.ts:18`

## Consequences

### Positivas
- Nenhuma sincronização de policy ao criar/editar grupo — apenas SQL + revogação de token; zero-coupling com Cerbos SSOT
- Policies estáticas por recurso (18 YAML) são auditáveis em git; revisão de permissão é diff de arquivo
- Fail-closed nativo do Cerbos: ausência de policy nega por padrão
- Extensível para ABAC futuro (department[], zone) sem mudança de schema — só novos atributos no principal.attr

### Negativas
- Mudança de grupo só aplica após refresh (TTL 1h) ou revogação explícita; janela de permissão residual de até 1h
- JWT cresce com `permissions[]`; tokens com muitos grupos podem exceder limite de header HTTP (risco a monitorar)
- Lógica de revogação via `revokeRefreshTokens()` é crítica — erro silencioso em revogação mantém permissões antigas ativas

### Neutras
- Correção do bug `roles:[]` é pré-condição de deploy, não consequência da decisão
- `SimplifiedAuthorizationEngine` permanece como fallback via flag `USE_CERBOS`

## Alternatives Considered

### Alternativa A: Admin API sync ao salvar grupo
Ao criar/editar grupo no backend, chamar Cerbos Admin API para sincronizar principal_policies dinamicamente.

**Descartada porque:** Mapeamento grupo→policy é dinâmico (criado via UI), tornando Cerbos não-SSOT das permissões; latência de sync adiciona risco de inconsistência; rollback de sync parcial é complexo; Admin API do Cerbos não é projetada para esse padrão de uso em alta frequência.

### Alternativa B: DB-driven sem Cerbos
Implementar autorização como middleware próprio consultando banco de permissões diretamente, sem Cerbos.

**Descartada porque:** D2 do plano-mestre trava Cerbos explicitamente; middleware próprio viraria PDP sem suporte nativo a ABAC, sem audit log estruturado, sem fail-closed garantido; replicaria uma engine de autorização que já existe e é mantida.

## Rollback

Setar `USE_CERBOS=false` retorna ao `SimplifiedAuthorizationEngine` sem mudança de schema ou migration. Custom claims `permissions[]` no JWT são ignorados pelo SimplifiedAuthorizationEngine. Tokens já emitidos com `permissions[]` são tolerados via fallback de parsing (campo ausente = array vazio). Rollback não exige revogação em massa de tokens.

## Implementation Notes

- Migrations envolvidas: N/A (nenhuma mudança de schema requerida — `permissions[]` é calculado em runtime via SQL)
- Feature flags: `USE_CERBOS` (default off até deploy validado)
- Follow-up DP (em `docs/FOLLOWUPS.md`): DP-003

## References

- docs/features/permissions/00-master-plan.md
- worker-functions/src/modules/identity/infrastructure/CerbosAuthorizationAdapter.ts
- enlite-frontend/src/infrastructure/repositories/CerbosAuthorizationRepository.ts
- docs/features/permissions/01-requirements.md (semântica de departamento, D-P3)
- ADR-005: Multi-Tenant IAM Foundation (fundação de `tenant_id` que habilita isolamento futuro de policies por tenant)
