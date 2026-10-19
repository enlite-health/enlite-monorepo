import { NameNotCodifiableError, deriveProviderCode } from '../deriveProviderCode';

describe('deriveProviderCode', () => {
  it('tira acento, põe em caixa alta e junta separadores: "Osde  -  Plus" -> OSDE_PLUS; "Prevención Salud" -> PREVENCION_SALUD', () => {
    expect(deriveProviderCode('Osde  -  Plus')).toBe('OSDE_PLUS');
    expect(deriveProviderCode('Prevención Salud')).toBe('PREVENCION_SALUD');
    expect(deriveProviderCode("O'Gorman")).toBe('O_GORMAN');
  });

  it('o `_` das pontas sai: "  Osde  -  Plus!  " -> OSDE_PLUS (trim)', () => {
    expect(deriveProviderCode('  Osde  -  Plus!  ')).toBe('OSDE_PLUS');
    expect(deriveProviderCode('(Galeno)')).toBe('GALENO');
  });

  it('dígito inicial ganha o prefixo P_ (o CHECK exige letra na frente): "3 Prov" -> P_3_PROV', () => {
    expect(deriveProviderCode('3 Prov')).toBe('P_3_PROV');
    expect(deriveProviderCode('OSDE 210')).toBe('OSDE_210');
  });

  it('só símbolos ou vazio -> NameNotCodifiableError (NAME_NOT_CODIFIABLE)', () => {
    for (const n of ['', '   ', '---', '¿?!', '日本']) {
      const e = (() => { try { deriveProviderCode(n); } catch (x) { return x; } return null; })();
      expect(e).toBeInstanceOf(NameNotCodifiableError);
      expect((e as NameNotCodifiableError).code).toBe('NAME_NOT_CODIFIABLE');
    }
  });

  it('todo resultado satisfaz o CHECK da 311 (^[A-Z][A-Z0-9_]*$) e é estável (mesma entrada, mesmo código)', () => {
    for (const n of ['Swiss Medical', 'ñandú 2000', 'a.b.c']) {
      const c = deriveProviderCode(n);
      expect(c).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(deriveProviderCode(n)).toBe(c);
    }
  });
});
