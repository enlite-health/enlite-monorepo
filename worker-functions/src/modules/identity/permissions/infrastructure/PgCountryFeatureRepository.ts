/**
 * src/modules/identity/permissions/infrastructure/PgCountryFeatureRepository.ts
 *
 * Disponibilidade por país (`iam.country_features`, mig 277). Leitura direta;
 * escrita pelas duas funções da 279, que existem separadas de propósito:
 *
 *   · `set_country_feature`  — OVERRIDE do painel: exige gestor e motivo;
 *   · `sync_country_feature_default` — DEFAULT do manifest no boot: exige
 *     contexto de sistema e NÃO sobrescreve override (a decisão do operador
 *     ganha do default do código, sempre).
 */

import type { Pool } from 'pg';
import type { CountryCode } from '@shared/domain/countryCodes';
import type { CountryFeatureRepository } from '../application/ports';
import type { CountryFeature } from '../domain/CountryFeature';
import { readRows, withStaffWrite, withSystemWrite } from './dbAccess';

const SYSTEM_LABEL = 'boot:country-features-sync';

interface FeatureRow {
  country: string;
  feature_key: string;
  enabled: boolean;
  config: unknown;
  source: 'default' | 'override';
  reason: string | null;
  updated_by: string;
  updated_at: Date;
}

export class PgCountryFeatureRepository implements CountryFeatureRepository {
  constructor(
    private readonly pool: Pool,
    private readonly systemPool: Pool,
  ) {}

  async list(): Promise<CountryFeature[]> {
    const result = await readRows(() =>
      this.pool.query<FeatureRow>(
        `SELECT country, feature_key, enabled, config, source, reason, updated_by, updated_at
           FROM iam.country_features
          ORDER BY country, feature_key`,
      ),
    );
    return result.rows.map((row) => ({
      country: row.country,
      featureKey: row.feature_key,
      enabled: row.enabled,
      config: row.config,
      source: row.source,
      reason: row.reason,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    }));
  }

  async setOverride(
    country: CountryCode,
    featureKey: string,
    enabled: boolean,
    config: unknown,
    reason: string,
  ): Promise<void> {
    await withStaffWrite(this.pool, (client) =>
      client.query(`SELECT iam.set_country_feature($1, $2, $3, $4::jsonb, $5)`, [
        country,
        featureKey,
        enabled,
        config === null || config === undefined ? null : JSON.stringify(config),
        reason,
      ]),
    );
  }

  async syncDefault(
    country: CountryCode,
    featureKey: string,
    enabled: boolean,
    config: unknown,
  ): Promise<void> {
    await withSystemWrite(this.systemPool, SYSTEM_LABEL, (client) =>
      client.query(`SELECT iam.sync_country_feature_default($1, $2, $3, $4::jsonb)`, [
        country,
        featureKey,
        enabled,
        config === null || config === undefined ? null : JSON.stringify(config),
      ]),
    );
  }
}
