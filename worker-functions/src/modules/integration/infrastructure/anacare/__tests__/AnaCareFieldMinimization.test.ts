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
 */
import { minimizeShiftDTO, minimizePatientFields, POISON_MARKER } from '../AnaCareFieldMinimization';
import type { RawAnaCareShift, RawAnaCarePatient } from '../AnaCareFieldMinimization';

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
    date: '2026-09-10',
    scheduled_start: '2026-09-10T13:00:00Z',
    scheduled_end: '2026-09-10T17:00:00Z',
    actual_start: '2026-09-10T13:05:00Z',
    actual_end: '2026-09-10T16:58:00Z',
    checkin_source: 'app',
    duration_hours: 3.88,
    delay_minutes: 5,
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

describe('AnaCareFieldMinimization — contrato de minimização na borda (2.3)', () => {
  it('minimizeShiftDTO nunca deixa telefone, location, pagamento, observação ou CURP/RFC vazarem', () => {
    const raw = rawShiftFixture();
    const dto = minimizeShiftDTO(raw);

    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain(POISON_MARKER);

    // Contrato estrutural: só as 10 chaves do SourceShiftDTO (spec AnaCareShiftsSource.ts).
    expect(Object.keys(dto).sort()).toEqual(
      [
        'sourceShiftId',
        'anaCarePatientId',
        'anaCareNurseId',
        'date',
        'scheduledStart',
        'scheduledEnd',
        'actualStart',
        'actualEnd',
        'checkinSource',
        'durationHours',
      ].sort(),
    );

    expect(dto.sourceShiftId).toBe('9001');
    expect(dto.anaCarePatientId).toBe('501');
    expect(dto.anaCareNurseId).toBe('77');
    expect(dto.durationHours).toBe(3.88);
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
    const raw = rawShiftFixture({ checkin_source: null, actual_start: null, actual_end: null, duration_hours: null });
    const dto = minimizeShiftDTO(raw);
    expect(dto.checkinSource).toBeNull();
    expect(dto.actualStart).toBeNull();
    expect(dto.actualEnd).toBeNull();
    expect(dto.durationHours).toBeNull();
  });
});
