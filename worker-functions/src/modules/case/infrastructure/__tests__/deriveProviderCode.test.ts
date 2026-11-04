import { providerCodeParamSchema } from '../../interfaces/validators/insuranceProviderSchemas';
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

  it('nome longo (78 caracteres da QA): o código cabe em 64, termina em palavra inteira e a rota :code o aceita', () => {
    const nome = 'Obra Social del Personal de Edificios de Renta y Horizontal de Capital Federal';
    expect(nome).toHaveLength(78);
    const c = deriveProviderCode(nome);
    expect(c.length).toBeLessThanOrEqual(64);
    expect(c).not.toMatch(/_$/);
    expect(nome.toUpperCase().replace(/ /g, '_').startsWith(c)).toBe(true);
    expect(providerCodeParamSchema.safeParse({ code: c }).success).toBe(true);
  });

  it('com prefixo P_ e uma palavra só maior que o teto: continua <= 64', () => {
    expect(deriveProviderCode(`1${'A'.repeat(80)}`).length).toBe(64);
    expect(deriveProviderCode(`${'B'.repeat(70)} x`)).toMatch(/^B{64}$/);
  });
});
