/**
 * ListKanbanServicesUseCase — fase 8, DX-8.5 / DX-8.17 (i).
 *
 * `reader` e `now` injetados (dublê puro, sem transação/banco): cobre o `asOf` pelo fuso do PAÍS de
 * CADA paciente (nunca o relógio do processo), o `cobertas` reusado de `buildServiceCoverages` (a
 * mesma conta da Fase 7 — esta classe não recalcula vigência), a lista vazia e a minimização da
 * saída (nenhum `slots`/`workerId`/`applicationId`).
 */
import { ListKanbanServicesUseCase, type KanbanServicesReaderPort } from '../ListKanbanServicesUseCase';
import type { KanbanServicesRows } from '../../infrastructure/PatientKanbanServicesReader';

function readerWith(rows: KanbanServicesRows[]): KanbanServicesReaderPort {
  return { readKanbanServices: jest.fn().mockResolvedValue(rows) };
}

/** Varredura recursiva: nenhuma chave do conjunto proibido pode aparecer em nenhum nível da saída. */
function assertNoForbiddenKeys(value: unknown, forbidden: readonly string[]): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    expect(forbidden).not.toContain(key);
    assertNoForbiddenKeys(nested, forbidden);
  }
}

describe('ListKanbanServicesUseCase', () => {
  it('1 paciente AR, 2 serviços: cobertas pela alocação vigente, liveVacancyId do serviço, serviço sem slot com cobertas 0', async () => {
    const rows: KanbanServicesRows[] = [
      {
        patientId: 'p-1',
        country: 'AR',
        services: [
          { id: 'svc-a', serviceCode: 'AT', weeklyHours: 20, authorizedHours: null, liveVacancyId: 'v' },
          { id: 'svc-b', serviceCode: 'FA', weeklyHours: null, authorizedHours: 10, liveVacancyId: null },
        ],
        slots: [
          // svc-a: slot seg 08-12 com alocação ACTIVE vigente (validFrom passado, sem fim).
          {
            id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', endTime: '12:00', active: true,
            assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
          },
          // svc-b: nenhuma linha de slot (serviço sem faixa nenhuma).
        ],
      },
    ];
    const useCase = new ListKanbanServicesUseCase(readerWith(rows));

    const result = await useCase.execute('AR', new Date('2026-09-27T15:00:00Z'));

    expect(result.patients).toHaveLength(1);
    expect(result.patients[0].patientId).toBe('p-1');
    expect(result.patients[0].asOf).toBe('2026-09-27');
    expect(result.patients[0].services[0]).toEqual({
      contractedServiceId: 'svc-a',
      serviceCode: 'AT',
      contratadas: { weekly: 20, authorized: null },
      cobertas: 4,
      liveVacancyId: 'v',
    });
    expect(result.patients[0].services[1].cobertas).toBe(0);
  });

  it('alocação ENDED não cobre: cobertas 0 mesmo com slot ativo', async () => {
    const rows: KanbanServicesRows[] = [
      {
        patientId: 'p-2',
        country: 'AR',
        services: [{ id: 'svc-a', serviceCode: 'AT', weeklyHours: 20, authorizedHours: null, liveVacancyId: 'v' }],
        slots: [
          {
            id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', endTime: '12:00', active: true,
            assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: '2026-09-10', status: 'ENDED',
          },
        ],
      },
    ];
    const useCase = new ListKanbanServicesUseCase(readerWith(rows));

    const result = await useCase.execute('AR', new Date('2026-09-27T15:00:00Z'));

    expect(result.patients[0].services[0].cobertas).toBe(0);
  });

  it('mesmo `now`, paciente BR e AR: asOf pelo fuso de CADA país (countryToTimezone, nunca o relógio do processo)', async () => {
    const rows: KanbanServicesRows[] = [
      { patientId: 'p-ar', country: 'AR', services: [], slots: [] },
      { patientId: 'p-br', country: 'BR', services: [], slots: [] },
    ];
    const useCase = new ListKanbanServicesUseCase(readerWith(rows));

    const result = await useCase.execute(null, new Date('2026-09-28T02:30:00Z'));

    expect(result.patients.find((p) => p.patientId === 'p-ar')?.asOf).toBe('2026-09-27');
    expect(result.patients.find((p) => p.patientId === 'p-br')?.asOf).toBe('2026-09-27');
  });

  it('leitor devolve [] → { patients: [] }', async () => {
    const useCase = new ListKanbanServicesUseCase(readerWith([]));

    const result = await useCase.execute('AR');

    expect(result).toEqual({ patients: [] });
  });

  it('a saída não carrega slots, workerId nem applicationId (minimização — o board não os mostra)', async () => {
    const rows: KanbanServicesRows[] = [
      {
        patientId: 'p-1',
        country: 'AR',
        services: [{ id: 'svc-a', serviceCode: 'AT', weeklyHours: 20, authorizedHours: null, liveVacancyId: 'v' }],
        slots: [
          {
            id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', endTime: '12:00', active: true,
            assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
          },
        ],
      },
    ];
    const useCase = new ListKanbanServicesUseCase(readerWith(rows));

    const result = await useCase.execute('AR', new Date('2026-09-27T15:00:00Z'));

    assertNoForbiddenKeys(result, ['slots', 'workerId', 'applicationId']);
  });
});
