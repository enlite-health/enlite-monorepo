/**
 * src/modules/identity/permissions/application/EndGroupSimulationUseCase.ts
 *
 * Spec 026 (D407) — encerra a simulação aberta do ator (`GroupSimulationRepository.end`
 * → `iam.end_group_simulation`, idempotente: `false` quando não havia nada
 * aberto) e publica `PermissionEventPublisher.permissionChanged([uid])` SEMPRE,
 * mesmo quando `ended` sai `false` — o chamador (rota `DELETE /me/simulation`,
 * 204 sempre) não sabe o estado prévio, e invalidar um cache que já refletia a
 * ausência de simulação é barato; NÃO invalidar quando havia uma seria o bug.
 */

import type { GroupSimulationRepository, PermissionEventPublisher } from './ports';

export interface EndGroupSimulationInput {
  uid: string;
  tenantId: string;
}

export class EndGroupSimulationUseCase {
  constructor(
    private readonly simulations: GroupSimulationRepository,
    private readonly events: PermissionEventPublisher,
  ) {}

  async execute(input: EndGroupSimulationInput): Promise<{ ended: boolean }> {
    const ended = await this.simulations.end(input.uid, input.tenantId);
    await this.events.permissionChanged([input.uid]);
    return { ended };
  }
}
