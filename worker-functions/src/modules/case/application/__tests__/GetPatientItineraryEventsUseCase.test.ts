/**
 * GetPatientItineraryEventsUseCase — D445.3. `reader` injetado (dublê puro): cobre o teto de 62
 * dias (400), o 404 quando o paciente não existe, o nome do prestador (titular e substituto) pela
 * MESMA `projectWorkerDisplayNames`, e o repasse de filtro serviceId/workerId ao expansor puro.
 */
import {
  GetPatientItineraryEventsUseCase,
  PatientNotFoundForItineraryEventsError,
  ItineraryEventsRangeInvalidError,
  ITINERARY_EVENTS_MAX_DAYS,
  type PatientItineraryEventsReaderPort,
} from '../GetPatientItineraryEventsUseCase';
import type { ItineraryEventsRows } from '../../infrastructure/PatientItineraryEventsReader';

const PID = 'p-1';

function readerWith(rows: ItineraryEventsRows | null): PatientItineraryEventsReaderPort {
  return { readForRange: jest.fn().mockResolvedValue(rows) };
}

/** Dublê do KMS: decifra `v` como `dec:v` — nenhum KMS real no unit. */
function kmsDouble(): { decrypt: jest.Mock } {
  return { decrypt: jest.fn(async (v: string) => `dec:${v}`) };
}

const EMPTY_ROWS: ItineraryEventsRows = { country: 'AR', slots: [], assignments: [], absences: [], workerNames: [] };

describe('GetPatientItineraryEventsUseCase', () => {
  it('paciente inexistente (reader devolve null) → PatientNotFoundForItineraryEventsError', async () => {
    const useCase = new GetPatientItineraryEventsUseCase(readerWith(null), kmsDouble());

    await expect(useCase.execute({ patientId: PID, from: '2026-09-27', to: '2026-09-27' })).rejects.toThrow(
      PatientNotFoundForItineraryEventsError,
    );
  });

  it('to < from → ItineraryEventsRangeInvalidError, sem tocar o leitor', async () => {
    const reader = readerWith(EMPTY_ROWS);
    const useCase = new GetPatientItineraryEventsUseCase(reader, kmsDouble());

    await expect(useCase.execute({ patientId: PID, from: '2026-09-27', to: '2026-09-20' })).rejects.toThrow(
      ItineraryEventsRangeInvalidError,
    );
    expect(reader.readForRange).not.toHaveBeenCalled();
  });

  it(`intervalo de exatamente ${ITINERARY_EVENTS_MAX_DAYS} dias passa; ${ITINERARY_EVENTS_MAX_DAYS + 1} dias é recusado (400)`, async () => {
    const reader = readerWith(EMPTY_ROWS);
    const useCase = new GetPatientItineraryEventsUseCase(reader, kmsDouble());

    const ok = await useCase.execute({ patientId: PID, from: '2026-01-01', to: '2026-03-03' }); // 62 dias inclusive
    expect(ok.events).toEqual([]);

    await expect(useCase.execute({ patientId: PID, from: '2026-01-01', to: '2026-03-04' })).rejects.toThrow(
      ItineraryEventsRangeInvalidError,
    );
  });

  it('feliz: 1 alocação vigente no domingo do intervalo, nome do titular decifrado', async () => {
    const rows: ItineraryEventsRows = {
      country: 'AR',
      slots: [{ slotId: 'slot-1', serviceId: 'svc-1', weekday: 0, startTime: '09:00', endTime: '13:00', validFrom: '2026-01-01', validTo: null }],
      assignments: [{ assignmentId: 'a-1', slotId: 'slot-1', workerId: 'w-titular', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' }],
      absences: [],
      workerNames: [{ workerId: 'w-titular', firstNameEncrypted: 'enc-first', lastNameEncrypted: 'enc-last' }],
    };
    const reader = readerWith(rows);
    const useCase = new GetPatientItineraryEventsUseCase(reader, kmsDouble());

    const result = await useCase.execute({ patientId: PID, from: '2026-09-27', to: '2026-09-27', cells: ['worker_contact:read'] });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].status).toBe('covered');
    expect(result.events[0].workerId).toBe('w-titular');
    // Sem célula real de decrypt aqui — o double só prova que o mapa foi consultado; a redação de
    // verdade (NOME_REDIGIDO por `projectWorkerFields`) é coberta pelo teste de `workerDisplayNames`.
    expect(reader.readForRange).toHaveBeenCalledWith(PID, '2026-09-27', '2026-09-27');
    expect(result.events[0]).toMatchObject({ titularDisplayName: 'dec:enc-first dec:enc-last', requestId: null, absenceId: null });
  });

  it('FR-12: faixa SEM alocação vigente sai como uncovered com ids nulos e nomes nulos (contrato string | null)', async () => {
    const rows: ItineraryEventsRows = {
      country: 'AR',
      slots: [{ slotId: 'slot-1', serviceId: 'svc-1', weekday: 0, startTime: '09:00', endTime: '13:00', validFrom: '2026-01-01', validTo: null }],
      assignments: [],
      absences: [],
      workerNames: [],
    };
    const result = await new GetPatientItineraryEventsUseCase(readerWith(rows), kmsDouble()).execute({ patientId: PID, from: '2026-09-27', to: '2026-09-27' });

    expect(result.events).toEqual([
      expect.objectContaining({
        status: 'uncovered',
        assignmentId: null,
        titularWorkerId: null,
        titularDisplayName: null,
        absenceId: null,
        requestId: null,
        workerId: null,
        workerDisplayName: null,
        substituteDisplayName: null,
        slotId: 'slot-1',
      }),
    ]);
  });

  it('ausência com substituto: requestId do pedido na linha e o nome de quem cobre', async () => {
    const rows: ItineraryEventsRows = {
      country: 'AR',
      slots: [{ slotId: 'slot-1', serviceId: 'svc-1', weekday: 0, startTime: '09:00', endTime: '13:00', validFrom: '2026-01-01', validTo: null }],
      assignments: [{ assignmentId: 'a-1', slotId: 'slot-1', workerId: 'w-titular', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' }],
      absences: [{ absenceId: 'ab-1', assignmentId: 'a-1', onDate: '2026-09-27', substituteWorkerId: 'w-sub', requestId: 'req-1' }],
      workerNames: [
        { workerId: 'w-titular', firstNameEncrypted: 'ft', lastNameEncrypted: 'lt' },
        { workerId: 'w-sub', firstNameEncrypted: 'fs', lastNameEncrypted: 'ls' },
      ],
    };
    const result = await new GetPatientItineraryEventsUseCase(readerWith(rows), kmsDouble()).execute({ patientId: PID, from: '2026-09-27', to: '2026-09-27' });

    expect(result.events[0]).toMatchObject({ status: 'substituted', requestId: 'req-1', absenceId: 'ab-1', workerDisplayName: 'dec:fs dec:ls', substituteDisplayName: 'dec:fs dec:ls', titularDisplayName: 'dec:ft dec:lt' });
  });

  it('repassa serviceId/workerId ao expansor — o reader recebe só from/to (o filtro é em memória)', async () => {
    const reader = readerWith(EMPTY_ROWS);
    const useCase = new GetPatientItineraryEventsUseCase(reader, kmsDouble());

    await useCase.execute({ patientId: PID, from: '2026-09-27', to: '2026-09-27', serviceId: 'svc-1', workerId: 'w-1' });

    expect(reader.readForRange).toHaveBeenCalledWith(PID, '2026-09-27', '2026-09-27');
  });
});
