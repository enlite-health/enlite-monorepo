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
// Trabalha por DÍGITO (não por posição de caractere) desde o fix do achado do
// gate 11/09 (608 ocorrências/7d em prd): a versão por posição mascarava MENOS
// quanto mais a entrada se afastava de E.164 — `maskPhoneForLog('1151265663')`
// dava `1151**5663` (8 de 10 dígitos expostos). Ver ProcessTalentumPrescreening,
// que recebe `phoneNumber` cru do webhook Talentum sem formato garantido.
//
// Regra de prova, pra CADA caso da tabela abaixo: nenhuma sequência de 5+
// dígitos consecutivos do original aparece na saída, e os 4 últimos dígitos
// aparecem (exceto no piso `****`, onde nenhum dígito aparece).
describe('maskPhoneForLog', () => {
  /** Nenhuma janela de `n` dígitos consecutivos do `original` aparece em `masked`. */
  function assertNoDigitRunLeaks(original: string, masked: string, n = 5): void {
    const digits = original.replace(/\D/g, '');
    for (let i = 0; i + n <= digits.length; i++) {
      expect(masked).not.toContain(digits.slice(i, i + n));
    }
  }

  describe.each([
    // [rótulo, entrada, saída esperada]
    ['E.164 com +', '+5491151265663', '+549******5663'],
    ['E.164 sem +', '5491151265663', '+549******5663'],
    ['local 10 dígitos (fixture Talentum, sem formato)', '1151265663', '******5663'],
    ['local com espaço/traço', '11 5126-5663', '******5663'],
    ['exatamente 8 dígitos (piso mínimo pra mascarar)', '12345678', '******5678'],
    ['7 dígitos — abaixo do piso', '1234567', '****'],
    ['vazio', '', '****'],
    ['string sem nenhum dígito', '+++---', '****'],
    // Achado do gate 12/09: local argentino com 0 de tronco tem >= 11 dígitos
    // e caía (antes deste fix) no ramo "tem código de país", expondo
    // tronco+área — "011 5126-5663" → "+011******5663". Nenhum código de país
    // E.164 começa em "0" (plano ITU-T atribui 1-3 dígitos a partir de 1..9),
    // então dígitos começando em "0" são sempre tronco nacional, nunca país.
    ['local AR com 0 de tronco (11 dígitos)', '011 5126-5663', '******5663'],
    ['local AR com 0 de tronco, sem formatação', '01151265663', '******5663'],
    ['local AR com 0 de tronco (13 dígitos)', '0111551265663', '******5663'],
    ['BR E.164 — não começa com 0, ramo país inalterado', '+5511998887766', '+551******7766'],
  ])('%s', (_label, input, expected) => {
    it(`"${input}" → "${expected}"`, () => {
      expect(maskPhoneForLog(input)).toBe(expected);
    });

    it('nunca vaza 5+ dígitos consecutivos do original, e mostra os 4 últimos quando não é o piso', () => {
      const out = maskPhoneForLog(input);
      assertNoDigitRunLeaks(input, out);
      const digits = input.replace(/\D/g, '');
      if (digits.length >= 8) {
        expect(out).toContain(digits.slice(-4));
      } else {
        expect(out).toBe('****');
      }
    });
  });

  it('null e undefined: marcador fixo, sem lançar', () => {
    expect(maskPhoneForLog(null)).toBe('****');
    expect(maskPhoneForLog(undefined)).toBe('****');
  });

  it('E.164 INALTERADO — mesma saída de antes do fix (não pode quebrar filtro salvo no Cloud Logging)', () => {
    // Valor usado pelos sítios pré-existentes (TwilioVerifyService,
    // StartClaimUseCase, PeriskopeInboundRouter/NoteService/TicketService,
    // TwilioMessagingService, ProcessTalentumPrescreening PII guard).
    expect(maskPhoneForLog('+5491122334455')).toBe('+549******4455');
  });

  it('é determinístico — mesmo input, mesma saída (usável como filtro literal)', () => {
    const a = maskPhoneForLog('+5491122334455');
    const b = maskPhoneForLog('+5491122334455');
    expect(a).toBe(b);
  });

  it('não vaza o TAMANHO do número pelo comprimento da máscara — asteriscos são sempre 6', () => {
    const curto = maskPhoneForLog('+5491151265663'); // 13 dígitos
    const longo = maskPhoneForLog('+549115126566312345'); // 19 dígitos
    expect(curto.match(/\*/g)?.length).toBe(6);
    expect(longo.match(/\*/g)?.length).toBe(6);
  });
});
