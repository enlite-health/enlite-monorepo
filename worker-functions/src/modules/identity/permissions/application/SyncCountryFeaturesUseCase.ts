/**
 * Sincroniza o manifest de disponibilidade no BOOT: grava/atualiza o DEFAULT de
 * cada (país, chave) declarado em código, sem tocar em override do painel (a
 * função `iam.sync_country_feature_default` da 279 só atualiza linha
 * `source='default'`).
 *
 * NUNCA derruba o boot (mesma regra da lex C2 para o assert): um erro aqui é
 * log + métrica. O que perdemos com o sync falho é o default mais novo — o
 * `PermissionService` já cai no manifest em memória quando o banco não tem a
 * linha, então a tela continua correta.
 */

import { logger } from '@shared/logging';
import { assertValidFeatureConfig, assertValidFeatureKey } from '../domain/CountryFeature';
import type { CountryFeatureRepository } from './ports';
import {
  COUNTRY_FEATURES_MANIFEST,
  manifestEntries,
  type CountryFeatureManifest,
} from '../infrastructure/country-features.manifest';

export interface SyncCountryFeaturesResult {
  synced: number;
  failed: number;
}

export class SyncCountryFeaturesUseCase {
  constructor(
    private readonly features: CountryFeatureRepository,
    private readonly manifest: CountryFeatureManifest = COUNTRY_FEATURES_MANIFEST,
  ) {}

  async execute(): Promise<SyncCountryFeaturesResult> {
    let synced = 0;
    let failed = 0;
    for (const entry of manifestEntries(this.manifest)) {
      try {
        const featureKey = assertValidFeatureKey(entry.featureKey);
        const config = assertValidFeatureConfig(featureKey, entry.config);
        await this.features.syncDefault(entry.country, featureKey, entry.enabled, config);
        synced += 1;
      } catch (err) {
        failed += 1;
        logger.error(
          { err, country: entry.country, featureKey: entry.featureKey },
          '[perm] falha ao sincronizar default de disponibilidade — manifest em memória segue valendo',
        );
      }
    }
    logger.info({ synced, failed }, '[perm] sync do manifest de disponibilidade por país concluído');
    return { synced, failed };
  }
}
