/**
 * Arquiva um grupo criado pela tela. Arquivar ≠ excluir: o grupo para de
 * conceder na próxima request e some das listas ativas, mas a composição, os
 * membros e as concessões continuam consultáveis (spec permission-groups).
 *
 * Membro que fique sem NENHUM grupo vigente cai na tela de boas-vindas — por
 * isso a contagem de membros volta no resultado: é o número que o painel mostra
 * na confirmação ("3 pessoas perdem o que este grupo dava").
 */

import type { PermissionEventPublisher, PermissionGroupRepository } from './ports';
import { assertNotSystemGroup } from '../domain/PermissionGroup';
import { mutateGroup } from './groupMutation';

export interface ArchiveGroupInput {
  tenantId: string;
  groupId: string;
}

export class ArchiveGroupUseCase {
  constructor(
    private readonly groups: PermissionGroupRepository,
    private readonly events: PermissionEventPublisher,
  ) {}

  async execute(input: ArchiveGroupInput): Promise<{ affectedMembers: number }> {
    return mutateGroup(
      { groups: this.groups, events: this.events },
      input.tenantId,
      input.groupId,
      async (group) => {
        assertNotSystemGroup(group, 'arquivar');
        await this.groups.archive(input.groupId);
        return { affectedMembers: group.memberCount };
      },
    );
  }
}
