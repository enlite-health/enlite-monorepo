import { normalizeSexValue } from '../normalizeSexValue';

describe('normalizeSexValue', () => {
  it.each(['male', 'MALE', 'Masculino', 'M', 'm', 'Hombre', 'HOMBRE', 'varón', 'Varon', 'VARON'])(
    'mapeia "%s" para MALE (canonical UPPERCASE)',
    (input) => {
      expect(normalizeSexValue(input)).toBe('MALE');
    },
  );

  it.each(['female', 'FEMALE', 'Femenino', 'Femenina', 'F', 'f', 'Mujer', 'MUJER'])(
    'mapeia "%s" para FEMALE (canonical UPPERCASE)',
    (input) => {
      expect(normalizeSexValue(input)).toBe('FEMALE');
    },
  );

  it.each(['Trans', 'No binario', 'Otro', 'BOTH', '', '   ', 'xyz'])(
    'retorna null para "%s" (fora do filtro binário)',
    (input) => {
      expect(normalizeSexValue(input)).toBeNull();
    },
  );

  it('retorna null para null/undefined', () => {
    expect(normalizeSexValue(null)).toBeNull();
    expect(normalizeSexValue(undefined)).toBeNull();
  });

  it('é estável (idempotente) na saída canônica', () => {
    expect(normalizeSexValue(normalizeSexValue('Mujer') ?? '')).toBe('FEMALE');
    expect(normalizeSexValue(normalizeSexValue('Hombre') ?? '')).toBe('MALE');
  });
});
