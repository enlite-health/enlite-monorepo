/**
 * Coloca e tira gente do grupo. Sair é SOFT (`removed_at`/`removed_by`, mig
 * 275): o vínculo deixa de valer imediatamente e o histórico fica consultável —
 * "quem entrou quando, quem tirou quando" é metade da resposta a uma auditoria.
 *
 * O anti-lockout (última pessoa com `permission_management:write`) roda DENTRO
 * da transação da função `iam.remove_member`, com lock por tenant: duas remoções
 * simultâneas de gestores diferentes não conseguem zerar a gestão. Repetir essa
 * contagem aqui seria pior que inútil — daria a impressão de proteção sem o
 * lock, e dois cliques concorrentes passariam.
 */

import type { PermissionEventPublisher, PermissionGroupRepository } from './ports';
import { mutateGroup } from './groupMutation';

export interface GroupMemberInput {
  tenantId: string;
  groupId: string;
  userId: string;
}

export class AddGroupMemberUseCase {
  constructor(
    private readonly groups: PermissionGroupRepository,
    private readonly events: PermissionEventPublisher,
  ) {}

  async execute(input: GroupMemberInput): Promise<{ membershipId: string }> {
    const membershipId = await mutateGroup(
      { groups: this.groups, events: this.events },
      input.tenantId,
      input.groupId,
      () => this.groups.addMember(input.groupId, input.userId),
    );
    return { membershipId };
  }
}

export class RemoveGroupMemberUseCase {
  constructor(
    private readonly groups: PermissionGroupRepository,
    private readonly events: PermissionEventPublisher,
  ) {}

  async execute(input: GroupMemberInput): Promise<{ removed: number }> {
    const removed = await mutateGroup(
      { groups: this.groups, events: this.events },
      input.tenantId,
      input.groupId,
      () => this.groups.removeMember(input.groupId, input.userId),
    );
    return { removed };
  }
}
