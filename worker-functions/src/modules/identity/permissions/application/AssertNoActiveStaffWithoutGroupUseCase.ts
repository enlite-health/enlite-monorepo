/**
 * O gate da virada — e o alarme de runtime (lex C2).
 *
 * Depois da D114 o grupo é a ÚNICA fonte de acesso: staff ACTIVE sem nenhum
 * grupo vigente vê a tela de boas-vindas e mais nada. Virar
 * `PERMISSION_ENGINE_ENABLED` antes da migração de dados apagaria o painel para
 * todo mundo de uma vez.
 *
 * Este use case mede isso de duas maneiras, com propósitos diferentes:
 *
 *  · `execute()` — a CONTAGEM. É o gate: o operador roda antes do flip (também
 *    disponível como `scripts/assert-no-staff-without-group.sql`, que FALHA com
 *    exceção) e cola o resultado no diário.
 *  · `alertOnBoot()` — o ALARME. Roda uma vez por boot, loga e segue. Nunca
 *    lança: derrubar worker-functions por causa do painel tiraria do ar a app do
 *    prestador, os leads e os webhooks (o veto explícito do lex).
 */

import { logger } from '@shared/logging';
import type { EffectiveAuthzRepository, RolloutStateRepository } from './ports';

/** Marcador que a migração de dados (grupo 5) acende neste ambiente. */
export const ROLLOUT_MARKER_KEY = 'permission_groups_migrated';

export interface StaffWithoutGroupReport {
  tenantId: string;
  count: number;
  /** A migração de dados já rodou neste ambiente? */
  migrated: boolean;
}

export class AssertNoActiveStaffWithoutGroupUseCase {
  constructor(
    private readonly authz: EffectiveAuthzRepository,
    private readonly rollout: RolloutStateRepository,
  ) {}

  async execute(tenantId: string): Promise<StaffWithoutGroupReport> {
    const [count, marker] = await Promise.all([
      this.authz.countActiveStaffWithoutGroup(tenantId),
      this.rollout.get(ROLLOUT_MARKER_KEY),
    ]);
    return { tenantId, count, migrated: marker !== null };
  }

  /**
   * 1x por boot. Qualquer erro (banco fora, tabela ausente num ambiente antigo)
   * vira log — este caminho não tem direito de impedir o processo de subir.
   */
  async alertOnBoot(tenantId: string, engineEnabled: boolean): Promise<void> {
    try {
      const report = await this.execute(tenantId);
      if (!report.migrated) {
        logger[engineEnabled ? 'error' : 'info'](
          { tenantId, staffWithoutGroup: report.count, engineEnabled },
          '[perm] migração de dados de grupos NÃO marcada neste ambiente (iam.rollout_state)',
        );
        return;
      }
      if (report.count > 0) {
        logger.warn(
          { tenantId, staffWithoutGroup: report.count },
          '[perm] staff ativo sem nenhum grupo vigente — essas contas caem na tela de boas-vindas',
        );
        return;
      }
      logger.info({ tenantId }, '[perm] todo staff ativo tem grupo vigente');
    } catch (err) {
      logger.error({ err, tenantId }, '[perm] falha ao medir staff sem grupo no boot — seguindo assim mesmo');
    }
  }
}
