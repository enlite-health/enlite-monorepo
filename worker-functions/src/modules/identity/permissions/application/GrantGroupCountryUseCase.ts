/**
 * Concede / revoga um país ao grupo — o eixo "ONDE" (D115, conceito (b)).
 *
 * Depois da 278 (RLS grant-only, task 5.4) esta é a ÚNICA porta de entrada para
 * dado de pessoa de um país: o claim `country` do IdP vira atributo e não
 * concede nada. Por isso o motivo é obrigatório (banco e domínio) e a concessão
 * fica no histórico com quem concedeu — é a linha que o jurídico lê quando
 * perguntarem por que alguém no Brasil viu um cadastro argentino.
 *
 * As duas operações são idempotentes: conceder de novo devolve a concessão
 * viva; revogar o que não existe devolve 0.
 */

import type { CountryCode } from '@shared/domain/countryCodes';
import type { PermissionEventPublisher, PermissionGroupRepository } from './ports';
import { assertSupportedCountry, assertValidReason } from '../domain/PermissionGroup';
import { mutateGroup } from './groupMutation';

export interface GrantGroupCountryInput {
  tenantId: string;
  groupId: string;
  country: CountryCode;
  reason: string;
}

export class GrantGroupCountryUseCase {
  constructor(
    private readonly groups: PermissionGroupRepository,
    private readonly events: PermissionEventPublisher,
  ) {}

  async execute(input: GrantGroupCountryInput): Promise<{ scopeId: string }> {
    const country = assertSupportedCountry(input.country);
    const reason = assertValidReason(input.reason);
    const scopeId = await mutateGroup(
      { groups: this.groups, events: this.events },
      input.tenantId,
      input.groupId,
      () => this.groups.grantCountry(input.groupId, country, reason),
    );
    return { scopeId };
  }
}

export interface RevokeGroupCountryInput {
  tenantId: string;
  groupId: string;
  country: CountryCode;
}

export class RevokeGroupCountryUseCase {
  constructor(
    private readonly groups: PermissionGroupRepository,
    private readonly events: PermissionEventPublisher,
  ) {}

  async execute(input: RevokeGroupCountryInput): Promise<{ revoked: number }> {
    const country = assertSupportedCountry(input.country);
    const revoked = await mutateGroup(
      { groups: this.groups, events: this.events },
      input.tenantId,
      input.groupId,
      () => this.groups.revokeCountry(input.groupId, country),
    );
    return { revoked };
  }
}
