/**
 * Cria um grupo (vazio nos dois eixos). O painel avisa que um grupo sem célula
 * não dá ação e sem país não dá dado de pessoa (spec permission-groups) — mas
 * criar vazio é permitido: é o passo 1 do fluxo "criar → marcar células →
 * conceder país → colocar gente".
 *
 * A autorização (`permission_management:write`), a unicidade do nome e o tenant
 * são checados NO BANCO pela função `iam.create_group` (mig 279). Aqui só a
 * validação barata de formato, para a mensagem ser boa.
 */

import type { PermissionGroupRepository } from './ports';
import { assertValidGroupName } from '../domain/PermissionGroup';

export interface CreatePermissionGroupInput {
  tenantId: string;
  name: string;
  description?: string | null;
}

export class CreatePermissionGroupUseCase {
  constructor(private readonly groups: PermissionGroupRepository) {}

  async execute(input: CreatePermissionGroupInput): Promise<{ groupId: string }> {
    const name = assertValidGroupName(input.name);
    const groupId = await this.groups.create({
      tenantId: input.tenantId,
      name,
      description: input.description ?? null,
    });
    return { groupId };
  }
}
