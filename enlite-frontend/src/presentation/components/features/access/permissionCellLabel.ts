import type { TFunction } from 'i18next';

/**
 * O rótulo legível de uma célula `recurso:ação`, pelas MESMAS chaves i18n que
 * `CellMatrix`/`CellHelpDrawer`/`ScreenTree` já usam (`admin.access.group.cells.
 * resource.<recurso>` e `admin.access.group.cells.action.<ação>`) — não um
 * mapeamento novo. A tela de histórico usa esta função para não divergir do
 * rótulo que a tela do grupo mostra para a MESMA célula.
 */
export function permissionCellLabel(t: TFunction, resource: string, action: string): string {
  const recurso = t(`admin.access.group.cells.resource.${resource}`, resource);
  const acao = t(`admin.access.group.cells.action.${action}`, action);
  return `${recurso} · ${acao}`;
}
