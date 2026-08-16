import {
  COUNTRY_FEATURES_MANIFEST,
  manifestDefault,
  manifestEntries,
  undecidedFeatures,
  type CountryFeatureManifest,
} from '../country-features.manifest';
import { assertValidFeatureConfig, assertValidFeatureKey } from '../../domain/CountryFeature';

describe('manifest de disponibilidade por país', () => {
  it('toda chave e toda config do manifest passam pela validação do domínio', () => {
    for (const entry of manifestEntries()) {
      expect(() => assertValidFeatureConfig(assertValidFeatureKey(entry.featureKey), entry.config)).not.toThrow();
    }
  });

  it('entrada `null` (decisão pendente) NÃO vira linha — nada é herdado do outro país', () => {
    const pendentes = undecidedFeatures('BR');
    expect(pendentes).toContain('component:account-link');
    expect(manifestEntries().some((e) => e.country === 'BR' && e.featureKey === 'component:account-link')).toBe(false);
    expect(manifestEntries().some((e) => e.country === 'AR' && e.featureKey === 'component:account-link')).toBe(true);
  });

  it('Talentum e Ana Care existem só na Argentina (inventário 0.7)', () => {
    expect(manifestDefault('AR', 'screen:talentum')?.enabled).toBe(true);
    expect(manifestDefault('BR', 'screen:talentum')?.enabled).toBe(false);
    expect(manifestDefault('BR', 'screen:ana-care')?.enabled).toBe(false);
  });

  it('documentos têm listas DIFERENTES por país', () => {
    expect(manifestDefault('AR', 'options:document-types')?.config).toEqual({
      values: ['DNI', 'CUIL', 'CV', 'ANALITICO', 'CERTIFICADO'],
    });
    expect(manifestDefault('BR', 'options:document-types')?.config).toEqual({ values: ['CPF', 'RG', 'CV'] });
  });

  it('chave desconhecida devolve null (não inventa default)', () => {
    expect(manifestDefault('AR', 'screen:nao-existe')).toBeNull();
  });

  it('config ausente vira null na linha do sync', () => {
    const manifest: CountryFeatureManifest = { 'screen:x': { AR: { enabled: true } } };
    expect(manifestEntries(manifest)).toEqual([
      { country: 'AR', featureKey: 'screen:x', enabled: true, config: null },
    ]);
    expect(undecidedFeatures('BR', manifest)).toEqual(['screen:x']);
  });

  it('nenhuma feature do manifest está fora do vocabulário de chaves', () => {
    for (const key of Object.keys(COUNTRY_FEATURES_MANIFEST)) {
      expect(() => assertValidFeatureKey(key)).not.toThrow();
    }
  });
});
