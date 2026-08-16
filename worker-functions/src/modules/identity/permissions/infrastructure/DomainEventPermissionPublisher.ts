/**
 * src/modules/identity/permissions/infrastructure/DomainEventPermissionPublisher.ts
 *
 * Invalidação de cache ENTRE instâncias (design 4). O Cloud Run roda N
 * instâncias; quem faz a mudança limpa o próprio cache na hora, mas as outras
 * só saberiam pelo TTL. O evento no outbox (`domain_events`) fecha essa janela:
 * a instância que processa o evento limpa o cache dela.
 *
 * ⚠️ Evento SEM handler registrado vira `failed` no processador e acende o
 * alerta de backlog — foi assim que o `vacancy.created` ficou meses acendendo
 * alarme (D82). Por isso o publisher nasce junto com
 * `registerPermissionEventHandlers`, e o wiring registra os dois ou nenhum.
 */

import type { Pool } from 'pg';
import { enqueueDomainEvent } from '@shared/events/enqueueDomainEvent';
import { logger, loggingAls } from '@shared/logging';
import type { CountryCode } from '@shared/domain/countryCodes';
import type { PermissionEventPublisher } from '../application/ports';

export const PERMISSION_CHANGED_EVENT = 'permission.changed';
export const COUNTRY_FEATURE_CHANGED_EVENT = 'country_feature.changed';

export class DomainEventPermissionPublisher implements PermissionEventPublisher {
  constructor(private readonly pool: Pool) {}

  private traceId(): string | null {
    return loggingAls?.getStore?.()?.traceId ?? null;
  }

  /**
   * Best-effort: a mudança de permissão JÁ foi commitada pela função da 279
   * quando isto roda. Falhar aqui não pode desfazer a operação do gestor — o
   * pior caso é a outra instância enxergar o estado antigo por ≤ TTL, que é
   * exatamente o contrato documentado da spec.
   */
  async permissionChanged(uids: string[]): Promise<void> {
    if (uids.length === 0) return;
    try {
      await enqueueDomainEvent(this.pool, {
        event: PERMISSION_CHANGED_EVENT,
        payload: { uids },
        traceId: this.traceId(),
      });
    } catch (err) {
      logger.warn({ err, count: uids.length }, '[perm] falha ao publicar permission.changed — cache expira por TTL');
    }
  }

  async countryFeatureChanged(country: CountryCode, featureKey: string): Promise<void> {
    try {
      await enqueueDomainEvent(this.pool, {
        event: COUNTRY_FEATURE_CHANGED_EVENT,
        payload: { country, featureKey },
        traceId: this.traceId(),
      });
    } catch (err) {
      logger.warn({ err, country, featureKey }, '[perm] falha ao publicar country_feature.changed — cache expira por TTL');
    }
  }
}
