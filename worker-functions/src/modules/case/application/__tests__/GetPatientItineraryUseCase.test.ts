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

/** Dublê do KMS (Fase 12): decifra `v` como `dec:v` — nenhum KMS real no unit. */
function kmsDouble(): { decrypt: jest.Mock } {
  return { decrypt: jest.fn(async (v: string) => `dec:${v}`) };
}

describe('GetPatientItineraryUseCase', () => {
  it('asOf usa o fuso do PAÍS do paciente, não o relógio do processo — AR: 02:30Z ainda é dia 27 em Buenos Aires', async () => {
    const reader = readerWith({ country: 'AR', services: [], slots: [] });
    const useCase = new GetPatientItineraryUseCase(reader, kmsDouble());

    const result = await useCase.execute(PID, new Date('2026-09-28T02:30:00Z'));

    expect(result.asOf).toBe('2026-09-27');
  });

  it('mesma hora UTC, paciente BR: 02:30Z ainda é dia 27 em São Paulo (mesmo offset -03)', async () => {
    const reader = readerWith({ country: 'BR', services: [], slots: [] });
    const useCase = new GetPatientItineraryUseCase(reader, kmsDouble());

    const result = await useCase.execute(PID, new Date('2026-09-28T02:30:00Z'));

    expect(result.asOf).toBe('2026-09-27');
  });

  it('a virada: 03:30Z já é dia 28 em Buenos Aires (fuso vem de countryToTimezone, não do processo — passa em qualquer fuso de runner)', async () => {
    const reader = readerWith({ country: 'AR', services: [], slots: [] });
    const useCase = new GetPatientItineraryUseCase(reader, kmsDouble());

    const result = await useCase.execute(PID, new Date('2026-09-28T03:30:00Z'));

    expect(result.asOf).toBe('2026-09-28');
  });

  it('assembledAt: sem linha de montagem → null (campo presente); com montagem → a string ISO do leitor, intacta', async () => {
    const semMontagem = new GetPatientItineraryUseCase(readerWith({ country: 'AR', services: [], slots: [] }), kmsDouble());
    const r1 = await semMontagem.execute(PID, new Date('2026-09-28T03:30:00Z'));
    expect(r1).toHaveProperty('assembledAt', null);

    const nuncaMontado = new GetPatientItineraryUseCase(
      readerWith({ country: 'AR', services: [], slots: [], assembledAt: null }),
      kmsDouble(),
    );
    expect((await nuncaMontado.execute(PID, new Date('2026-09-28T03:30:00Z'))).assembledAt).toBeNull();

    const montado = new GetPatientItineraryUseCase(
      readerWith({ country: 'AR', services: [], slots: [], assembledAt: '2026-09-30T18:05:09.123Z' }),
      kmsDouble(),
    );
    expect((await montado.execute(PID, new Date('2026-09-28T03:30:00Z'))).assembledAt).toBe('2026-09-30T18:05:09.123Z');
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
    const useCase = new GetPatientItineraryUseCase(readerWith(rows), kmsDouble());

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
      {
        workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
        allocationId: 'asg-1', displayName: null,
      },
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
    const useCase = new GetPatientItineraryUseCase(readerWith(rows), kmsDouble());

    const result = await useCase.execute(PID, new Date('2026-09-27T15:00:00Z'));

    expect(result.services).toEqual([
      { contractedServiceId: 'svc-c', contratadas: { weekly: 5, authorized: null }, cobertas: 0, slots: [] },
    ]);
  });

  it('alerts: a ausência de HOJE entra, a de ONTEM sai (asOf AR); cobertas IGUAL com ou sem ausência (mesma linha de services)', async () => {
    const baseRows: ItineraryRows = {
      country: 'AR',
      services: [{ id: 'svc-a', weeklyHours: 20, authorizedHours: null }],
      slots: [
        {
          id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', endTime: '12:00', active: true,
          assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
        },
      ],
    };
    const now = new Date('2026-09-27T15:00:00Z'); // asOf AR = 2026-09-27

    const semAusencia = new GetPatientItineraryUseCase(readerWith(baseRows), kmsDouble());
    const resultSemAusencia = await semAusencia.execute(PID, now);

    const comAusencia = new GetPatientItineraryUseCase(
      readerWith({
        ...baseRows,
        uncoveredAbsences: [
          { serviceId: 'svc-a', date: '2026-09-27', startTime: '08:00', endTime: '12:00' }, // hoje
          { serviceId: 'svc-a', date: '2026-09-26', startTime: '08:00', endTime: '12:00' }, // ontem
        ],
      }),
      kmsDouble(),
    );
    const resultComAusencia = await comAusencia.execute(PID, now);

    expect(resultSemAusencia.alerts).toEqual([]);
    expect(resultComAusencia.alerts).toEqual([
      { serviceId: 'svc-a', date: '2026-09-27', startTime: '08:00', endTime: '12:00' },
    ]);
    expect(resultComAusencia.services[0].cobertas).toBe(resultSemAusencia.services[0].cobertas);
    expect(resultComAusencia.services).toEqual(resultSemAusencia.services);
  });

  describe('[12.9] nome do prestador por célula', () => {
    const rowsComNome: ItineraryRows = {
      country: 'AR',
      services: [{ id: 'svc-a', weeklyHours: 20, authorizedHours: null }],
      slots: [
        {
          id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', endTime: '12:00', active: true,
          assignmentId: 'asg-old', workerId: 'w-old', applicationId: 'wja-0', validFrom: '2026-01-01', validTo: '2026-06-30', status: 'ENDED',
          firstNameEncrypted: 'old-f', lastNameEncrypted: 'old-l',
        },
        {
          id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', endTime: '12:00', active: true,
          assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
          firstNameEncrypted: 'f1', lastNameEncrypted: 'l1',
        },
      ],
    };
    const now = new Date('2026-09-27T15:00:00Z'); // asOf AR = 2026-09-27

    it('cells sem worker_contact:read → displayName null e 0 chamadas ao decrypt', async () => {
      const kms = kmsDouble();
      const result = await new GetPatientItineraryUseCase(readerWith(rowsComNome), kms).execute(PID, now, ['patient_services:read']);

      const assignments = result.services[0].slots[0].assignments;
      console.log('[12.9]', 'sem-celula', assignments.length, kms.decrypt.mock.calls.length);
      expect(kms.decrypt).toHaveBeenCalledTimes(0);
      expect(assignments.map((a) => [a.allocationId, a.displayName])).toEqual([
        ['asg-old', null],
        ['asg-1', null],
      ]);
    });

    it('alocação vigente com a célula → o nome (só a vigente decifra); cobertas IGUAL com e sem nome', async () => {
      const kms = kmsDouble();
      const comNome = await new GetPatientItineraryUseCase(readerWith(rowsComNome), kms).execute(PID, now, ['worker_contact:read']);
      const semNome = await new GetPatientItineraryUseCase(readerWith(rowsComNome), kmsDouble()).execute(PID, now, []);

      console.log('[12.9]', 'com-celula', kms.decrypt.mock.calls.length, comNome.services[0].cobertas);
      expect(comNome.services[0].slots[0].assignments.map((a) => [a.allocationId, a.displayName])).toEqual([
        ['asg-old', null],
        ['asg-1', 'dec:f1 dec:l1'],
      ]);
      expect(kms.decrypt.mock.calls.map((c) => c[0]).sort()).toEqual(['f1', 'l1']);
      expect(comNome.services[0].cobertas).toBe(4);
      expect(semNome.services[0].cobertas).toBe(comNome.services[0].cobertas);
    });

    it('cells omitido (engine OFF, null) → o nome aparece, como o quadro C', async () => {
      const result = await new GetPatientItineraryUseCase(readerWith(rowsComNome), kmsDouble()).execute(PID, now);

      expect(result.services[0].slots[0].assignments[1].displayName).toBe('dec:f1 dec:l1');
    });
  });

  it('leitor devolve null → PatientNotFoundForItineraryError com o patientId', async () => {
    const useCase = new GetPatientItineraryUseCase(readerWith(null), kmsDouble());

    await expect(useCase.execute(PID)).rejects.toBeInstanceOf(PatientNotFoundForItineraryError);
    await expect(useCase.execute(PID)).rejects.toMatchObject({ patientId: PID });
  });
});
