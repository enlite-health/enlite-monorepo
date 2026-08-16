/**
 * src/modules/identity/permissions/application/groupMutation.ts
 *
 * O que TODA mutação de grupo tem em comum: achar o grupo no tenant do operador
 * (senão 404 — grupo de outro tenant é indistinguível de inexistente), mutar, e
 * avisar quem foi afetado para o cache cair.
 *
 * A audiência é medida ANTES e DEPOIS da mutação porque as duas pontas
 * importam: quem SAIU do grupo precisa perder o acesso em cache tanto quanto
 * quem entrou precisa ganhar. Medir só depois deixaria o removido com as
 * permissões antigas até o TTL — exatamente o caso que a spec chama de "vale na
 * próxima request".
 */

import type { PermissionGroupDetail } from '../domain/PermissionGroup';
import { PermissionError } from '../domain/PermissionError';
import type { PermissionEventPublisher, PermissionGroupRepository } from './ports';

export interface GroupMutationDeps {
  groups: PermissionGroupRepository;
  events: PermissionEventPublisher;
}

/** Grupo do tenant, ou `not_found`. Nunca revela existência em outro tenant. */
export async function requireGroup(
  groups: PermissionGroupRepository,
  tenantId: string,
  groupId: string,
): Promise<PermissionGroupDetail> {
  const group = await groups.findById(tenantId, groupId);
  if (!group) throw new PermissionError('not_found', 'Grupo não encontrado');
  return group;
}

/**
 * Roda a mutação e publica `permission.changed` com a união dos membros de
 * antes e depois.
 */
export async function mutateGroup<T>(
  deps: GroupMutationDeps,
  tenantId: string,
  groupId: string,
  mutate: (group: PermissionGroupDetail) => Promise<T>,
): Promise<T> {
  const group = await requireGroup(deps.groups, tenantId, groupId);
  const before = await deps.groups.liveMemberUids(tenantId, groupId);
  const result = await mutate(group);
  const after = await deps.groups.liveMemberUids(tenantId, groupId);
  await deps.events.permissionChanged([...new Set([...before, ...after])]);
  return result;
}
