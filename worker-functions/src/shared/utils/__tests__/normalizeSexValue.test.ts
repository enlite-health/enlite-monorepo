import { normalizeSexValue } from '../normalizeSexValue';

describe('normalizeSexValue', () => {
  it.each(['male', 'MALE', 'Masculino', 'M', 'm', 'Hombre', 'HOMBRE', 'varón', 'Varon', 'VARON'])(
    'mapeia "%s" para male',
    (input) => {
      expect(normalizeSexValue(input)).toBe('male');
    },
  );

  it.each(['female', 'FEMALE', 'Femenino', 'Femenina', 'F', 'f', 'Mujer', 'MUJER'])(
    'mapeia "%s" para female',
    (input) => {
      expect(normalizeSexValue(input)).toBe('female');
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
    expect(normalizeSexValue(normalizeSexValue('Mujer') ?? '')).toBe('female');
    expect(normalizeSexValue(normalizeSexValue('Hombre') ?? '')).toBe('male');
  });
});
