/**
 * PermissionClientActorAccessChecker — adaptador de `ActorPatientConversationAccessChecker`
 * (Spec 022, Bloco 4, T406) sobre o `PermissionClient` real de `@modules/identity/permissions`.
 *
 * `permissionsBoundary.permissions.client.can(uid, tenantId, resource, action)` é a leitura CRUA
 * do catálogo ABAC (`iam.group_permissions`) — não passa por `PERMISSION_ENGINE_ENABLED`/
 * `PERMISSION_ENFORCED_ROUTES` (essas duas alavancas só gateiam o MIDDLEWARE HTTP; ver
 * `PermissionMiddleware.ts`). D-13 (revisado no fecho B5) pergunta um FATO de dado ("este uid TEM
 * a célula hoje?" — hoje o DESTINATÁRIO, não mais o ator).
 *
 * 🔒 Achado F24/item 5b (change 022-ux-mencao-e-notificacao, `fatos-medidos.md`): "mesmo com o
 * engine desligado em prd, a resposta já reflete os grants reais" (D-27, comentário antigo desta
 * classe) descrevia exatamente o BUG, não uma garantia — em prd
 * (`.github/workflows/backend-prd.yml`) `PERMISSION_ENGINE_ENABLED=false`, e nesse modo a rota
 * REAL da conversa (`PermissionMiddleware`, F22) deixa passar QUALQUER staff autenticado. Ler só
 * o catálogo cru aqui é MAIS RESTRITIVO que esse acesso real — a família `patient_conversation`
 * nasce com 0 grupos fora do "Acesso Master" (D285/D329), então qualquer staff fora do Master via
 * `false`, mesmo já podendo abrir a conversa de verdade. Corrigido: quando a família
 * `admin.patients` (a família da ROTA de conversa, não da rota de notificação) não está
 * enforced — `isPermissionFamilyEnforced`, item 5b — o acesso real já é "qualquer staff", então
 * este checker também devolve `true` sem consultar o catálogo. Com a família enforced, nada muda
 * (F23, grant real decide, como sempre).
 */
import type { PermissionClient } from '@modules/identity/permissions';
import { ADMIN_PATIENTS_FAMILY, ENLITE_TENANT_ID, isPermissionFamilyEnforced } from '@modules/identity/permissions';
import type { ActorPatientConversationAccessChecker } from '../application/ports';

export class PermissionClientActorAccessChecker implements ActorPatientConversationAccessChecker {
  constructor(
    private readonly client: PermissionClient,
    private readonly tenantId: string = ENLITE_TENANT_ID,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async canReadPatientConversation(actorUid: string): Promise<boolean> {
    if (!isPermissionFamilyEnforced(ADMIN_PATIENTS_FAMILY, this.env)) return true;
    return this.client.can(actorUid, this.tenantId, 'patient_conversation', 'read');
  }
}
