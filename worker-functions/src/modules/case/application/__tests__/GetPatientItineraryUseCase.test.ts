/**
 * GetPatientItineraryUseCase — fase 7, DX-7.6.
 *
 * `reader` injetado (dublê puro, sem transação/banco): cobre agrupamento por serviço, o `asOf`
 * pelo fuso do PAÍS do paciente (nunca o relógio do processo — `localParts`/`countryToTimezone`,
 * as mesmas funções da Fase 6) e o 404 quando o leitor devolve `null`.
 */
import { GetPatientItineraryUseCase, PatientNotFoundForItineraryError, type PatientItineraryReaderPort } from '../GetPatientItineraryUseCase';
import type { ItineraryRows } from '../../infrastructure/PatientItineraryReader';

const PID = 'p-1';

function readerWith(rows: ItineraryRows | null): PatientItineraryReaderPort {
  return { readPatientItinerary: jest.fn().mockResolvedValue(rows) };
}

describe('GetPatientItineraryUseCase', () => {
  it('asOf usa o fuso do PAÍS do paciente, não o relógio do processo — AR: 02:30Z ainda é dia 27 em Buenos Aires', async () => {
    const reader = readerWith({ country: 'AR', services: [], slots: [] });
    const useCase = new GetPatientItineraryUseCase(reader);

    const result = await useCase.execute(PID, new Date('2026-09-28T02:30:00Z'));

    expect(result.asOf).toBe('2026-09-27');
  });

  it('mesma hora UTC, paciente BR: 02:30Z ainda é dia 27 em São Paulo (mesmo offset -03)', async () => {
    const reader = readerWith({ country: 'BR', services: [], slots: [] });
    const useCase = new GetPatientItineraryUseCase(reader);

    const result = await useCase.execute(PID, new Date('2026-09-28T02:30:00Z'));

    expect(result.asOf).toBe('2026-09-27');
  });

  it('a virada: 03:30Z já é dia 28 em Buenos Aires (fuso vem de countryToTimezone, não do processo — passa em qualquer fuso de runner)', async () => {
    const reader = readerWith({ country: 'AR', services: [], slots: [] });
    const useCase = new GetPatientItineraryUseCase(reader);

    const result = await useCase.execute(PID, new Date('2026-09-28T03:30:00Z'));

    expect(result.asOf).toBe('2026-09-28');
  });

  it('agrupamento: 2 serviços, 3 slots, 1 alocação vigente — cobertas certas, na ordem do leitor', async () => {
    const rows: ItineraryRows = {
      country: 'AR',
      services: [
        { id: 'svc-a', weeklyHours: 20, authorizedHours: null },
        { id: 'svc-b', weeklyHours: null, authorizedHours: 10 },
      ],
      slots: [
        // svc-a, slot coberto: alocação ACTIVE vigente em 2026-09-27 (validFrom passado, sem fim).
        {
          id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', endTime: '12:00', active: true,
          assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
        },
        // svc-a, slot ativo mas sem alocação → não coberto.
        {
          id: 's2', contractedServiceId: 'svc-a', weekday: 2, startTime: '08:00', endTime: '10:00', active: true,
          assignmentId: null, workerId: null, applicationId: null, validFrom: null, validTo: null, status: null,
        },
        // svc-b, único slot, sem alocação → não coberto, cobertas = 0.
        {
          id: 's3', contractedServiceId: 'svc-b', weekday: 3, startTime: '08:00', endTime: '09:00', active: true,
          assignmentId: null, workerId: null, applicationId: null, validFrom: null, validTo: null, status: null,
        },
      ],
    };
    const useCase = new GetPatientItineraryUseCase(readerWith(rows));

    const result = await useCase.execute(PID, new Date('2026-09-27T15:00:00Z'));

    expect(result.asOf).toBe('2026-09-27');
    expect(result.services).toHaveLength(2);
    expect(result.services[0]).toMatchObject({
      contractedServiceId: 'svc-a',
      contratadas: { weekly: 20, authorized: null },
      cobertas: 4,
    });
    expect(result.services[0].slots).toHaveLength(2);
    expect(result.services[0].slots[0].assignments).toEqual([
      { workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
    ]);
    expect(result.services[1]).toMatchObject({
      contractedServiceId: 'svc-b',
      contratadas: { weekly: null, authorized: 10 },
      cobertas: 0,
    });
    expect(result.services[1].slots).toHaveLength(1);
  });

  it('serviço sem slot algum → slots: [], cobertas: 0 (nenhuma linha de slot para ele no leitor)', async () => {
    const rows: ItineraryRows = {
      country: 'AR',
      services: [{ id: 'svc-c', weeklyHours: 5, authorizedHours: null }],
      slots: [],
    };
    const useCase = new GetPatientItineraryUseCase(readerWith(rows));

    const result = await useCase.execute(PID, new Date('2026-09-27T15:00:00Z'));

    expect(result.services).toEqual([
      { contractedServiceId: 'svc-c', contratadas: { weekly: 5, authorized: null }, cobertas: 0, slots: [] },
    ]);
  });

  it('leitor devolve null → PatientNotFoundForItineraryError com o patientId', async () => {
    const useCase = new GetPatientItineraryUseCase(readerWith(null));

    await expect(useCase.execute(PID)).rejects.toBeInstanceOf(PatientNotFoundForItineraryError);
    await expect(useCase.execute(PID)).rejects.toMatchObject({ patientId: PID });
  });
});
