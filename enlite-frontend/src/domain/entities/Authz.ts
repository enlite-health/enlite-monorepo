/**
 * O contrato de autorização do próprio ator — `GET /v1/me/authz`.
 *
 * Espelha `AuthzContract` do backend (`identity/permissions/application/ports.ts`).
 * O painel carrega isto UMA vez no login e decide tudo com ele: sem célula → o
 * componente não existe; só `read` → existe sem ação de conclusão; `write` →
 * completo. Nunca é derivado de `role`: quem resolve é o banco (lex C3).
 */

export type StaffStatus = 'ACTIVE' | 'PENDING_ONBOARDING' | 'SUSPENDED' | 'DEACTIVATED';

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
