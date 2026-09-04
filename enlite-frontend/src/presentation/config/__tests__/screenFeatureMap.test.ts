import { describe, it, expect } from 'vitest';
import fixture from '../../../test/fixtures/feature-catalog.json';
import { SCREEN_FEATURE_MAP } from '../screenFeatureMap';

const CHAVES_SCREEN = fixture.keys.filter((k) => k.startsWith('screen:'));

describe('SCREEN_FEATURE_MAP — as 8 chaves screen:* do manifest (B2/D268)', () => {
  it('a fixture tem exatamente as 8 chaves screen:* esperadas', () => {
    expect(CHAVES_SCREEN).toEqual([
      'screen:access-permissions',
      'screen:ana-care',
      'screen:funnel',
      'screen:management-dashboard',
      'screen:patients',
      'screen:talentum',
      'screen:vacancies',
      'screen:workers',
    ]);
  });

  it.each(CHAVES_SCREEN)('%s tem entrada no mapa', (chave) => {
    expect(SCREEN_FEATURE_MAP[chave]).toBeDefined();
  });

  it('toda entrada do mapa tem `routes` (array, mesmo que vazio) — nunca ausente', () => {
    for (const [chave, entrada] of Object.entries(SCREEN_FEATURE_MAP)) {
      expect(Array.isArray(entrada.routes), `${chave} sem routes[]`).toBe(true);
    }
  });

  it('screen:ana-care não tem rota nem item — `semConsumidorHoje` explícito, routes vazio', () => {
    const anaCare = SCREEN_FEATURE_MAP['screen:ana-care'];
    expect(anaCare.routes).toEqual([]);
    expect(anaCare.navHref).toBeUndefined();
    expect(anaCare.semConsumidorHoje).toBeTruthy();
  });

  it('screen:talentum não tem item de menu de topo (rota aninhada), mas tem rota', () => {
    const talentum = SCREEN_FEATURE_MAP['screen:talentum'];
    expect(talentum.navHref).toBeUndefined();
    expect(talentum.routes.length).toBeGreaterThan(0);
  });

  it('as demais 6 chaves com tela hoje têm navHref e ao menos 1 rota', () => {
    const comTela = CHAVES_SCREEN.filter((k) => k !== 'screen:ana-care' && k !== 'screen:talentum');
    for (const chave of comTela) {
      const entrada = SCREEN_FEATURE_MAP[chave];
      expect(entrada.navHref, `${chave} sem navHref`).toBeTruthy();
      expect(entrada.routes.length, `${chave} sem routes`).toBeGreaterThan(0);
    }
  });

  it('o mapa não tem chave a mais que não exista na fixture (evita lixo/typo)', () => {
    for (const chave of Object.keys(SCREEN_FEATURE_MAP)) {
      expect(fixture.keys, `${chave} não existe no manifest`).toContain(chave);
    }
  });
});
