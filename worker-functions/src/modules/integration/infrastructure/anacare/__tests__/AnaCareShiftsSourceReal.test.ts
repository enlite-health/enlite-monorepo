/**
 * AnaCareShiftsSourceReal.test.ts (2.2) — porta real sobre o AnaCareSessionClient.
 * Sem rede real: o `AnaCareSessionClient` é um stub controlado, não o cliente HTTP de verdade.
 */
import { AnaCareShiftsSourceReal } from '../AnaCareShiftsSourceReal';
import type { AnaCareSessionClient } from '../AnaCareSessionClient';
import type { SourceShiftDTO } from '../../../../anacare-hours/domain/AnaCareShiftsSource';

function fakeDto(overrides: Partial<SourceShiftDTO> = {}): SourceShiftDTO {
  return {
    sourceShiftId: '1',
    anaCarePatientId: '10',
    anaCareNurseId: '100',
    date: '2026-09-01',
    scheduledStart: '2026-09-01T13:00:00Z',
    scheduledEnd: '2026-09-01T17:00:00Z',
    actualStart: null,
    actualEnd: null,
    checkinSource: null,
    isFinalized: false,
    ...overrides,
  };
}

describe('AnaCareShiftsSourceReal', () => {
  it('listShifts delega ao session client e devolve o DTO já minimizado', async () => {
    const listShifts = jest.fn().mockResolvedValue([fakeDto()]);
    const client = { listShifts, getRawShift: jest.fn(), circuitBreakerOpen: false } as unknown as AnaCareSessionClient;
    const source = new AnaCareShiftsSourceReal(client);

    const result = await source.listShifts({ month: '2026-09' });
    expect(result).toEqual([fakeDto()]);
    expect(listShifts).toHaveBeenCalledWith({
      from: '2026-09-01',
      to: '2026-09-30',
      patientId: undefined,
      reservationId: undefined,
    });
  });

  it('listShifts traduz `month` para `from`/`to` (1º e último dia do mês) ANTES de chamar o cliente — bug medido 16/09: `?month=` não filtra no servidor (count=882776 vs count=3483 com min_date/max_date)', async () => {
    const listShifts = jest.fn().mockResolvedValue([]);
    const client = { listShifts, getRawShift: jest.fn(), circuitBreakerOpen: false } as unknown as AnaCareSessionClient;
    const source = new AnaCareShiftsSourceReal(client);

    await source.listShifts({ month: '2026-02' }); // fevereiro 2026 (não bissexto) — 28 dias
    await source.listShifts({ month: '2028-02' }); // fevereiro 2028 (bissexto) — 29 dias
    await source.listShifts({ month: '2026-01' }); // janeiro — 31 dias

    expect(listShifts.mock.calls[0][0]).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(listShifts.mock.calls[1][0]).toMatchObject({ from: '2028-02-01', to: '2028-02-29' });
    expect(listShifts.mock.calls[2][0]).toMatchObject({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('listShifts repassa patientId e reservationId ao cliente junto com a faixa traduzida', async () => {
    const listShifts = jest.fn().mockResolvedValue([]);
    const client = { listShifts, getRawShift: jest.fn(), circuitBreakerOpen: false } as unknown as AnaCareSessionClient;
    const source = new AnaCareShiftsSourceReal(client);

    await source.listShifts({ month: '2026-09', patientId: '42', reservationId: '99' });

    expect(listShifts).toHaveBeenCalledWith({
      from: '2026-09-01',
      to: '2026-09-30',
      patientId: '42',
      reservationId: '99',
    });
  });

  it('getShift minimiza o turno cru retornado pelo cliente', async () => {
    const getRawShift = jest.fn().mockResolvedValue({
      id: 5,
      date: '2026-09-02',
      scheduled_start: 'a',
      scheduled_end: 'b',
      actual_start: null,
      actual_end: null,
      checkin_source: 'app',
      duration: 4,
      is_finalized: true,
      patient: { id: 20, agency: 116, document_type: 'DNI', document_number: '9', first_name: 'X', last_name: 'Y' },
      nurse: { id: 200, first_name: 'N', last_name: 'M' },
    });
    const client = { listShifts: jest.fn(), getRawShift, circuitBreakerOpen: false } as unknown as AnaCareSessionClient;
    const source = new AnaCareShiftsSourceReal(client);

    const result = await source.getShift('5');
    expect(result?.sourceShiftId).toBe('5');
    expect(result?.anaCarePatientId).toBe('20');
    // não pode ter escapado nenhum campo fora do DTO (contrato de minimização)
    expect(Object.keys(result as object).sort()).toEqual(
      ['sourceShiftId', 'anaCarePatientId', 'anaCareNurseId', 'date', 'scheduledStart', 'scheduledEnd', 'actualStart', 'actualEnd', 'checkinSource', 'isFinalized'].sort(),
    );
  });

  it('getShift devolve null quando o cliente devolve null (404)', async () => {
    const getRawShift = jest.fn().mockResolvedValue(null);
    const client = { listShifts: jest.fn(), getRawShift, circuitBreakerOpen: false } as unknown as AnaCareSessionClient;
    const source = new AnaCareShiftsSourceReal(client);
    expect(await source.getShift('missing')).toBeNull();
  });

  it('getRetratoStatus reflete o circuitBreakerOpen do cliente', async () => {
    const client = { listShifts: jest.fn(), getRawShift: jest.fn(), circuitBreakerOpen: true } as unknown as AnaCareSessionClient;
    const source = new AnaCareShiftsSourceReal(client);
    const status = await source.getRetratoStatus();
    expect(status).toEqual({ stale: false, circuitBreakerOpen: true });
  });
});
