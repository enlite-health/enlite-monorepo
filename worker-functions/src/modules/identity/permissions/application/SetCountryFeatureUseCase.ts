/**
 * Override de disponibilidade pelo painel: "esta tela/opção/componente existe
 * (ou não) neste país". O default continua sendo o manifest em código — o
 * override só ganha dele até alguém desfazer (spec country-feature-availability).
 *
 * (lex C10) `config` é validado por JSON schema do TIPO da chave e o motivo é
 * obrigatório e sem dado de pessoa: a tabela tem retenção longa e é lida pela
 * tela de auditoria.
 */

import type { CountryCode } from '@shared/domain/countryCodes';
import { assertValidFeatureConfig, assertValidFeatureKey } from '../domain/CountryFeature';
import { assertSupportedCountry, assertValidReason } from '../domain/PermissionGroup';
import type { CountryFeatureRepository, PermissionEventPublisher } from './ports';

export interface SetCountryFeatureInput {
  country: CountryCode;
  featureKey: string;
  enabled: boolean;
  config?: unknown;
  reason: string;
}

export class SetCountryFeatureUseCase {
  constructor(
    private readonly features: CountryFeatureRepository,
    private readonly events: PermissionEventPublisher,
  ) {}

  async execute(input: SetCountryFeatureInput): Promise<void> {
    const country = assertSupportedCountry(input.country);
    const featureKey = assertValidFeatureKey(input.featureKey);
    const config = assertValidFeatureConfig(featureKey, input.config);
    const reason = assertValidReason(input.reason);

    await this.features.setOverride(country, featureKey, input.enabled, config, reason);
    await this.events.countryFeatureChanged(country, featureKey);
  }
}
