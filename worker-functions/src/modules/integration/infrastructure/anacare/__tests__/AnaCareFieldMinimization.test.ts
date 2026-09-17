/**
 * AnaCareFieldMinimization.test.ts
 *
 * Teste de CONTRATO (2.3, spec §Minimização): fixture sintética com telefone/`location`/
 * pagamento/observação clínica/CURP-RFC no payload cru do Ana Care. As funções de minimização
 * têm que descartar tudo isso na borda — só passam ids, nomes (quando a porta precisar),
 * previsto, check-in/checkout, origem, atraso, horas.
 *
 * Sabotagem (fase-2.md "termina quando"): deixar um desses campos vazar no DTO faz este teste
 * VERMELHO — executada e colada no relatório da task (não é afirmação, é evidência).
 *
 * A partir do conserto de 17/09/2026: as fixtures de FORMA real vêm de `__fixtures__/
 * rawShiftRealShape.ts` (nomes de campo medidos contra a API real) — este arquivo de POISON
 * continua usando fixture PRÓPRIA com os nomes corretos, só para o contrato de descarte de PII.
 */
const mockLogWarn = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), child: jest.fn(), warn: (...a: unknown[]) => mockLogWarn(...a), error: jest.fn() },
}));

import { minimizeShiftDTO, minimizePatientFields, shiftDayFrom, POISON_MARKER } from '../AnaCareFieldMinimization';
import type { RawAnaCareShift, RawAnaCarePatient } from '../AnaCareFieldMinimization';
import {
  rawShiftNoturnoCruzaMeiaNoite,
  rawShiftComCheckinSemCheckout,
  rawShiftSemCheckin,
  rawPatientRealShape,
  rawNurseRealShape,
} from '../__fixtures__/rawShiftRealShape';

beforeEach(() => {
  mockLogWarn.mockClear();
});

function rawPatientFixture(overrides: Partial<RawAnaCarePatient> = {}): RawAnaCarePatient {
  return {
    id: 501,
    agency: 116,
    document_type: 'DNI',
    document_number: '30111222',
    first_name: 'Lucía',
    last_name: 'Fernández',
    phone: POISON_MARKER + '-phone-541155550000',
    address: POISON_MARKER + '-address-Av Siempre Viva 742',
    location: { lat: POISON_MARKER, lng: -58.4 },
    initial_location: { lat: -34.6, lng: POISON_MARKER },
    ...overrides,
  };
}

function rawShiftFixture(overrides: Partial<RawAnaCareShift> = {}): RawAnaCareShift {
  return {
    id: 9001,
    start: '2026-09-10T13:00:00-06:00',
    end: '2026-09-10T17:00:00-06:00',
    checkin: '2026-09-10T13:05:00-06:00',
    checkout: '2026-09-10T16:58:00-06:00',
    checkin_source: 'app',
    checkout_source: 'app',
    checkin_delay: 5,
    duration: 3.88,
    is_finalized: true,
    month: '2026-09',
    payment_amount: POISON_MARKER + '-payment-45000.50',
    observations: POISON_MARKER + '-clinical-note-paciente relatou dor',
    patient: rawPatientFixture(),
    nurse: {
      id: 77,
      agency: 116,
      first_name: 'Carla',
      last_name: 'Suárez',
      curp: POISON_MARKER + '-curp-SUAC900101MDFRRL01',
      rfc: POISON_MARKER + '-rfc-SUAC900101XXX',
      phone: POISON_MARKER + '-nurse-phone-541199990000',
    },
    ...overrides,
  };
}

const DTO_KEYS = [
  'sourceShiftId',
  'anaCarePatientId',
  'anaCareNurseId',
  'date',
  'scheduledStart',
  'scheduledEnd',
  'actualStart',
  'actualEnd',
  'checkinSource',
  'checkoutSource',
  'checkinDelay',
  'isFinalized',
  'sourceMonth',
].sort();

describe('AnaCareFieldMinimization — contrato de minimização na borda (2.3)', () => {
  it('minimizeShiftDTO nunca deixa telefone, location, pagamento, observação ou CURP/RFC vazarem', () => {
    const raw = rawShiftFixture();
    const dto = minimizeShiftDTO(raw);

    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain(POISON_MARKER);

    // Contrato estrutural: só as 13 chaves do SourceShiftDTO (spec AnaCareShiftsSource.ts).
    expect(Object.keys(dto).sort()).toEqual(DTO_KEYS);

    expect(dto.sourceShiftId).toBe('9001');
    expect(dto.anaCarePatientId).toBe('501');
    expect(dto.anaCareNurseId).toBe('77');
    expect(dto.isFinalized).toBe(true);
    // `duration` (previsto) do raw NUNCA aparece no DTO — não existe campo de hora prevista na
    // porta (medido 17/09: o único jeito certo de saber a hora trabalhada é actualStart/actualEnd).
    expect(dto).not.toHaveProperty('durationHours');
    expect(dto).not.toHaveProperty('duration');
  });

  it('lê `duration` do cru (não `duration_hours`, que não existe na resposta real medida 17/09) — e não fabrica nada no DTO a partir dele', () => {
    // Cru com o nome ERRADO (`duration_hours`) presente e o CERTO (`duration`) ausente — o defeito
    // medido era exatamente ler `raw.duration_hours` (sempre `undefined` com dado real).
    const rawComNomeErrado = { ...rawShiftFixture(), duration_hours: 3.88 } as unknown as RawAnaCareShift;
    delete (rawComNomeErrado as { duration?: number | null }).duration;

    const dto = minimizeShiftDTO(rawComNomeErrado);

    // O DTO não tem NENHUM campo de hora prevista/vinda do `duration` — a minimização não lê
    // `duration_hours` (nome errado) nem exporia um valor por acidente.
    expect(dto).not.toHaveProperty('durationHours');
    expect(dto).not.toHaveProperty('duration');
  });

  it('minimizePatientFields nunca deixa telefone, endereço ou location vazarem', () => {
    const raw = rawPatientFixture();
    const fields = minimizePatientFields(raw);

    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain(POISON_MARKER);

    expect(Object.keys(fields).sort()).toEqual(
      ['id', 'agency', 'document_type', 'document_number', 'first_name', 'last_name'].sort(),
    );
    expect(fields.agency).toBe(116);
    expect(fields.document_number).toBe('30111222');
  });

  it('checkin_source nulo (sem check-in) sobrevive à minimização como null, não como ausência', () => {
    const raw = rawShiftFixture({
      checkin_source: null,
      checkout_source: null,
      checkin: null,
      checkout: null,
      checkin_delay: null,
      duration: null,
      is_finalized: false,
    });
    const dto = minimizeShiftDTO(raw);
    expect(dto.checkinSource).toBeNull();
    expect(dto.actualStart).toBeNull();
    expect(dto.actualEnd).toBeNull();
    expect(dto.isFinalized).toBe(false);
  });

  it('`is_finalized=true` preenchido mesmo com `duration` (previsto) diferente do real — a minimização só copia `is_finalized`, nunca deriva de `duration`', () => {
    const raw = rawShiftFixture({ duration: 12, is_finalized: true, checkin: '2026-09-10T13:00:00-06:00', checkout: '2026-09-10T14:00:00-06:00' });
    const dto = minimizeShiftDTO(raw);
    expect(dto.isFinalized).toBe(true);
    expect(dto).not.toHaveProperty('duration');
    expect(dto).not.toHaveProperty('durationHours');
  });
});

describe('AnaCareFieldMinimization — conserto de raiz 17/09/2026 (nomes reais medidos, D∅ shift_date NOT NULL)', () => {
  it('cada campo do SourceShiftDTO sai preenchido a partir da fixture de forma real — nenhuma chave `undefined`', () => {
    for (const raw of [rawShiftNoturnoCruzaMeiaNoite(), rawShiftComCheckinSemCheckout(), rawShiftSemCheckin()]) {
      const dto = minimizeShiftDTO(raw);
      for (const key of DTO_KEYS) {
        expect(dto).toHaveProperty(key);
        // `undefined` explícito é o sintoma do defeito medido (nome de campo errado) — `null` é
        // valor legítimo (sem check-in etc.), só `undefined` é proibido.
        expect((dto as unknown as Record<string, unknown>)[key]).not.toBeUndefined();
      }
    }
  });

  it('turno que cruza a meia-noite: `date` é o dia do START, não do end (32/88 medidos são noturnos 20h→08h)', () => {
    const raw = rawShiftNoturnoCruzaMeiaNoite();
    expect(raw.start.slice(0, 10)).toBe('2026-08-30');
    expect(raw.end.slice(0, 10)).toBe('2026-08-31');

    const dto = minimizeShiftDTO(raw);
    expect(dto.date).toBe('2026-08-30');
    expect(shiftDayFrom(raw.start)).toBe('2026-08-30');
  });

  it('turno com check-in e SEM checkout: `actualEnd` null, `isFinalized` false — não finalizado não é ausência de dado', () => {
    const dto = minimizeShiftDTO(rawShiftComCheckinSemCheckout());
    expect(dto.actualStart).not.toBeNull();
    expect(dto.actualEnd).toBeNull();
    expect(dto.isFinalized).toBe(false);
  });

  it('turno sem check-in nenhum: actualStart/actualEnd/checkinSource/checkoutSource nulos, isFinalized false', () => {
    const dto = minimizeShiftDTO(rawShiftSemCheckin());
    expect(dto.actualStart).toBeNull();
    expect(dto.actualEnd).toBeNull();
    expect(dto.checkinSource).toBeNull();
    expect(dto.checkoutSource).toBeNull();
    expect(dto.isFinalized).toBe(false);
  });

  it('checkoutSource e checkinDelay chegam ao DTO (existiam na fonte, gravados NULOS por falta de campo — achado do PR #414)', () => {
    const dto = minimizeShiftDTO(rawShiftNoturnoCruzaMeiaNoite());
    expect(dto.checkoutSource).toBe('app');
    expect(dto.checkinDelay).toBe(12);
  });

  it('sourceMonth vem de `raw.month` (afirmação da fonte, presente em 88/88 medidos)', () => {
    const dto = minimizeShiftDTO(rawShiftNoturnoCruzaMeiaNoite());
    expect(dto.sourceMonth).toBe('2026-08');
  });

  it('sourceMonth cai no fallback derivado do dia quando `raw.month` vem nulo', () => {
    const dto = minimizeShiftDTO(rawShiftNoturnoCruzaMeiaNoite({ month: null }));
    expect(dto.sourceMonth).toBe('2026-08');
  });

  /**
   * MORRE se alguém voltar a ler os nomes ANTIGOS (`scheduled_start`/`actual_start`/`date`) — a
   * causa raiz exata do 500 medido (`null value in column "shift_date"`). Fixture com os nomes
   * ANTIGOS presentes e os NOVOS (`start`/`checkin`) ausentes: `minimizeShiftDTO` tem de FALHAR
   * alto (lançar), nunca aparentar funcionar devolvendo `date`/`scheduledStart` como `undefined`
   * (que é exatamente o que produzia o 500 em produção — undefined vira NULL calado no banco).
   */
  it('fixture com nomes ANTIGOS presentes e NOVOS ausentes: minimizeShiftDTO lança, não aparenta funcionar', () => {
    const rawComNomesAntigos = {
      id: 1858092,
      date: '2026-08-30',
      scheduled_start: '2026-08-30T20:00:00-06:00',
      scheduled_end: '2026-08-31T08:00:00-06:00',
      actual_start: '2026-08-30T20:12:00-06:00',
      actual_end: '2026-08-31T08:00:00-06:00',
      checkin_source: 'app',
      checkout_source: 'app',
      checkin_delay: 12,
      duration: 12,
      is_finalized: true,
      month: '2026-08',
      patient: { id: 9660, agency: 116, document_type: 'DNI', document_number: '1', first_name: 'X', last_name: 'Y' },
      nurse: { id: 91116, agency: 116, first_name: 'A', last_name: 'B' },
      // `start`/`end`/`checkin`/`checkout` (os nomes CERTOS) ausentes de propósito.
    } as unknown as RawAnaCareShift;

    expect(() => minimizeShiftDTO(rawComNomesAntigos)).toThrow();
  });
});

describe('AnaCareFieldMinimization — fixtures de __fixtures__/rawShiftRealShape.ts respeitam overrides (conserto 17/09)', () => {
  // Morre se o spread `...overrides` sumir de QUALQUER uma das três fixtures — a fixture nova
  // (`rawShiftSemCheckin`) tinha o bug: recebia `overrides` e IGNORAVA, devolvendo sempre os
  // defaults. Um teste futuro que passasse override receberia o default em silêncio (falso verde).
  it('rawShiftNoturnoCruzaMeiaNoite repassa override', () => {
    expect(rawShiftNoturnoCruzaMeiaNoite({ id: 'override-1' }).id).toBe('override-1');
  });

  it('rawShiftComCheckinSemCheckout repassa override', () => {
    expect(rawShiftComCheckinSemCheckout({ id: 'override-2' }).id).toBe('override-2');
  });

  it('rawShiftSemCheckin repassa override (defeito: fixture ignorava `...overrides`)', () => {
    expect(rawShiftSemCheckin({ id: 'override-3' }).id).toBe('override-3');
  });

  it('rawPatientRealShape repassa override', () => {
    expect(rawPatientRealShape({ first_name: 'Override' }).first_name).toBe('Override');
  });

  it('rawNurseRealShape repassa override', () => {
    expect(rawNurseRealShape({ first_name: 'Override' }).first_name).toBe('Override');
  });
});

describe('AnaCareFieldMinimization — checkin_source/checkout_source validados em RUNTIME (conserto 17/09, migration 437)', () => {
  it("valor 'app' passa intacto em ambos os campos", () => {
    const dto = minimizeShiftDTO(rawShiftNoturnoCruzaMeiaNoite({ checkin_source: 'app', checkout_source: 'app' }));
    expect(dto.checkinSource).toBe('app');
    expect(dto.checkoutSource).toBe('app');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("valor 'web_admin' passa intacto em ambos os campos", () => {
    const dto = minimizeShiftDTO(
      rawShiftNoturnoCruzaMeiaNoite({ checkin_source: 'web_admin', checkout_source: 'web_admin' }),
    );
    expect(dto.checkinSource).toBe('web_admin');
    expect(dto.checkoutSource).toBe('web_admin');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('null passa como null em ambos os campos, sem logar', () => {
    const dto = minimizeShiftDTO(rawShiftSemCheckin());
    expect(dto.checkinSource).toBeNull();
    expect(dto.checkoutSource).toBeNull();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("valor desconhecido em checkin_source vira null e chama o logger — NUNCA repassa cru (o que derrubaria o INSERT em lote pelo CHECK da migration 437)", () => {
    const raw = rawShiftNoturnoCruzaMeiaNoite({ checkin_source: 'telegram' as unknown as 'app' });
    const dto = minimizeShiftDTO(raw);

    expect(dto.checkinSource).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'checkin_source', value: 'telegram' }),
    );
  });

  it("valor desconhecido em checkout_source vira null e chama o logger (irmão do checkin_source — mesmo conserto nos DOIS campos)", () => {
    const raw = rawShiftNoturnoCruzaMeiaNoite({ checkout_source: 'telegram' as unknown as 'app' });
    const dto = minimizeShiftDTO(raw);

    expect(dto.checkoutSource).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'checkout_source', value: 'telegram' }),
    );
  });

  // MORRE se alguém voltar a repassar `raw.checkin_source`/`raw.checkout_source` cru sem validar —
  // um valor desconhecido chegaria intacto ao repositório e o CHECK da migration 437 rejeitaria o
  // INSERT do lote inteiro (o mesmo modo de falha do `shift_date`, pela terceira vez nesta frente).
  it('valor desconhecido NUNCA aparece cru no DTO (nem em checkinSource, nem em checkoutSource)', () => {
    const raw = rawShiftNoturnoCruzaMeiaNoite({
      checkin_source: 'telegram' as unknown as 'app',
      checkout_source: 'outro-valor-novo' as unknown as 'app',
    });
    const dto = minimizeShiftDTO(raw);

    expect(dto.checkinSource).not.toBe('telegram');
    expect(dto.checkoutSource).not.toBe('outro-valor-novo');
    expect([null, 'app', 'web_admin']).toContain(dto.checkinSource);
    expect([null, 'app', 'web_admin']).toContain(dto.checkoutSource);
  });
});
