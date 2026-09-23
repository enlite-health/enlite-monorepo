/**
 * src/modules/identity/permissions/application/ListSimulatableGroupsUseCase.ts
 *
 * Spec 026 (D407), `pesquisa-modelo-de-dados.md` §6 — reusa
 * `PermissionGroupRepository.list` (que já filtra `archived_at IS NULL` por
 * default no repositório Postgres) sem query nova, tira o Acesso Master
 * (`isSystem`) e devolve só `{id, name}`, ordenado por nome — a única coisa
 * que o painel precisa para o seletor de simulação.
 */

import type { PermissionGroupRepository } from './ports';

export interface ListSimulatableGroupsInput {
  tenantId: string;
}

export interface SimulatableGroup {
  id: string;
  name: string;
}

export class ListSimulatableGroupsUseCase {
  constructor(private readonly groups: PermissionGroupRepository) {}

  async execute(input: ListSimulatableGroupsInput): Promise<SimulatableGroup[]> {
    const groups = await this.groups.list(input.tenantId);
    return groups
      .filter((group) => !group.isSystem)
      .map((group) => ({ id: group.id, name: group.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
