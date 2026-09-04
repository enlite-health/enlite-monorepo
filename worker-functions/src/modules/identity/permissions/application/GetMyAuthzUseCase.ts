/**
 * O contrato agregado do painel (`GET /v1/me/authz`, design 11): UMA resposta
 * com permissões, países, disponibilidade por país, status e grupos.
 *
 * É agregado de propósito — e no formato do BFF futuro (D115 §7). O painel
 * carrega isto uma vez no login e decide TUDO com ele: `feature indisponível →
 * esconde`, `sem permissão → desabilita com motivo`. Três endpoints separados
 * dariam três estados de carregamento e a chance de renderizar com meia
 * verdade.
 *
 * `enforcement` (D268) é INJETADO, nunca lido daqui — nenhum arquivo do módulo
 * `permissions` lê `PERMISSION_ENGINE_ENABLED` (só comentários a citam; o
 * `PermissionService` lê outra env, o TTL do cache). O wiring (`wirePermissionsModule.ts`)
 * lê `isEnvFlagOn('PERMISSION_ENGINE_ENABLED')` UMA vez, no boot, e passa o
 * booleano para `createPermissionsModule` — a mesma fonte de verdade que o
 * `PermissionMiddleware` usa para decidir se a request é gated de verdade.
 */

import type { AuthzContract, PermissionClient } from './ports';
import type { PermissionService } from './PermissionService';

export interface GetMyAuthzInput {
  uid: string;
  tenantId: string;
}

export class GetMyAuthzUseCase {
  constructor(
    private readonly permissions: PermissionClient & Pick<PermissionService, 'features'>,
    /** `false` por padrão — fail-closed: sem injeção explícita, o contrato diz "off". */
    private readonly engineEnabled: boolean = false,
  ) {}

  async execute(input: GetMyAuthzInput): Promise<AuthzContract> {
    const [resolved, features] = await Promise.all([
      this.permissions.resolve(input.uid, input.tenantId),
      this.permissions.features(),
    ]);
    return { ...resolved, features, enforcement: this.engineEnabled ? 'on' : 'off' };
  }
}
