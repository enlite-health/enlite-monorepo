/**
 * FONTE ÚNICA das jurisdições (D108, BLOCKER-6).
 *
 * O teste que importa aqui não é o do guard — é o de IDENTIDADE: as listas que
 * a borda usa (`ADMISSION_COUNTRY_CODES`, `isAdmissionCountry`) e a que o
 * contexto de banco usa (`COUNTRY_CODES` de `requestDbSession`) têm de ser o
 * MESMO objeto/função, não duas listas com o mesmo conteúdo. Igualdade de
 * conteúdo passaria mesmo depois de alguém adicionar 'US' em um lugar só.
 */

import { COUNTRY_CODES, isCountryCode, type CountryCode } from '../countryCodes';
import {
  ADMISSION_COUNTRY_CODES,
  isAdmissionCountry,
} from '@modules/matching/domain/admissionCountries';
import {
  COUNTRY_CODES as DB_COUNTRY_CODES,
  isCountryCode as dbIsCountryCode,
} from '@shared/database/requestDbSession';

describe('countryCodes — fonte única', () => {
  it('a lista canônica é AR + BR (espelha o CHECK do banco)', () => {
    expect(COUNTRY_CODES).toEqual(['AR', 'BR']);
  });

  it('admissionCountries DERIVA daqui (mesma referência, não uma cópia)', () => {
    expect(ADMISSION_COUNTRY_CODES).toBe(COUNTRY_CODES);
  });

  it('requestDbSession RE-EXPORTA daqui (mesma referência)', () => {
    expect(DB_COUNTRY_CODES).toBe(COUNTRY_CODES);
    expect(dbIsCountryCode).toBe(isCountryCode);
  });

  it('o guard da borda de admissão é o mesmo julgamento do guard do banco', () => {
    for (const value of ['AR', 'BR', 'ar', 'US', '', null, undefined, 42, {}]) {
      expect(isAdmissionCountry(value)).toBe(isCountryCode(value));
    }
  });

  it('isCountryCode só aceita os códigos exatos', () => {
    expect(isCountryCode('AR')).toBe(true);
    expect(isCountryCode('BR')).toBe(true);
    expect(isCountryCode('ar')).toBe(false);
    expect(isCountryCode('BRA')).toBe(false);
    expect(isCountryCode('')).toBe(false);
    expect(isCountryCode(undefined)).toBe(false);
    expect(isCountryCode(null)).toBe(false);
    expect(isCountryCode(['AR'])).toBe(false);
  });

  it('estreita o tipo (o guard serve para o compilador, não só em runtime)', () => {
    const value: unknown = 'BR';
    if (isCountryCode(value)) {
      const narrowed: CountryCode = value;
      expect(narrowed).toBe('BR');
    } else {
      throw new Error('guard deveria ter aceitado BR');
    }
  });
});
