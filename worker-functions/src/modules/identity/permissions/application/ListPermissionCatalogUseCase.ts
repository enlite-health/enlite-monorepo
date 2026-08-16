/**
 * O catálogo agrupado por categoria — é o desenho da MATRIZ na tela de grupo.
 *
 * Células descontinuadas ficam fora por padrão (sumiram do código, não devem ser
 * marcáveis) mas podem ser pedidas: a tela de auditoria precisa mostrar o que um
 * grupo tinha em uma data, e isso inclui célula que não existe mais.
 */

import type { PermissionCatalogRepository } from './ports';
import type { PermissionCell } from '../domain/PermissionCell';

export interface CatalogCategory {
  category: string;
  cells: PermissionCell[];
}

export class ListPermissionCatalogUseCase {
  constructor(private readonly catalog: PermissionCatalogRepository) {}

  async execute(options?: { includeDeprecated?: boolean }): Promise<CatalogCategory[]> {
    const cells = await this.catalog.list(options);
    const byCategory = new Map<string, PermissionCell[]>();
    for (const cell of cells) {
      const bucket = byCategory.get(cell.category);
      if (bucket) bucket.push(cell);
      else byCategory.set(cell.category, [cell]);
    }
    return [...byCategory.entries()].map(([category, group]) => ({ category, cells: group }));
  }
}
