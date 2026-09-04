/**
 * O contrato de autorização do próprio ator — `GET /v1/me/authz`.
 *
 * Espelha `AuthzContract` do backend (`identity/permissions/application/ports.ts`).
 * O painel carrega isto UMA vez no login e decide tudo com ele: sem célula → o
 * componente não existe; só `read` → existe sem ação de conclusão; `write` →
 * completo. Nunca é derivado de `role`: quem resolve é o banco (lex C3).
 */

export type StaffStatus = 'ACTIVE' | 'PENDING_ONBOARDING' | 'SUSPENDED' | 'DEACTIVATED';

/**
 * Liga a régua ABAC na request. Ausente (backend ainda não reconstruído com o
 * campo — D268) é tratado como `'off'` em TODA leitura: nunca `on` por padrão.
 */
export type Enforcement = 'on' | 'off';

export interface AuthzContract {
  uid: string;
  tenantId: string;
  status: StaffStatus | null;
  /** Chaves `recurso:ação` — união dos grupos vivos. */
  permissions: string[];
  countries: string[];
  groups: Array<{ id: string; name: string }>;
  /** país → featureKey → {enabled, config}. */
  features: Record<string, Record<string, { enabled: boolean; config: unknown }>>;
  /** Ausente = `'off'` (contrato de transição — ver `Enforcement`). */
  enforcement?: Enforcement;
}

/**
 * O que um componente pode ser para o ator:
 *  - `hidden`: nem `read` nem `write` na célula → não renderiza.
 *  - `read`: só leitura → sem botões que concluem edição; inputs viram texto.
 *  - `write`: completo.
 */
export type AccessLevel = 'hidden' | 'read' | 'write';

/** Estado de carregamento do contrato na store. `error`/`idle`/`loading` contam como `hidden`. */
export type AuthzStatus = 'idle' | 'loading' | 'ready' | 'error';

export function cellKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

/**
 * A regra — pura, sem React, para a tabela-verdade ser testável sozinha.
 * `delete`/`export`/`execute` NÃO elevam a `write`: são ações próprias e o
 * componente que as oferece pergunta por elas explicitamente (`hasCell`).
 */
export function accessLevelFor(permissions: readonly string[] | null, resource: string): AccessLevel {
  if (!permissions) return 'hidden';
  if (permissions.includes(cellKey(resource, 'write'))) return 'write';
  if (permissions.includes(cellKey(resource, 'read'))) return 'read';
  return 'hidden';
}

export function hasCell(permissions: readonly string[] | null, resource: string, action: string): boolean {
  return permissions?.includes(cellKey(resource, action)) ?? false;
}

/**
 * A1 (D268) — pura, sem React: quando o shell admin mostra `WelcomeNoGroupPage`
 * no lugar do painel operacional.
 *
 * `enforcement !== 'on'` (inclusive ausente) NUNCA mostra welcome — é o freio
 * de rollout (D268: nada de ABAC no `main` antes da D113). Só com a régua
 * ligada é que a ausência de grupo vivo, ou uma conta que saiu de `ACTIVE`,
 * vira a tela de boas-vindas em vez do painel.
 */
export function shouldShowWelcomeNoGroup(authz: AuthzContract | null, status: AuthzStatus): boolean {
  if (status !== 'ready' || !authz) return false;
  if (authz.enforcement !== 'on') return false;
  const semGrupo = authz.groups.length === 0;
  const inativo = authz.status !== null && authz.status !== 'ACTIVE';
  return semGrupo || inativo;
}

/** Uma decisão de `useFeature` — o `reason` é só para o warn (nunca aparece na UI). */
export interface FeatureDecision {
  enabled: boolean;
  reason: 'enabled' | 'disabled' | 'missing-map' | 'missing-key' | 'no-actor-country';
}

/**
 * B1 (D268) — pura, sem React: fail-OPEN por MAPA (ausente/vazio, ou ator sem
 * país único — não há campo de país PRÓPRIO no contrato hoje, só a união dos
 * países dos grupos; com 0 ou >1 país a leitura é ambígua e a régua abre),
 * fail-CLOSED só por CHAVE presente e `enabled:false`. Chave ausente no mapa
 * também abre (mapa incompleto não é "decidido false").
 */
export function featureEnabledFor(
  features: AuthzContract['features'] | null | undefined,
  countries: readonly string[] | null | undefined,
  featureKey: string,
): FeatureDecision {
  if (!countries || countries.length !== 1) return { enabled: true, reason: 'no-actor-country' };
  const country = countries[0];
  const mapaDoPais = features?.[country];
  if (!mapaDoPais || Object.keys(mapaDoPais).length === 0) return { enabled: true, reason: 'missing-map' };
  const entrada = mapaDoPais[featureKey];
  if (!entrada) return { enabled: true, reason: 'missing-key' };
  return { enabled: entrada.enabled, reason: entrada.enabled ? 'enabled' : 'disabled' };
}
