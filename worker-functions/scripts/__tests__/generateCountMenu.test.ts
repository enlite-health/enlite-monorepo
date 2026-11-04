/**
 * T103 (change 085): count-menu.json = o que o módulo dono do cardápio produz AGORA.
 * Falha se o JSON commitado divergir do gerado.
 */
import fs from 'fs';
import { gerarCountMenu, COUNT_MENU_PATH } from '../generateCountMenu';
import { CANONICAL_PROVINCES, normalizeProvince } from '../../src/shared/utils/argentinaLocationNormalizer';
import { UNRESOLVED_ZONE_LABEL } from '../../src/shared/utils/zoneKey';

describe('count-menu.json (cardápio de contagem da Maria)', () => {
  it('é idêntico ao que o módulo dono gera agora', () => {
    expect(fs.readFileSync(COUNT_MENU_PATH, 'utf8')).toBe(gerarCountMenu());
  });

  it('tem as três entidades com os campos do spec §4', () => {
    const menu = JSON.parse(fs.readFileSync(COUNT_MENU_PATH, 'utf8')) as Record<string, { fields: object }>;
    expect(Object.keys(menu.workers.fields)).toEqual(['apto', 'has_phone', 'registration', 'zone']);
    expect(Object.keys(menu.patients.fields)).toEqual(['has_provider', 'incomplete_registration', 'stage']);
    expect(Object.keys(menu.vacancies.fields)).toEqual(['has_applicant', 'status', 'zone']);
  });

  it('cada província do cardápio é ponto fixo do normalizador dono', () => {
    for (const p of CANONICAL_PROVINCES) expect(normalizeProvince(p)).toBe(p);
  });

  it('zone.values = exatamente as províncias do dono + o rótulo sem zona (workers e vacancies)', () => {
    const menu = JSON.parse(fs.readFileSync(COUNT_MENU_PATH, 'utf8')) as Record<
      string,
      { fields: { zone: { values: string[] } } }
    >;
    const esperado = [...CANONICAL_PROVINCES, UNRESOLVED_ZONE_LABEL];
    expect(CANONICAL_PROVINCES).toHaveLength(24);
    expect(menu.workers.fields.zone.values).toEqual(esperado);
    expect(menu.vacancies.fields.zone.values).toEqual(esperado);
  });
});
