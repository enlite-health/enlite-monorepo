/**
 * A regra por componente, em um hook.
 *
 * `useCellAccess('permission_management')` → `'hidden' | 'read' | 'write'`:
 *  - `hidden`  → o componente NÃO é renderizado (não existe na árvore);
 *  - `read`    → renderiza sem ações que concluem edição; inputs viram texto;
 *  - `write`   → completo.
 *
 * Enquanto o contrato não chegou (`idle`/`loading`) ou falhou (`error`), tudo é
 * `hidden`: a tela mostra o estado, não o comportamento antigo. Isso é
 * fail-closed de propósito — "ainda não sei" não pode parecer "pode".
 *
 * `useHasCell` é para ações que não são `read`/`write` (`delete`, `export`,
 * `execute`): elas não elevam o nível, o componente pergunta por elas.
 */
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { accessLevelFor, hasCell, type AccessLevel, type AuthzStatus } from '@domain/entities/Authz';

export interface CellAccess {
  level: AccessLevel;
  canRead: boolean;
  canWrite: boolean;
  status: AuthzStatus;
}

export function useCellAccess(resource: string): CellAccess {
  const authz = useAdminAuthStore((s) => s.authz);
  const status = useAdminAuthStore((s) => s.authzStatus);
  const level = status === 'ready' ? accessLevelFor(authz?.permissions ?? null, resource) : 'hidden';
  return { level, canRead: level !== 'hidden', canWrite: level === 'write', status };
}

export function useHasCell(resource: string, action: string): boolean {
  const authz = useAdminAuthStore((s) => s.authz);
  const status = useAdminAuthStore((s) => s.authzStatus);
  return status === 'ready' && hasCell(authz?.permissions ?? null, resource, action);
}

export interface ActionGate {
  /** `true` quando a ação pode prosseguir — ou porque tem a célula, ou porque a régua (D268) está OFF. */
  allowed: boolean;
  /** `true` SÓ quando a régua está `on` e a célula falta — o sinal pra desabilitar/esconder. */
  denied: boolean;
}

/**
 * A MESMA decisão do `ActionButton` (D269), para elemento que não é
 * `<Button>` — switch, handle de drag, etc. Reusa `useHasCell`: não duplica
 * a leitura do contrato. Só gateia com `authz.enforcement === 'on'` (D268) —
 * `'off'`/contrato ausente é sempre `allowed`.
 */
export function useActionGate(resource: string, action: string): ActionGate {
  const enforcement = useAdminAuthStore((s) => s.authz?.enforcement);
  const hasCellForAction = useHasCell(resource, action);
  if (enforcement !== 'on') return { allowed: true, denied: false };
  return { allowed: hasCellForAction, denied: !hasCellForAction };
}
