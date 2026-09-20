/**
 * Renomeia / descreve um grupo. Grupo de sistema não renomeia (spec) — a
 * checagem existe aqui E na função da 279; a daqui é a que dá a mensagem certa
 * sem ida ao banco, a de lá é a que vale.
 *
 * Publica `permission.changed` mesmo mudando só o nome: a resposta de
 * `/v1/me/authz` carrega o nome do grupo, e um cache com o nome velho faz a tela
 * mostrar uma coisa e a auditoria outra.
 */

import type { PermissionGroupRepository, PermissionEventPublisher } from './ports';
import { assertNotSystemGroup, assertValidGroupName } from '../domain/PermissionGroup';
import { mutateGroup } from './groupMutation';

export interface UpdatePermissionGroupInput {
  tenantId: string;
  groupId: string;
  name?: string;
  description?: string | null;
}

export class UpdatePermissionGroupUseCase {
  constructor(
    private readonly groups: PermissionGroupRepository,
    private readonly events: PermissionEventPublisher,
  ) {}

  async execute(input: UpdatePermissionGroupInput): Promise<void> {
    await mutateGroup({ groups: this.groups, events: this.events }, input.tenantId, input.groupId, async (group) => {
      const name = input.name === undefined ? undefined : assertValidGroupName(input.name);
      if (name !== undefined && name !== group.name) assertNotSystemGroup(group, 'renomear');
      await this.groups.update(input.groupId, {
        ...(name !== undefined ? { name } : {}),
        description: input.description === undefined ? group.description : input.description,
      });
    });
  }
}
