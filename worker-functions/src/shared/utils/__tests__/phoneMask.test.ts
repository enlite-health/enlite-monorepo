import { maskPhone, maskPhoneForLog } from '../phoneMask';

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

// ── maskPhoneForLog — sem espaço, otimizado pra filtro exato no Cloud Logging ──
// Casos migrados do extinto `redactContact` (D-11/09, item 1 do gate): mesma
// GARANTIA (nunca o meio do número, só os 4 últimos dígitos), formato
// DIFERENTE (`+549******1243` em vez de `549***1243` — `redactContact` não
// tinha o `+` nem o tamanho variável do miolo).
describe('maskPhoneForLog', () => {
  it('mostra só prefixo (4 chars) + últimos 4 dígitos, nunca o miolo', () => {
    const out = maskPhoneForLog('+5491122334455');
    expect(out).toBe('+549******4455');
    expect(out).not.toContain('1122334455'); // miolo inteiro
    expect(out).not.toContain('112233');     // nem em pedaços
  });

  it('é determinístico — mesmo input, mesma saída (usável como filtro literal)', () => {
    const a = maskPhoneForLog('+5491122334455');
    const b = maskPhoneForLog('+5491122334455');
    expect(a).toBe(b);
  });

  it('nunca ecoa o valor inteiro mesmo pra número menor — telefone curto (<8 chars): "****" fixo', () => {
    // Diferença de comportamento MEDIDA e ACEITA na troca por `redactContact`
    // (item 1d do gate, 11/09): `redactContact('4455','phone')` ecoava
    // `***4455` (o valor INTEIRO, só prefixado) pra entradas de até 4 dígitos.
    // `maskPhoneForLog` não tem esse caso especial — abaixo de 8 chars vira
    // sempre o marcador fixo `****`, sem nenhum dígito visível.
    expect(maskPhoneForLog('4455')).toBe('****');
    expect(maskPhoneForLog('123')).toBe('****');
    expect(maskPhoneForLog('1234567')).toBe('****'); // 7 chars — ainda abaixo do piso
  });

  it('telefone só com caracteres não numéricos e curto: mesmo marcador fixo', () => {
    expect(maskPhoneForLog('+++---')).toBe('****');
  });

  it('vazio: marcador fixo', () => {
    expect(maskPhoneForLog('')).toBe('****');
  });

  it('exatamente 8 chars: já passa do piso e mascara com o miolo mínimo (1 asterisco)', () => {
    expect(maskPhoneForLog('12345678')).toBe('1234*5678');
  });
});
