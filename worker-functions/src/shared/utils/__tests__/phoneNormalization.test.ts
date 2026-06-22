import { normalizePhoneAR, generatePhoneCandidates } from '../phoneNormalization';

// ─── normalizePhoneAR ─────────────────────────────────────────────────────────

describe('normalizePhoneAR', () => {
  describe('entradas nulas ou vazias', () => {
    it('retorna "" para null', () => {
      expect(normalizePhoneAR(null)).toBe('');
    });

    it('retorna "" para undefined', () => {
      expect(normalizePhoneAR(undefined)).toBe('');
    });

    it('retorna "" para string vazia', () => {
      expect(normalizePhoneAR('')).toBe('');
    });

    it('retorna "" para string só com formatação (sem dígitos)', () => {
      expect(normalizePhoneAR('+ - ()')).toBe('');
    });
  });

  describe('10 dígitos (local Buenos Aires, sem prefixo)', () => {
    it('prepend 549 em número de 10 dígitos', () => {
      expect(normalizePhoneAR('1151265663')).toBe('5491151265663');
    });

    it('remove formatação antes de normalizar', () => {
      expect(normalizePhoneAR('11 5126-5663')).toBe('5491151265663');
    });
  });

  describe('11 dígitos começando com 54 (sem o 9 do móvel)', () => {
    it('insere 9 depois de 54 em número de 11 dígitos', () => {
      expect(normalizePhoneAR('54111265663')).toBe('549111265663');
    });
  });

  describe('12 dígitos começando com 54 mas não 549', () => {
    it('converte 541151265663 → 5491151265663', () => {
      expect(normalizePhoneAR('541151265663')).toBe('5491151265663');
    });
  });

  describe('13 dígitos começando com 549 (já canônico)', () => {
    it('retorna sem alteração o número já canônico', () => {
      expect(normalizePhoneAR('5491151265663')).toBe('5491151265663');
    });

    it('remove + do E.164 antes de verificar', () => {
      expect(normalizePhoneAR('+5491151265663')).toBe('5491151265663');
    });
  });

  describe('comprimentos incomuns (fallback sem conversão)', () => {
    it('retorna dígitos brutos para 8 dígitos', () => {
      expect(normalizePhoneAR('12345678')).toBe('12345678');
    });

    it('retorna dígitos brutos para 9 dígitos', () => {
      expect(normalizePhoneAR('123456789')).toBe('123456789');
    });

    it('retorna dígitos brutos para 14 dígitos', () => {
      expect(normalizePhoneAR('55119988877665')).toBe('55119988877665');
    });
  });

  describe('unicidade semântica — mesmo número em formatos diferentes normaliza igual', () => {
    const phoneVariants = [
      '1151265663',        // 10 dígitos
      '541151265663',      // 12 dígitos sem 9
      '5491151265663',     // 13 dígitos canônico
      '+5491151265663',    // E.164
      '54 9 11 5126-5663', // formatado
    ];

    it.each(phoneVariants)(
      'normalizePhoneAR("%s") → "5491151265663"',
      (variant) => {
        expect(normalizePhoneAR(variant)).toBe('5491151265663');
      }
    );
  });
});

// ─── generatePhoneCandidates ──────────────────────────────────────────────────

describe('generatePhoneCandidates', () => {
  it('retorna array vazio para string vazia', () => {
    expect(generatePhoneCandidates('')).toEqual([]);
  });

  it('inclui o canônico e variantes para um número de 10 dígitos', () => {
    const candidates = generatePhoneCandidates('1151265663');
    expect(candidates).toContain('5491151265663'); // canônico
    expect(candidates).toContain('1151265663');    // dígitos originais
  });

  it('inclui versões com e sem + para candidatos com ≥7 dígitos', () => {
    const candidates = generatePhoneCandidates('5491155261243');
    const hasPlus = candidates.some(c => c.startsWith('+'));
    const hasNoPlus = candidates.some(c => !c.startsWith('+') && c.length > 5);
    expect(hasPlus).toBe(true);
    expect(hasNoPlus).toBe(true);
  });

  it('retorna candidatos únicos (sem duplicatas)', () => {
    const candidates = generatePhoneCandidates('5491155261243');
    const withoutPlus = candidates.filter(c => !c.startsWith('+'));
    const unique = new Set(withoutPlus);
    expect(unique.size).toBe(withoutPlus.length);
  });

  it('filtra candidatos com menos de 7 dígitos', () => {
    // número inválido curto
    const candidates = generatePhoneCandidates('12345');
    expect(candidates.every(c => c.replace('+', '').length >= 7)).toBe(true);
  });
});
