/**
 * Substitui o CONJUNTO de células do grupo (a matriz da tela é um formulário
 * inteiro, não um botão por célula). O diff vira trilha em
 * `iam.permission_group_changes` dentro da mesma transação (mig 279).
 *
 * A tradução chave → id acontece aqui contra o CATÁLOGO: chave que não existe
 * (ou está descontinuada) não vira id e a operação é recusada com a lista do que
 * faltou. Sem isso, um typo viraria "grupo com uma célula a menos" em silêncio —
 * o modo de falha mais caro deste módulo, porque ninguém percebe até alguém
 * perder acesso.
 */

import { PermissionError } from '../domain/PermissionError';
import { assertValidReason } from '../domain/PermissionGroup';
import { expandWriteCells, isValidCellKey } from '../domain/PermissionCell';
import type {
  PermissionCatalogRepository,
  PermissionEventPublisher,
  PermissionGroupRepository,
} from './ports';
import { mutateGroup } from './groupMutation';

export interface SetGroupPermissionsInput {
  tenantId: string;
  groupId: string;
  /** Chaves `recurso:ação`. Lista vazia = grupo sem nenhuma ação (permitido). */
  cellKeys: string[];
  /** Opcional; quando vem, é validado e gravado na trilha do diff. */
  reason?: string | null;
}

export class SetGroupPermissionsUseCase {
  constructor(
    private readonly groups: PermissionGroupRepository,
    private readonly catalog: PermissionCatalogRepository,
    private readonly events: PermissionEventPublisher,
  ) {}

  async execute(input: SetGroupPermissionsInput): Promise<{ cells: number }> {
    const reason = input.reason == null || input.reason === '' ? null : assertValidReason(input.reason);
    // ADR-2/SUP-30, janela de transição: `<recurso>:write` de recurso splitado é
    // EXPANDIDO para `<recurso>:create` + `<recurso>:update` aqui, na gravação — quem
    // salva a matriz marcando "write" (tela antiga, ou um `iam-config` de import
    // ainda não migrado) nunca grava `write` de novo para um recurso splitado.
    // `permission_management:write` passa intacto (não é recurso splitado).
    const requested = expandWriteCells([...new Set(input.cellKeys)]);

    const malformed = requested.filter((key) => !isValidCellKey(key));
    if (malformed.length > 0) {
      throw new PermissionError('invalid_cell', `Célula com formato inválido: ${malformed.join(', ')}`);
    }

    const ids = await this.catalog.idsByCellKey(requested);
    const unknown = requested.filter((key) => !ids.has(key));
    if (unknown.length > 0) {
      throw new PermissionError(
        'invalid_cell',
        `Célula fora do catálogo ou descontinuada: ${unknown.join(', ')}`,
      );
    }

    await mutateGroup({ groups: this.groups, events: this.events }, input.tenantId, input.groupId, () =>
      this.groups.setPermissions(input.groupId, [...ids.values()], reason),
    );
    return { cells: requested.length };
  }
}
