import { ServiceHoursSummaryReader } from '../ServiceHoursSummaryReader';
import type { KanbanServicesRows } from '../PatientKanbanServicesReader';

const NOW = new Date('2026-10-14T15:00:00Z'); // AR/BR: 2026-10-14

function slot(id: string, svc: string, minutes: number, assigned: boolean) {
  return {
    id, contractedServiceId: svc, weekday: 1, startTime: '08:00', durationMinutes: minutes, endTime: '12:00',
    assignmentId: assigned ? `a-${id}` : null, workerId: assigned ? 'w1' : null,
    applicationId: assigned ? 'ap1' : null, validFrom: assigned ? '2026-10-01' : null, validTo: null,
    status: assigned ? ('ACTIVE' as const) : (null as never),
  };
}

function patient(country: string, services: Array<{ id: string; live: string | null }>, slots: ReturnType<typeof slot>[]): KanbanServicesRows {
  return {
    patientId: `p-${services[0].id}`, country,
    services: services.map((s) => ({ id: s.id, serviceCode: 'AT', liveVacancyId: s.live })),
    slots,
  };
}

describe('ServiceHoursSummaryReader', () => {
  it('soma total/cobertas só de serviço com vaga viva e conta com/sem horário', async () => {
    const reader = {
      readKanbanServices: jest.fn(async (country: 'AR' | 'BR' | null) =>
        country === 'AR'
          ? [
              patient('AR', [{ id: 's1', live: 'v1' }, { id: 's2', live: 'v2' }, { id: 's3', live: null }], [
                slot('x1', 's1', 1200, true), // 20h coberta
                slot('x2', 's1', 1200, false), // 20h descoberta
                slot('x3', 's3', 600, true), // sem vaga viva: fora
              ]),
            ]
          : [],
      ),
    };
    const out = await new ServiceHoursSummaryReader(reader).readServiceHours(['AR', 'BR'], NOW);
    expect(out).toEqual({ total: 40, cobertas: 20, servicesWithSchedule: 1, servicesWithoutSchedule: 1 });
    expect(reader.readKanbanServices).toHaveBeenCalledTimes(2);
    expect(reader.readKanbanServices).toHaveBeenCalledWith('AR');
    expect(reader.readKanbanServices).toHaveBeenCalledWith('BR');
  });

  it('sem países → tudo zero e nenhuma leitura', async () => {
    const reader = { readKanbanServices: jest.fn() };
    const out = await new ServiceHoursSummaryReader(reader).readServiceHours([], NOW);
    expect(out).toEqual({ total: 0, cobertas: 0, servicesWithSchedule: 0, servicesWithoutSchedule: 0 });
    expect(reader.readKanbanServices).not.toHaveBeenCalled();
  });
});
