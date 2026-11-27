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

/** Dublê do leitor do quadro C (056 §9): nenhum serviço com equipe. */
const noTeam = { readMany: jest.fn().mockResolvedValue([]) };

/** Dublê do leitor do semáforo (semaforo-da-vaga F2): nenhuma vaga medida. */
const noSemaphores = { readMany: jest.fn().mockResolvedValue(new Map<string, number>()) };

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
        country: 'AR', assembled: true,
        services: [
          { id: 'svc-a', serviceCode: 'AT', liveVacancyId: 'v' },
          { id: 'svc-b', serviceCode: 'FA', liveVacancyId: null },
        ],
        slots: [
          // svc-a: slot seg 08-12 com alocação ACTIVE vigente (validFrom passado, sem fim).
          {
            id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', durationMinutes: 240, endTime: '12:00',
            assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
          },
          // svc-b: nenhuma linha de slot (serviço sem faixa nenhuma).
        ],
      },
    ];
    const useCase = new ListKanbanServicesUseCase(readerWith(rows), noTeam, noSemaphores);

    const result = await useCase.execute(['AR'], new Date('2026-09-27T15:00:00Z'));

    expect(result.patients).toHaveLength(1);
    expect(result.patients[0].patientId).toBe('p-1');
    expect(result.patients[0].asOf).toBe('2026-09-27');
    expect(result.patients[0].services[0]).toEqual({
      contractedServiceId: 'svc-a',
      serviceCode: 'AT',
      scheduleHours: 4,
      cobertas: 4,
      liveVacancyId: 'v',
      uncoveredDays: 0,
      reserve: null,
      semaphore: null, // vaga viva sem `n` medido = não medido, nunca vermelho
    });
    expect(result.patients[0].services[1].cobertas).toBe(0);
  });

  it('alocação ENDED não cobre: cobertas 0 mesmo com slot ativo', async () => {
    const rows: KanbanServicesRows[] = [
      {
        patientId: 'p-2',
        country: 'AR', assembled: true,
        services: [{ id: 'svc-a', serviceCode: 'AT', liveVacancyId: 'v' }],
        slots: [
          {
            id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', durationMinutes: 240, endTime: '12:00',
            assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: '2026-09-10', status: 'ENDED',
          },
        ],
      },
    ];
    const useCase = new ListKanbanServicesUseCase(readerWith(rows), noTeam, noSemaphores);

    const result = await useCase.execute(['AR'], new Date('2026-09-27T15:00:00Z'));

    expect(result.patients[0].services[0].cobertas).toBe(0);
  });

  it('uncoveredDays: 2 ausências futuras do serviço S1 e 1 passada → S1 2, S2 0; cobertas IGUAL com ou sem ausência', async () => {
    const asOf = new Date('2026-09-27T15:00:00Z'); // asOf AR = 2026-09-27
    const baseRows: KanbanServicesRows[] = [
      {
        patientId: 'p-1',
        country: 'AR', assembled: true,
        services: [
          { id: 'svc-1', serviceCode: 'AT', liveVacancyId: null },
          { id: 'svc-2', serviceCode: 'FA', liveVacancyId: null },
        ],
        slots: [
          {
            id: 's1', contractedServiceId: 'svc-1', weekday: 1, startTime: '08:00', durationMinutes: 240, endTime: '12:00',
            assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
          },
        ],
      },
    ];

    const semAusencia = new ListKanbanServicesUseCase(readerWith(baseRows), noTeam, noSemaphores);
    const resultSemAusencia = await semAusencia.execute(['AR'], asOf);

    const comAusencia = new ListKanbanServicesUseCase(
      readerWith([
        {
          ...baseRows[0],
          // 2026-09-27 = domingo (hoje), 28 = segunda, 26 = sábado (ontem). Faixas de svc-1 com alocação do titular em cada dia.
          occurrences: {
            slots: [
              { slotId: 'sd', serviceId: 'svc-1', weekday: 0, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null },
              { slotId: 'sm', serviceId: 'svc-1', weekday: 1, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null },
              { slotId: 'ss', serviceId: 'svc-1', weekday: 6, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null },
            ],
            assignments: ['sd', 'sm', 'ss'].map((slotId) => ({ assignmentId: `a-${slotId}`, slotId, workerId: 'w-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' as const })),
            absences: [
              { absenceId: 'x1', assignmentId: 'a-sd', onDate: '2026-09-27', substituteWorkerId: null, requestId: 'r' }, // hoje
              { absenceId: 'x2', assignmentId: 'a-sm', onDate: '2026-09-28', substituteWorkerId: null, requestId: 'r' }, // futura
              { absenceId: 'x3', assignmentId: 'a-ss', onDate: '2026-09-26', substituteWorkerId: null, requestId: 'r' }, // passada — não conta
            ],
          },
        },
      ]),
      noTeam,
    );
    const resultComAusencia = await comAusencia.execute(['AR'], asOf);

    const s1SemAusencia = resultSemAusencia.patients[0].services.find((s) => s.contractedServiceId === 'svc-1')!;
    const s2SemAusencia = resultSemAusencia.patients[0].services.find((s) => s.contractedServiceId === 'svc-2')!;
    const s1ComAusencia = resultComAusencia.patients[0].services.find((s) => s.contractedServiceId === 'svc-1')!;
    const s2ComAusencia = resultComAusencia.patients[0].services.find((s) => s.contractedServiceId === 'svc-2')!;

    expect(s1SemAusencia.uncoveredDays).toBe(0);
    expect(s1ComAusencia.uncoveredDays).toBe(2);
    expect(s2ComAusencia.uncoveredDays).toBe(0);
    expect(s1ComAusencia.cobertas).toBe(s1SemAusencia.cobertas);
    expect(s2ComAusencia.cobertas).toBe(s2SemAusencia.cobertas);
  });

  it('achado L2 (veredito parcial-1): 2 faixas descobertas no MESMO dia do MESMO serviço → uncoveredDays 1, não 2', async () => {
    const asOf = new Date('2026-09-27T15:00:00Z'); // asOf AR = 2026-09-27
    const rows: KanbanServicesRows[] = [
      {
        patientId: 'p-1',
        country: 'AR', assembled: true,
        services: [{ id: 'svc-1', serviceCode: 'AT', liveVacancyId: null }],
        slots: [
          {
            id: 's1', contractedServiceId: 'svc-1', weekday: 1, startTime: '08:00', durationMinutes: 240, endTime: '12:00',
            assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
          },
        ],
        occurrences: {
          // 2026-09-28 = segunda: duas faixas do MESMO serviço, sem ninguém (FR-12) — 1 dia, 2 turnos
          slots: [
            { slotId: 'f1', serviceId: 'svc-1', weekday: 1, startTime: '08:00', endTime: '10:00', validFrom: '2026-01-01', validTo: null },
            { slotId: 'f2', serviceId: 'svc-1', weekday: 1, startTime: '14:00', endTime: '16:00', validFrom: '2026-01-01', validTo: null },
          ],
          assignments: [],
          absences: [],
        },
      },
    ];
    const useCase = new ListKanbanServicesUseCase(readerWith(rows), noTeam, noSemaphores);

    const result = await useCase.execute(['AR'], asOf);

    expect(result.patients[0].services[0].uncoveredDays).toBe(1);
  });

  it('universo P13: itinerário NÃO montado → uncoveredDays 0 mesmo com faixas sem ninguém; montado, a MESMA entrada conta', async () => {
    const asOf = new Date('2026-09-27T15:00:00Z'); // domingo; janela 27/09 … 03/10
    const faixa = (slotId: string, weekday: number) => ({ slotId, serviceId: 'svc-1', weekday, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null });
    const linha = (assembled: boolean | undefined): KanbanServicesRows => ({
      patientId: 'p-1',
      country: 'AR',
      ...(assembled === undefined ? {} : { assembled }),
      services: [{ id: 'svc-1', serviceCode: 'AT', liveVacancyId: null }],
      slots: [],
      occurrences: { slots: [faixa('dom', 0), faixa('sab', 6)], assignments: [], absences: [] },
    });
    const dias = async (assembled: boolean | undefined) =>
      (await new ListKanbanServicesUseCase(readerWith([linha(assembled)]), noTeam, noSemaphores).execute(['AR'], asOf)).patients[0].services[0].uncoveredDays;

    expect(await dias(false)).toBe(0);
    expect(await dias(undefined)).toBe(0); // ausente = não montado
    expect(await dias(true)).toBe(2); // controle positivo
  });

  it('universo P13: montado mas em estado manual travado (ON_HOLD) → uncoveredDays 0; o mesmo paciente ACTIVE conta (controle positivo)', async () => {
    const asOf = new Date('2026-09-27T15:00:00Z');
    const faixa = (slotId: string, weekday: number) => ({ slotId, serviceId: 'svc-1', weekday, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null });
    const linha = (patientStatus: string): KanbanServicesRows => ({
      patientId: 'p-1', country: 'AR', assembled: true, patientStatus,
      services: [{ id: 'svc-1', serviceCode: 'AT', liveVacancyId: null }],
      slots: [],
      occurrences: { slots: [faixa('dom', 0), faixa('sab', 6)], assignments: [], absences: [] },
    });
    const dias = async (st: string) => (await new ListKanbanServicesUseCase(readerWith([linha(st)]), noTeam, noSemaphores).execute(['AR'], asOf)).patients[0].services[0].uncoveredDays;
    expect(await dias('ON_HOLD')).toBe(0);
    expect(await dias('ACTIVE')).toBe(2);
  });

  it('P7: o horizonte é [hoje, hoje+6] — a segunda-feira de hoje+8 não conta; faixa sem alocação conta (FR-12)', async () => {
    const asOf = new Date('2026-09-27T15:00:00Z'); // domingo; janela 27/09 … 03/10
    const faixa = (slotId: string, weekday: number) => ({ slotId, serviceId: 'svc-1', weekday, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null });
    const rows: KanbanServicesRows[] = [
      {
        patientId: 'p-1',
        country: 'AR', assembled: true,
        services: [{ id: 'svc-1', serviceCode: 'AT', liveVacancyId: null }],
        slots: [],
        occurrences: { slots: [faixa('dom', 0), faixa('sab', 6)], assignments: [], absences: [] }, // dom 27 e sáb 03/10 (hoje+6): 2 dias; dom 04/10 (hoje+7): fora
      },
    ];

    const result = await new ListKanbanServicesUseCase(readerWith(rows), noTeam, noSemaphores).execute(['AR'], asOf);

    expect(result.patients[0].services[0].uncoveredDays).toBe(2);
  });

  it('mesmo `now`, paciente BR e AR: asOf pelo fuso de CADA país (countryToTimezone, nunca o relógio do processo)', async () => {
    const rows: KanbanServicesRows[] = [
      { patientId: 'p-ar', country: 'AR', assembled: true, services: [], slots: [] },
      { patientId: 'p-br', country: 'BR', assembled: true, services: [], slots: [] },
    ];
    const useCase = new ListKanbanServicesUseCase(readerWith(rows), noTeam, noSemaphores);

    const result = await useCase.execute(['AR', 'BR'], new Date('2026-09-28T02:30:00Z'));

    expect(result.patients.find((p) => p.patientId === 'p-ar')?.asOf).toBe('2026-09-27');
    expect(result.patients.find((p) => p.patientId === 'p-br')?.asOf).toBe('2026-09-27');
  });

  it('leitor devolve [] → { patients: [] }', async () => {
    const useCase = new ListKanbanServicesUseCase(readerWith([]), noTeam, noSemaphores);

    const result = await useCase.execute(['AR']);

    expect(result).toEqual({ patients: [] });
  });

  it('a saída não carrega slots, workerId nem applicationId (minimização — o board não os mostra)', async () => {
    const rows: KanbanServicesRows[] = [
      {
        patientId: 'p-1',
        country: 'AR', assembled: true,
        services: [{ id: 'svc-a', serviceCode: 'AT', liveVacancyId: 'v' }],
        slots: [
          {
            id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', durationMinutes: 240, endTime: '12:00',
            assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
          },
        ],
      },
    ];
    const useCase = new ListKanbanServicesUseCase(readerWith(rows), noTeam, noSemaphores);

    const result = await useCase.execute(['AR'], new Date('2026-09-27T15:00:00Z'));

    assertNoForbiddenKeys(result, ['slots', 'workerId', 'applicationId']);
  });

  it('056 §9: reserve só dos serviços com vaga viva (leitura em lote só deles); sem vaga viva → null', async () => {
    const rows: KanbanServicesRows[] = [
      { patientId: 'p-1', country: 'AR', assembled: true, services: [{ id: 'svc-a', serviceCode: 'AT', liveVacancyId: 'v-a' }, { id: 'svc-b', serviceCode: 'FA', liveVacancyId: null }], slots: [] },
    ];
    const teamReader = {
      readMany: jest.fn().mockResolvedValue([
        {
          serviceId: 'svc-a', country: 'AR', assembled: true, liveVacancyId: 'v-a',
          candidacies: [
            { workerId: 'w1', vacancyId: 'v-a', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null },
            { workerId: 'w2', vacancyId: 'v-a', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null },
            { workerId: 'w3', vacancyId: 'v-a', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null },
          ],
          assignments: [],
          marks: [{ workerId: 'w3', serviceId: 'svc-a', rejectReasonCategory: 'OTHER', firstNameEncrypted: null, lastNameEncrypted: null }],
        },
      ]),
    };

    const result = await new ListKanbanServicesUseCase(readerWith(rows), teamReader, noSemaphores).execute(['AR'], new Date('2026-09-27T15:00:00Z'));

    expect(teamReader.readMany).toHaveBeenCalledWith(['svc-a']);
    expect(result.patients[0].services.map((sv) => [sv.contractedServiceId, sv.reserve])).toEqual([
      ['svc-a', { count: 2, minimum: 10 }],
      ['svc-b', null],
    ]);
  });

  describe('semáforo da vaga (semaforo-da-vaga F2, P1)', () => {
    const svc = (id: string, vac: string | null) => ({ id, serviceCode: 'AT', liveVacancyId: vac });
    const patient = (patientId: string, services: ReturnType<typeof svc>[]): KanbanServicesRows =>
      ({ patientId, country: 'AR', assembled: true, services, slots: [] });
    const asOf = new Date('2026-09-27T15:00:00Z');
    const semaphoresWith = (n: Record<string, number>) => ({ readMany: jest.fn().mockResolvedValue(new Map(Object.entries(n))) });

    it('lê o `n` por serviço pela porta, a cor sai do dono e o pior do paciente é a mais grave', async () => {
      const rows = [patient('p-1', [svc('a', 'va'), svc('b', 'vb')]), patient('p-2', [svc('c', 'vc'), svc('d', null)])];
      const useCase = new ListKanbanServicesUseCase(readerWith(rows), noTeam, semaphoresWith({ va: 4, vb: 10, vc: 7 }));
      const { patients } = await useCase.execute(['AR'], asOf);
      expect(patients[0].services.map((s) => s.semaphore)).toEqual([{ n: 4, color: 'red' }, { n: 10, color: 'green' }]);
      expect(patients[0].worstSemaphore).toBe('red');
      expect(patients[1].services.map((s) => s.semaphore)).toEqual([{ n: 7, color: 'yellow' }, null]);
      expect(patients[1].worstSemaphore).toBe('yellow');
    });

    it('paciente sem nenhum serviço com vaga viva: worstSemaphore null', async () => {
      const useCase = new ListKanbanServicesUseCase(readerWith([patient('p-1', [svc('a', null)])]), noTeam, semaphoresWith({}));
      const { patients } = await useCase.execute(['AR'], asOf);
      expect(patients[0].services[0].semaphore).toBeNull();
      expect(patients[0].worstSemaphore).toBeNull();
    });

    it('sem N+1: UMA chamada a readMany para 1 serviço e UMA para 3 (a mesma contagem)', async () => {
      const um = semaphoresWith({ va: 1 });
      await new ListKanbanServicesUseCase(readerWith([patient('p-1', [svc('a', 'va')])]), noTeam, um).execute(['AR'], asOf);
      expect(um.readMany).toHaveBeenCalledTimes(1);
      expect(um.readMany).toHaveBeenCalledWith(['va']);

      const tres = semaphoresWith({ va: 1, vb: 2, vc: 3 });
      const rows = [patient('p-1', [svc('a', 'va'), svc('b', 'vb')]), patient('p-2', [svc('c', 'vc')])];
      await new ListKanbanServicesUseCase(readerWith(rows), noTeam, tres).execute(['AR'], asOf);
      expect(tres.readMany).toHaveBeenCalledTimes(1);
      expect(tres.readMany).toHaveBeenCalledWith(['va', 'vb', 'vc']);
    });
  });
});
