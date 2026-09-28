/**
 * itineraryAssignmentView — Fase 12, P8 (DX-12.5 (2)). As linhas e os serviços passam pela MESMA
 * `buildServiceCoverages` de produção (nunca montados à mão), para que o pareamento por ordem seja
 * provado contra a ordem que ela realmente empilha. Ids sintéticos; nenhum nome real.
 */
import { withAssignmentIdentity, workerIdsToName } from '../itineraryAssignmentView';
import { buildServiceCoverages } from '../itineraryCoverage';
import type { ItineraryRows, ItinerarySlotRow } from '../../infrastructure/PatientItineraryReader';

const AS_OF = '2026-09-27';

function slotRow(over: Partial<ItinerarySlotRow> & { id: string }): ItinerarySlotRow {
  return {
    contractedServiceId: 'svc-a', weekday: 1, startTime: '08:00', endTime: '12:00', active: true,
    assignmentId: null, workerId: null, applicationId: null, validFrom: null, validTo: null, status: null,
    ...over,
  };
}

function alloc(id: string, slotId: string, workerId: string, over: Partial<ItinerarySlotRow> = {}): ItinerarySlotRow {
  return slotRow({
    id: slotId, assignmentId: id, workerId, applicationId: `wja-${id}`, validFrom: '2026-09-01', validTo: null, status: 'ACTIVE',
    firstNameEncrypted: `enc-first-${workerId}`, lastNameEncrypted: `enc-last-${workerId}`,
    ...over,
  });
}

function build(rows: Pick<ItineraryRows, 'services' | 'slots'>) {
  return buildServiceCoverages(rows, AS_OF);
}

describe('withAssignmentIdentity', () => {
  it('1 slot, ENDED antiga + ACTIVE vigente (ordem do leitor) → allocationId certo em cada uma, displayName só na vigente', () => {
    const rows = {
      services: [{ id: 'svc-a', weeklyHours: 4, authorizedHours: null }],
      slots: [
        alloc('asg-old', 's1', 'w-old', { validFrom: '2026-01-01', validTo: '2026-06-30', status: 'ENDED' }),
        alloc('asg-new', 's1', 'w-new'),
      ],
    };
    const names = new Map<string, string | null>([['w-old', 'Nome Antigo'], ['w-new', 'Nome Vigente']]);

    const view = withAssignmentIdentity(build(rows), rows.slots, AS_OF, names);

    const assignments = view[0].slots[0].assignments;
    console.log('[12.8]', 'assignments', assignments.length, assignments.filter((a) => a.displayName !== null).length);
    expect(assignments.map((a) => [a.allocationId, a.workerId, a.displayName])).toEqual([
      ['asg-old', 'w-old', null],
      ['asg-new', 'w-new', 'Nome Vigente'],
    ]);
    expect(view[0].cobertas).toBe(4);
  });

  it('slot sem alocação → assignments: []', () => {
    const rows = {
      services: [{ id: 'svc-a', weeklyHours: null, authorizedHours: null }],
      slots: [slotRow({ id: 's1' })],
    };

    const view = withAssignmentIdentity(build(rows), rows.slots, AS_OF, new Map());

    expect(view[0].slots).toHaveLength(1);
    expect(view[0].slots[0].assignments).toEqual([]);
  });

  it('2 serviços → cada allocationId no seu slot', () => {
    const rows = {
      services: [
        { id: 'svc-a', weeklyHours: null, authorizedHours: null },
        { id: 'svc-b', weeklyHours: null, authorizedHours: null },
      ],
      slots: [alloc('asg-a', 's-a', 'w-1'), alloc('asg-b', 's-b', 'w-2', { contractedServiceId: 'svc-b' })],
    };

    const view = withAssignmentIdentity(build(rows), rows.slots, AS_OF, new Map([['w-1', 'Uno'], ['w-2', 'Dos']]));

    expect(view.map((s) => [s.contractedServiceId, s.slots[0].id, s.slots[0].assignments[0].allocationId])).toEqual([
      ['svc-a', 's-a', 'asg-a'],
      ['svc-b', 's-b', 'asg-b'],
    ]);
  });

  it('vigente sem nome no mapa (célula negada / sem fonte) → displayName null', () => {
    const rows = { services: [{ id: 'svc-a', weeklyHours: null, authorizedHours: null }], slots: [alloc('asg-1', 's1', 'w-1')] };

    const view = withAssignmentIdentity(build(rows), rows.slots, AS_OF, new Map());

    expect(view[0].slots[0].assignments[0]).toMatchObject({ allocationId: 'asg-1', displayName: null });
  });

  it('contagem divergente (linha a mais no mesmo slot) → lança, nunca pareia errado', () => {
    const rows = { services: [{ id: 'svc-a', weeklyHours: null, authorizedHours: null }], slots: [alloc('asg-1', 's1', 'w-1')] };
    const services = build(rows);

    expect(() => withAssignmentIdentity(services, [...rows.slots, alloc('asg-extra', 's1', 'w-9')], AS_OF, new Map())).toThrow(
      'itinerary assignment pairing mismatch',
    );
  });

  it('mesma contagem, prestador trocado na posição → lança', () => {
    const rows = { services: [{ id: 'svc-a', weeklyHours: null, authorizedHours: null }], slots: [alloc('asg-1', 's1', 'w-1')] };
    const services = build(rows);

    expect(() => withAssignmentIdentity(services, [alloc('asg-1', 's1', 'w-outro')], AS_OF, new Map())).toThrow(
      'itinerary assignment pairing mismatch',
    );
  });

  it('asOf no limite: validTo === asOf → vigente (nome); validFrom > asOf → não', () => {
    const rows = {
      services: [{ id: 'svc-a', weeklyHours: null, authorizedHours: null }],
      slots: [
        alloc('asg-fim-hoje', 's1', 'w-1', { validTo: AS_OF }),
        alloc('asg-futura', 's2', 'w-2', { validFrom: '2026-09-28' }),
      ],
    };

    const view = withAssignmentIdentity(build(rows), rows.slots, AS_OF, new Map([['w-1', 'Uno'], ['w-2', 'Dos']]));

    expect(view[0].slots.map((s) => s.assignments[0].displayName)).toEqual(['Uno', null]);
  });
});

describe('workerIdsToName', () => {
  it('só os vigentes, sem repetição, com a fonte cifrada; serviço fora da lista e linha sem alocação não entram', () => {
    const rows = {
      services: [{ id: 'svc-a', weeklyHours: null, authorizedHours: null }],
      slots: [
        slotRow({ id: 's0' }),
        alloc('asg-1', 's1', 'w-1'),
        alloc('asg-2', 's2', 'w-1'),
        alloc('asg-3', 's3', 'w-ended', { validTo: '2026-09-26', status: 'ENDED' }),
        alloc('asg-4', 's4', 'w-2', { firstNameEncrypted: undefined, lastNameEncrypted: undefined }),
        alloc('asg-5', 's-inativo', 'w-inativo', { contractedServiceId: 'svc-inativo' }),
      ],
    };
    const services = build(rows);

    const sources = workerIdsToName(rows.slots, services, AS_OF);

    console.log('[12.8]', 'workerIdsToName', sources.size);
    expect([...sources.entries()]).toEqual([
      ['w-1', { firstNameEncrypted: 'enc-first-w-1', lastNameEncrypted: 'enc-last-w-1' }],
      ['w-2', { firstNameEncrypted: null, lastNameEncrypted: null }],
    ]);
  });

  it('validFrom > asOf → fora; validTo === asOf → dentro', () => {
    const rows = {
      services: [{ id: 'svc-a', weeklyHours: null, authorizedHours: null }],
      slots: [alloc('asg-1', 's1', 'w-futuro', { validFrom: '2026-09-28' }), alloc('asg-2', 's2', 'w-hoje', { validTo: AS_OF })],
    };

    expect([...workerIdsToName(rows.slots, build(rows), AS_OF).keys()]).toEqual(['w-hoje']);
  });
});
