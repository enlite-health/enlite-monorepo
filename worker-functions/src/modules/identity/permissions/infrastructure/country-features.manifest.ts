/**
 * src/modules/identity/permissions/infrastructure/country-features.manifest.ts
 *
 * O QUE EXISTE em cada país, declarado UMA VEZ em código (spec
 * country-feature-availability: "feature nova nasce no manifest, não em lista à
 * mão"). O boot sincroniza isto para `iam.country_features` como `source
 * = 'default'`; o painel pode sobrescrever, e o override NUNCA é apagado por um
 * sync posterior.
 *
 * Origem dos valores: inventário da task 0.7 (`country-features-inventory.md`,
 * 70 itens) + decisões da D116:
 *   · moeda: fora do v1 (não existe ARS/BRL no código) — nem chave aqui;
 *   · cobertura/obra social: vira cadastro por país em change própria — a chave
 *     `options:coverage-type` fica RESERVADA, desabilitada nos dois países;
 *   · tipos de documento: as 3 listas divergentes serão unificadas em
 *     `options:document-types` (por país) — a auditoria "documento suportado de
 *     verdade" é a task 0.7d, então o BR nasce com a lista mínima provada;
 *   · encuadre/funil: vale nos dois países por enquanto (nomes mudam via i18n).
 *
 * `BR: null` significa **decisão pendente** (os ~25 `??` do inventário): o
 * painel mostra a feature como indisponível no BR E sinaliza que ninguém
 * decidiu — diferente de um `false` decidido. Nunca se herda AR silenciosamente:
 * herdar é como uma tela argentina apareceria no Brasil sem ninguém aprovar.
 */

import type { CountryCode } from '@shared/domain/countryCodes';

export interface FeatureDefault {
  enabled: boolean;
  config?: unknown;
}

/** `null` = ainda não decidido para aquele país (some da tela, aparece na lista de pendências). */
export type FeatureManifestEntry = Partial<Record<CountryCode, FeatureDefault | null>>;

export type CountryFeatureManifest = Readonly<Record<string, FeatureManifestEntry>>;

export const COUNTRY_FEATURES_MANIFEST: CountryFeatureManifest = {
  // ── Telas ────────────────────────────────────────────────────────────────
  'screen:workers': { AR: { enabled: true }, BR: { enabled: true } },
  'screen:vacancies': { AR: { enabled: true }, BR: { enabled: true } },
  'screen:funnel': { AR: { enabled: true }, BR: { enabled: true } },
  'screen:patients': { AR: { enabled: true }, BR: { enabled: true } },
  'screen:management-dashboard': { AR: { enabled: true }, BR: { enabled: true } },
  'screen:access-permissions': { AR: { enabled: true }, BR: { enabled: true } },
  /** Talentum é integração argentina — não existe no Brasil (inventário 0.7). */
  'screen:talentum': { AR: { enabled: true }, BR: { enabled: false } },
  /** Ana Care hoje só opera na Argentina. */
  'screen:ana-care': { AR: { enabled: true }, BR: { enabled: false } },

  // ── Opções de select ─────────────────────────────────────────────────────
  /**
   * Documentos aceitos por país. A lista do BR fica na mínima até a auditoria
   * 0.7d provar upload+validação+máscara de cada tipo — listar o que não
   * funciona é pior que não listar: o cadastro trava sem explicação.
   */
  'options:document-types': {
    AR: { enabled: true, config: { values: ['DNI', 'CUIL', 'CV', 'ANALITICO', 'CERTIFICADO'] } },
    BR: { enabled: true, config: { values: ['CPF', 'RG', 'CV'] } },
  },
  /** Províncias/estados: a lista vem do cadastro do país (i18n), não daqui. */
  'options:regions': { AR: { enabled: true }, BR: { enabled: true } },
  /** RESERVADA (D116): cobertura/obra social vira cadastro em change própria. */
  'options:coverage-type': { AR: { enabled: false }, BR: { enabled: false } },

  // ── Componentes ──────────────────────────────────────────────────────────
  'component:kanban.encuadre': { AR: { enabled: true }, BR: { enabled: true } },
  'component:worker.talentum-sync': { AR: { enabled: true }, BR: { enabled: false } },
  /** Vínculo de conta por SMS (D86) — decisão de BR pendente. */
  'component:account-link': { AR: { enabled: true }, BR: null },
};

/** Uma linha por (país, chave) DECIDIDA — a entrada do sync de boot. */
export function manifestEntries(
  manifest: CountryFeatureManifest = COUNTRY_FEATURES_MANIFEST,
): Array<{ country: CountryCode; featureKey: string; enabled: boolean; config: unknown }> {
  const rows: Array<{ country: CountryCode; featureKey: string; enabled: boolean; config: unknown }> = [];
  for (const [featureKey, byCountry] of Object.entries(manifest)) {
    for (const [country, value] of Object.entries(byCountry)) {
      if (!value) continue; // `null`/ausente = pendente: não vira linha
      rows.push({
        country: country as CountryCode,
        featureKey,
        enabled: value.enabled,
        config: value.config ?? null,
      });
    }
  }
  return rows;
}

/** Chaves sem decisão para um país — o que o painel lista como pendente. */
export function undecidedFeatures(
  country: CountryCode,
  manifest: CountryFeatureManifest = COUNTRY_FEATURES_MANIFEST,
): string[] {
  return Object.entries(manifest)
    .filter(([, byCountry]) => !byCountry[country])
    .map(([featureKey]) => featureKey);
}

/** Default do código para (país, chave) — o fallback quando o banco não tem linha. */
export function manifestDefault(
  country: CountryCode,
  featureKey: string,
  manifest: CountryFeatureManifest = COUNTRY_FEATURES_MANIFEST,
): FeatureDefault | null {
  return manifest[featureKey]?.[country] ?? null;
}
