import { maskPhone } from '../phoneMask';

describe('maskPhone', () => {
  describe('Argentina — formato canônico +549 (13 dígitos)', () => {
    it('mascara número argentino completo em E.164', () => {
      expect(maskPhone('+5491155261243')).toBe('+54 9 11 ****-1243');
    });

    it('mascara número argentino sem o + E.164', () => {
      expect(maskPhone('5491155261243')).toBe('54 9 11 ****-1243');
    });

    it('expõe apenas os 4 últimos dígitos', () => {
      const masked = maskPhone('+5491155269999');
      expect(masked).toContain('9999');
      expect(masked).not.toContain('5261');
    });
  });

  describe('Argentina — formato interior +549 (12 dígitos)', () => {
    it('mascara número interior argentino (9 dígitos locais)', () => {
      // +549 + 3 dígitos área + 6 dígitos número = 12 total
      const masked = maskPhone('+549223456789');
      expect(masked).toContain('****');
      expect(masked).toContain('6789');
    });
  });

  describe('Brasil — +55 (13 dígitos)', () => {
    it('mascara número brasileiro em E.164', () => {
      expect(maskPhone('+5511998887766')).toBe('+55 11 ****-7766');
    });

    it('mascara número brasileiro sem +', () => {
      expect(maskPhone('5511998887766')).toBe('55 11 ****-7766');
    });
  });

  describe('fallback genérico', () => {
    it('mascara número genérico (prefixo 2 dígitos) com ****-últimos4', () => {
      const masked = maskPhone('+12125551234');
      expect(masked).toContain('****');
      expect(masked).toContain('1234');
    });
  });

  describe('casos edge', () => {
    it('retorna **** para string vazia', () => {
      expect(maskPhone('')).toBe('****');
    });

    it('retorna **** para número com menos de 7 dígitos', () => {
      expect(maskPhone('12345')).toBe('****');
    });

    it('ignora caracteres não-numéricos no input', () => {
      // +54 9 11 5526-1243 formatado com espaço e hífen
      const masked = maskPhone('+54 9 11 5526-1243');
      expect(masked).toContain('****');
      expect(masked).toContain('1243');
    });
  });
});
