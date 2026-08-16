/**
 * src/modules/identity/permissions/domain/CountryFeature.ts
 *
 * DISPONIBILIDADE por país (D115, conceito (c)): o que EXISTE em cada
 * jurisdição — uma tela, as opções de um select, um componente. É configuração
 * de PRODUTO, ortogonal a permissão ("quem pode") e a escopo de país do grupo
 * ("onde vê dado"). Render = existe no país **e** tem permissão; indisponível é
 * indistinguível de inexistente (404), sem permissão é negado com motivo
 * (spec country-feature-availability).
 *
 * O default nasce no manifest em código; o painel sobrescreve com motivo.
 *
 * (lex C10) `config` é validado por JSON schema POR TIPO. Sem isso, o campo
 * jsonb livre de uma tabela de retenção longa vira o lugar onde alguém cola uma
 * lista de nomes "só para testar" — e a tabela existe justamente por não guardar
 * dado de titular.
 */

import { z } from 'zod';
import { PermissionError } from './PermissionError';

export const FEATURE_TYPES = ['screen', 'options', 'component'] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

/** Mesmo CHECK da mig 277 — as duas pontas recusam a mesma coisa. */
const FEATURE_KEY = /^(screen|options|component):[a-z0-9][a-z0-9._-]*$/;

export interface CountryFeature {
  country: string;
  featureKey: string;
  enabled: boolean;
  config: unknown;
  /** `default` = manifest em código; `override` = painel (mig 277). */
  source: 'default' | 'override';
  reason: string | null;
  updatedBy: string;
  updatedAt: Date;
}

export function isValidFeatureKey(key: string): boolean {
  return FEATURE_KEY.test(key);
}

export function assertValidFeatureKey(key: string): string {
  if (typeof key !== 'string' || !isValidFeatureKey(key)) {
    throw new PermissionError(
      'invalid_feature_key',
      `Chave de feature inválida: ${String(key)} (esperado screen:|options:|component:<slug>)`,
    );
  }
  return key;
}

export function featureTypeOf(key: string): FeatureType {
  return assertValidFeatureKey(key).split(':')[0] as FeatureType;
}

/** Uma tela não configura nada além de existir. */
const SCREEN_CONFIG = z.null();

/**
 * Um select carrega A LISTA daquele país. `value` é chave de sistema (o rótulo
 * vem do i18n) — por isso o formato restrito: nada de texto livre, que é por
 * onde dado de pessoa entraria.
 *
 * `null` é válido e significa "a lista não mora aqui": há selects cujo conteúdo
 * vem do cadastro do país ou do i18n (`options:regions` são as províncias
 * traduzidas), e para eles a feature só liga/desliga o campo. Exigir `values`
 * ali obrigaria a duplicar no manifest uma lista que já tem dono — e duas
 * listas iguais divergem (a lição do `countryCodes`).
 */
const OPTIONS_CONFIG = z
  .object({
    values: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
      .min(1)
      .max(200),
  })
  .nullable();

/** Componente pode ter variante nomeada; nada mais. */
const COMPONENT_CONFIG = z.object({ variant: z.string().max(64) }).nullable();

const CONFIG_SCHEMA: Record<FeatureType, z.ZodTypeAny> = {
  screen: SCREEN_CONFIG,
  options: OPTIONS_CONFIG,
  component: COMPONENT_CONFIG,
};

/**
 * Valida `config` contra o schema do TIPO da chave. `undefined` é normalizado
 * para `null` (a coluna é nullable) antes de validar.
 */
export function assertValidFeatureConfig(key: string, config: unknown): unknown {
  const type = featureTypeOf(key);
  const normalized = config === undefined ? null : config;
  const parsed = CONFIG_SCHEMA[type].safeParse(normalized);
  if (!parsed.success) {
    throw new PermissionError(
      'invalid_feature_config',
      `Config inválida para ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

/** Opções daquele país, ou `[]` quando a feature não é do tipo `options:`. */
export function optionValues(feature: Pick<CountryFeature, 'featureKey' | 'config'>): string[] {
  if (!isValidFeatureKey(feature.featureKey) || featureTypeOf(feature.featureKey) !== 'options') return [];
  const parsed = OPTIONS_CONFIG.safeParse(feature.config);
  return parsed.success ? (parsed.data?.values ?? []) : [];
}
