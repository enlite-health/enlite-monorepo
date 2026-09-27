/**
 * itineraryCoverage — régua da extração pura (DX-8.3). Mesmo comportamento de
 * `GetPatientItineraryUseCase.ts:57-64,73-128` antes da extração, testado direto no helper.
 */
import { operationDateOf, buildServiceCoverages } from '../itineraryCoverage';
import type { ItineraryRows } from '../../infrastructure/PatientItineraryReader';

describe('operationDateOf', () => {
  it('AR: 02:30Z ainda é dia 27 em Buenos Aires', () => {
    expect(operationDateOf('AR', new Date('2026-09-28T02:30:00Z'))).toBe('2026-09-27');
  });

  it('a virada: 03:30Z já é dia 28 em Buenos Aires', () => {
    expect(operationDateOf('AR', new Date('2026-09-28T03:30:00Z'))).toBe('2026-09-28');
  });
});

describe('buildServiceCoverages', () => {
  it('2 serviços — um com slot + alocação vigente de 08-12, outro sem slot: cobertas 4 e 0, ordem de rows.services', () => {
    const rows: Pick<ItineraryRows, 'services' | 'slots'> = {
      services: [
        { id: 'svc-a', weeklyHours: 20, authorizedHours: null },
        { id: 'svc-b', weeklyHours: null, authorizedHours: 10 },
      ],
      slots: [
        {
          id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', endTime: '12:00', active: true,
          assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
        },
      ],
    };

    const services = buildServiceCoverages(rows, '2026-09-27');

    expect(services).toHaveLength(2);
    expect(services[0]).toMatchObject({ contractedServiceId: 'svc-a', contratadas: { weekly: 20, authorized: null }, cobertas: 4 });
    expect(services[1]).toMatchObject({ contractedServiceId: 'svc-b', contratadas: { weekly: null, authorized: 10 }, cobertas: 0 });
    expect(services[1].slots).toEqual([]);
  });
});
