import { splitFullName, countNameParts } from '../fullName';

describe('splitFullName', () => {
  it('quebra no primeiro espaço: primeiro token é o nome, o resto é sobrenome', () => {
    expect(splitFullName('Flavia Villagra')).toEqual({
      firstName: 'flavia',
      lastName: 'villagra',
    });
  });

  it('sobrenome composto fica inteiro no sobrenome (não se perde nada)', () => {
    expect(splitFullName('Gabriel García Márquez')).toEqual({
      firstName: 'gabriel',
      lastName: 'garcía márquez',
    });
    expect(splitFullName('María de los Ángeles Pérez')).toEqual({
      firstName: 'maría',
      lastName: 'de los ángeles pérez',
    });
  });

  it('nome de um termo só devolve sobrenome VAZIO — não inventa', () => {
    expect(splitFullName('Flavia')).toEqual({ firstName: 'flavia', lastName: '' });
  });

  it('espaço repetido e pontas soltas não viram sobrenome sujo', () => {
    expect(splitFullName('  Flavia   Villagra  ')).toEqual({
      firstName: 'flavia',
      lastName: 'villagra',
    });
  });

  it('entrada vazia, só espaço, null e undefined devolvem par vazio', () => {
    for (const entrada of ['', '   ', null, undefined]) {
      expect(splitFullName(entrada)).toEqual({ firstName: '', lastName: '' });
    }
  });
});

describe('normalização e contagem de termos', () => {
  it('grava em minúsculas: as três formas de digitar viram a MESMA linha', () => {
    const formas = ['FLAVIA VILLAGRA', 'Flavia Villagra', 'flAVia vILLagra'];
    const saidas = formas.map((f) => JSON.stringify(splitFullName(f)));
    expect(new Set(saidas).size).toBe(1);
    expect(splitFullName(formas[0])).toEqual({ firstName: 'flavia', lastName: 'villagra' });
  });

  it('acento sobrevive à normalização (minúscula não é remover acento)', () => {
    expect(splitFullName('JOAQUÍN BENÍTEZ')).toEqual({
      firstName: 'joaquín',
      lastName: 'benítez',
    });
  });

  it('countNameParts conta termos, ignorando espaço repetido e pontas', () => {
    expect(countNameParts('Flavia')).toBe(1);
    expect(countNameParts('  Flavia   Villagra ')).toBe(2);
    expect(countNameParts('María de los Ángeles Pérez')).toBe(5);
    expect(countNameParts('   ')).toBe(0);
    expect(countNameParts(null)).toBe(0);
  });
});
