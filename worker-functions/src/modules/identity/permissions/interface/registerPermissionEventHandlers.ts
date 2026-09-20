/**
 * src/modules/identity/permissions/interface/registerPermissionEventHandlers.ts
 *
 * Fecha o ciclo da invalidação de cache: o publisher enfileira
 * `permission.changed` / `country_feature.changed` em `domain_events`, e a
 * instância que processa o evento limpa o cache local.
 *
 * ⚠️ Registrar os handlers NÃO é opcional: evento sem handler vira `failed` no
 * `DomainEventProcessor` e acende o alerta de backlog — o modo de falha que
 * deixou `vacancy.created` alarmando por meses (D82) e o Ana Care 11 dias mudo
 * (D100). Por isso este registro nasce no mesmo PR do publisher.
 */

import { logger } from '@shared/logging';
import { isCountryCode } from '@shared/domain/countryCodes';
import {
  COUNTRY_FEATURE_CHANGED_EVENT,
  PERMISSION_CHANGED_EVENT,
} from '../infrastructure/DomainEventPermissionPublisher';
import type { PermissionService } from '../application/PermissionService';

/** Só o que este módulo usa do `DomainEventProcessor` (sem importar a classe). */
export interface HandlerRegistry {
  registerHandler(event: string, handler: (payload: Record<string, unknown>) => Promise<void>): void;
}

function uidsOf(payload: Record<string, unknown>): string[] {
  const raw = payload.uids;
  return Array.isArray(raw) ? raw.filter((uid): uid is string => typeof uid === 'string') : [];
}

export function registerPermissionEventHandlers(
  registry: HandlerRegistry,
  permissions: PermissionService,
): void {
  registry.registerHandler(PERMISSION_CHANGED_EVENT, async (payload) => {
    const uids = uidsOf(payload);
    // Payload sem uid legível (evento antigo, publisher de outra versão) → limpa
    // tudo. Cache frio custa uma consulta; cache errado custa acesso indevido.
    permissions.invalidate(uids.length > 0 ? uids : undefined);
    logger.info({ count: uids.length }, '[perm] cache de permissões invalidado por evento');
  });

  registry.registerHandler(COUNTRY_FEATURE_CHANGED_EVENT, async (payload) => {
    permissions.invalidateFeatures();
    const country = payload.country;
    logger.info(
      { country: isCountryCode(country) ? country : null, featureKey: payload.featureKey ?? null },
      '[perm] cache de disponibilidade por país invalidado por evento',
    );
  });
}
