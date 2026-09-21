/**
 * PermissionClientActorAccessChecker — adaptador de `ActorPatientConversationAccessChecker`
 * (Spec 022, Bloco 4, T406) sobre o `PermissionClient` real de `@modules/identity/permissions`.
 *
 * `permissionsBoundary.permissions.client.can(uid, tenantId, resource, action)` é a leitura CRUA
 * do catálogo ABAC (`iam.group_permissions`) — não passa por `PERMISSION_ENGINE_ENABLED`/
 * `PERMISSION_ENFORCED_ROUTES` (essas duas alavancas só gateiam o MIDDLEWARE HTTP; ver
 * `PermissionMiddleware.ts`). Correto aqui: D-13 (revisado no fecho B5) pergunta um FATO de dado
 * ("este uid TEM a célula hoje?" — hoje o DESTINATÁRIO, não mais o ator), não uma decisão de
 * enforcement de rota — mesmo com o engine desligado em prd (D-27), a resposta já reflete os
 * grants reais.
 */
import type { PermissionClient } from '@modules/identity/permissions';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';
import type { ActorPatientConversationAccessChecker } from '../application/ports';

export class PermissionClientActorAccessChecker implements ActorPatientConversationAccessChecker {
  constructor(
    private readonly client: PermissionClient,
    private readonly tenantId: string = ENLITE_TENANT_ID,
  ) {}

  async canReadPatientConversation(actorUid: string): Promise<boolean> {
    return this.client.can(actorUid, this.tenantId, 'patient_conversation', 'read');
  }
}
