/**
 * itineraryCoverage — régua da extração pura (DX-8.3). Mesmo comportamento de
 * `GetPatientItineraryUseCase.ts:57-64,73-128` antes da extração, testado direto no helper.
 */
import { operationDateOf, buildServiceCoverages } from '../itineraryCoverage';
import type { ItineraryRows } from '../../infrastructure/PatientItineraryReader';
import { operationDateOf as donoDoHoje, UnknownCountryError } from '@shared/locale/operationDate';

describe('operationDateOf', () => {
  it('AR: 02:30Z ainda é dia 27 em Buenos Aires', () => {
    expect(operationDateOf('AR', new Date('2026-09-28T02:30:00Z'))).toBe('2026-09-27');
  });

  it('a virada: 03:30Z já é dia 28 em Buenos Aires', () => {
    expect(operationDateOf('AR', new Date('2026-09-28T03:30:00Z'))).toBe('2026-09-28');
  });

  it('é a MESMA função do dono (re-export, não cópia)', () => {
    expect(operationDateOf).toBe(donoDoHoje);
  });

  it('país desconhecido lança UnknownCountryError (nunca cai em UTC)', () => {
    expect(() => operationDateOf('XX', new Date('2026-10-19T01:30:00Z'))).toThrow(UnknownCountryError);
  });
});

describe('buildServiceCoverages', () => {
  it('2 serviços — um com slot + alocação vigente de 08-12, outro sem slot: cobertas 4 e 0, ordem de rows.services', () => {
    const rows: Pick<ItineraryRows, 'services' | 'slots'> = {
      services: [
        { id: 'svc-a' },
        { id: 'svc-b', },
      ],
      slots: [
        {
          id: 's1', contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', durationMinutes: 240, endTime: '12:00',
          assignmentId: 'asg-1', workerId: 'w-1', applicationId: 'wja-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
        },
      ],
    };

    const services = buildServiceCoverages(rows, '2026-09-27');

    expect(services).toHaveLength(2);
    expect(services[0]).toMatchObject({ contractedServiceId: 'svc-a', scheduleHours: 4, cobertas: 4 });
    expect(services[1]).toMatchObject({ contractedServiceId: 'svc-b', scheduleHours: 0, cobertas: 0 });
    expect(services[1].slots).toEqual([]);
  });
});

describe('buildServiceCoverages — providersNeeded', () => {
  it('providersNeeded: 3 → 3, NULL → null, ausente → null (nunca 1)', () => {
    const rows: Pick<ItineraryRows, 'services' | 'slots'> = {
      services: [{ id: 'a', providersNeeded: 3 }, { id: 'b', providersNeeded: null }, { id: 'c' }],
      slots: [],
    };
    const services = buildServiceCoverages(rows, '2026-09-28');
    expect(services.map((s) => s.providersNeeded)).toEqual([3, null, null]);
  });
});
