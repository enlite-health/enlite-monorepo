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
import { cellsOfScreen, containersOfTab, type ScreenDef } from '@presentation/config/screenRegistry';

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

export interface ContainerAccess {
  /** O container aparece (card, aba, coluna). Sem enforcement ligado: sempre. */
  visible: boolean;
  /** As ações de escrita do container aparecem. Sem enforcement ligado: sempre. */
  canWrite: boolean;
}

/**
 * D286 — o gate de CONTAINER: um card/aba/coluna da tela existe para quem tem `resource:read`
 * (ou mais), e oferece edição para quem tem `resource:write`.
 *
 * Mesmo freio do `useActionGate`/`ActionButton` (D268/D269): só gateia com `enforcement === 'on'`.
 * Com `'off'`/contrato ausente o container aparece como sempre apareceu — as células novas
 * nascem SEM grupo (`lex` P5), e um gate sem esse freio apagaria a ficha do paciente inteira
 * no dia em que o código chegasse ao `main` com o engine desligado.
 */
export function useContainerAccess(resource: string): ContainerAccess {
  const enforcement = useAdminAuthStore((s) => s.authz?.enforcement);
  const access = useCellAccess(resource);
  if (enforcement !== 'on') return { visible: true, canWrite: true };
  return { visible: access.canRead, canWrite: access.canWrite };
}

/**
 * Pura, sem React — para decidir VÁRIOS containers de uma vez (as abas de uma tela): a aba
 * existe se qualquer container dela for legível. Mesmo freio de enforcement.
 */
export function containersVisibleFor(
  permissions: readonly string[] | null | undefined,
  enforcement: string | undefined,
  resources: readonly string[],
): boolean {
  if (enforcement !== 'on') return true;
  return resources.some((r) => accessLevelFor(permissions ?? null, r) !== 'hidden');
}

/**
 * As abas de uma tela que existem para este ator (D286): uma aba existe se QUALQUER container
 * dela for legível. Aba que não tem container no registro (placeholder "Próximamente") não
 * guarda dado — existe sempre. A ativa é decidida pelo chamador (a primeira visível quando a
 * atual sumiu).
 */
export function tabsVisibleFor<T extends string>(
  screen: ScreenDef,
  tabs: readonly T[],
  permissions: readonly string[] | null | undefined,
  enforcement: string | undefined,
): T[] {
  if (enforcement !== 'on') return [...tabs];
  return tabs.filter((tab) => {
    const containers = containersOfTab(screen, tab);
    // "NENHUMA permissão daquela aba" é literal: qualquer célula declarada por qualquer container
    // da aba (read, write, execute, send…) — não só o par read/write do `accessLevelFor`.
    return containers.length === 0 || containers.some((ct) => ct.cells.some((cell) => permissions?.includes(cell)));
  });
}

/**
 * A TELA existe para este ator (D286, um nível acima de `tabsVisibleFor`) — é o que decide se o
 * item de menu que a abre aparece. Mesmo freio de enforcement: com o engine OFF, existe sempre.
 *
 * Qual célula abre a tela vem do registro:
 *  - tela que DECLARA células próprias (a lista; `dashboard:read` = "abrir a tela"): qualquer uma
 *    delas. As dos containers NÃO abrem: `patient:read` é bloco de Gestión a la Vista, mas quem só
 *    tem ela leva 403 na rota que monta a tela — o item apareceria para levar a um erro (medido no
 *    e2e `admin-menu-por-celula`, 07/09);
 *  - tela SÓ de containers (mapa, detalhes): qualquer célula de qualquer container, em qualquer ação
 *    — a mesma régua das abas.
 */
export function screenVisibleFor(
  screen: ScreenDef,
  permissions: readonly string[] | null | undefined,
  enforcement: string | undefined,
): boolean {
  if (enforcement !== 'on') return true;
  const abrem = screen.cells && screen.cells.length > 0 ? screen.cells : cellsOfScreen(screen);
  return abrem.some((cell) => permissions?.includes(cell));
}
