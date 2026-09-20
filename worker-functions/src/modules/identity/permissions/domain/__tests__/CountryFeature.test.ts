import {
  assertValidFeatureConfig,
  assertValidFeatureKey,
  featureTypeOf,
  isValidFeatureKey,
  optionValues,
} from '../CountryFeature';
import type { PermissionError } from '../PermissionError';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as PermissionError).code;
  }
  return 'não lançou';
}

describe('chave de feature — mesmo formato do CHECK da mig 277', () => {
  it.each(['screen:talentum', 'options:document-types', 'component:kanban.encuadre'])(
    'aceita %s',
    (key) => {
      expect(isValidFeatureKey(key)).toBe(true);
      expect(assertValidFeatureKey(key)).toBe(key);
    },
  );

  it.each(['tela:x', 'screen:', 'screen:Maiuscula', 'screen:-comeca-com-hifen', 'sem-prefixo'])(
    'rejeita %s',
    (key) => {
      expect(isValidFeatureKey(key)).toBe(false);
      expect(codeOf(() => assertValidFeatureKey(key))).toBe('invalid_feature_key');
    },
  );

  it('extrai o tipo da chave', () => {
    expect(featureTypeOf('screen:x')).toBe('screen');
    expect(featureTypeOf('options:x')).toBe('options');
    expect(featureTypeOf('component:x')).toBe('component');
  });
});

describe('config validada por schema do TIPO (lex C10)', () => {
  it('screen não configura nada', () => {
    expect(assertValidFeatureConfig('screen:x', null)).toBeNull();
    expect(assertValidFeatureConfig('screen:x', undefined)).toBeNull();
    expect(codeOf(() => assertValidFeatureConfig('screen:x', { values: ['A'] }))).toBe('invalid_feature_config');
  });

  it('options exige lista de chaves de sistema — texto livre é recusado', () => {
    expect(assertValidFeatureConfig('options:document-types', { values: ['DNI', 'CUIL'] })).toEqual({
      values: ['DNI', 'CUIL'],
    });
    // null = "a lista mora no cadastro/i18n do país" (ex.: options:regions)
    expect(assertValidFeatureConfig('options:regions', null)).toBeNull();
    expect(codeOf(() => assertValidFeatureConfig('options:x', { values: [] }))).toBe('invalid_feature_config');
    // é por aqui que dado de pessoa entraria num jsonb livre
    expect(codeOf(() => assertValidFeatureConfig('options:x', { values: ['Ana Maria, DNI 20345678'] }))).toBe(
      'invalid_feature_config',
    );
  });

  it('component aceita variante nomeada ou nada', () => {
    expect(assertValidFeatureConfig('component:x', null)).toBeNull();
    expect(assertValidFeatureConfig('component:x', { variant: 'compact' })).toEqual({ variant: 'compact' });
    expect(codeOf(() => assertValidFeatureConfig('component:x', { variant: 'x'.repeat(65) }))).toBe(
      'invalid_feature_config',
    );
  });

  it('chave inválida falha antes do schema', () => {
    expect(codeOf(() => assertValidFeatureConfig('tela:x', null))).toBe('invalid_feature_key');
  });
});

describe('optionValues', () => {
  it('devolve a lista do país e [] para o que não é options válido', () => {
    expect(optionValues({ featureKey: 'options:doc', config: { values: ['CPF', 'RG'] } })).toEqual(['CPF', 'RG']);
    expect(optionValues({ featureKey: 'screen:x', config: { values: ['CPF'] } })).toEqual([]);
    expect(optionValues({ featureKey: 'options:doc', config: null })).toEqual([]);
    // config fora do formato (texto livre) não vira lista de opções
    expect(optionValues({ featureKey: 'options:doc', config: { values: ['Ana Maria, DNI 20345678'] } })).toEqual([]);
    expect(optionValues({ featureKey: 'tela:x', config: null })).toEqual([]);
  });
});
