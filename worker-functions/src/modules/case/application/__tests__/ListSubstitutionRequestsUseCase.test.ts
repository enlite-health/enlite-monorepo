/**
 * ListSubstitutionRequestsUseCase — spec 069, FR-20/US6. Reader injetado: o que se prova é o filtro Próximas × Pasadas, a ordem,
 * as linhas "Sin pedido (anterior)", o nome pela projeção de célula e que o "hoje" é o do país.
 */
import { ListSubstitutionRequestsUseCase } from '../ListSubstitutionRequestsUseCase';
import { SubstitutionServiceNotFoundError } from '../substitutionRequestErrors';
import type { ServiceRequestRows, RequestScopedAbsence } from '../../infrastructure/SubstitutionRequestReader';

const CLIENT = { marker: 'client' } as never;
const runInTransaction = (async (fn: (c: never) => Promise<unknown>) => fn(CLIENT)) as never;
const kms = () => ({ decrypt: jest.fn(async (v: string) => `dec:${v}`) });
const NOW = new Date('2026-10-30T15:00:00Z'); // hoje (AR) = 2026-10-30

function absence(o: Partial<RequestScopedAbsence> & { onDate: string }): RequestScopedAbsence {
  return {
    absenceId: `ab-${o.onDate}`, assignmentId: 'a-1', requestId: 'r-1', startTime: '08:00', endTime: '12:00', substituteWorkerId: 'w-sub',
    cancelledAt: null, assignmentStatus: 'ACTIVE', assignmentValidTo: null, titularWorkerId: 'w-out', ...o,
  };
}

function header(id: string, o: Partial<ServiceRequestRows['headers'][number]> = {}) {
  return { id, outgoingWorkerId: 'w-out', reasonCode: 'OTHER', createdAt: '2026-10-28T10:00:00Z', createdBy: 'u-1', undoneAt: null, undoneBy: null, ...o };
}

const names = [
  { workerId: 'w-out', firstNameEncrypted: 'fo', lastNameEncrypted: 'lo' },
  { workerId: 'w-sub', firstNameEncrypted: 'fs', lastNameEncrypted: 'ls' },
];

function rows(o: Partial<ServiceRequestRows> = {}): ServiceRequestRows {
  return {
    country: 'AR',
    headers: [header('r-late'), header('r-soon'), header('r-old')],
    absences: [
      absence({ requestId: 'r-late', onDate: '2026-11-20' }),
      absence({ requestId: 'r-soon', onDate: '2026-11-03' }),
      absence({ requestId: 'r-old', onDate: '2026-10-05' }),
      absence({ requestId: null, onDate: '2026-11-10', absenceId: 'ab-legacy' }), // anterior à 548, viva
      absence({ requestId: null, onDate: '2026-11-11', absenceId: 'ab-legacy-cancelada', cancelledAt: '2026-10-29T00:00:00Z' }), // cancelada: não aparece
    ],
    logRows: [],
    newAssignments: [],
    workerNames: names,
    ...o,
  };
}

function build(r: ServiceRequestRows | null, k = kms()) {
  const reader = { readForServiceWith: jest.fn(async () => r) };
  return { useCase: new ListSubstitutionRequestsUseCase(reader, k, runInTransaction), reader, k };
}

describe('ListSubstitutionRequestsUseCase', () => {
  it('Próximas: ordem pela data mais próxima, inclui a linha "Sin pedido (anterior)" viva e NÃO a cancelada; nomes pela célula', async () => {
    const { useCase } = build(rows());
    const result = await useCase.execute({ patientId: 'p', serviceId: 's', when: 'upcoming', cells: ['worker_contact:read'], now: NOW });

    expect(result.requests.map((r) => [r.requestId, r.from, r.legacy])).toEqual([
      ['r-soon', '2026-11-03', false],
      [null, '2026-11-10', true],
      ['r-late', '2026-11-20', false],
    ]);
    const soon = result.requests[0];
    expect(soon).toMatchObject({ outgoingDisplayName: 'dec:fo dec:lo', entraDisplayNames: ['dec:fs dec:ls'], shiftDisplayNames: ['dec:fs dec:ls'], type: 'ONE_DAY', undoable: true });
    const legacy = result.requests[1];
    expect(legacy).toMatchObject({ reasonCode: null, undoable: false, outgoingWorkerId: 'w-out' });
  });

  it('Pasadas: a mais recente primeiro; sem "Deshacer"', async () => {
    const r = rows({ headers: [header('r-old'), header('r-older')], absences: [absence({ requestId: 'r-old', onDate: '2026-10-05' }), absence({ requestId: 'r-older', onDate: '2026-09-01' })] });
    const result = await build(r).useCase.execute({ patientId: 'p', serviceId: 's', when: 'past', now: NOW });
    expect(result.requests.map((x) => [x.requestId, x.undoable])).toEqual([['r-old', false], ['r-older', false]]);
    expect(result.when).toBe('past');
  });

  it('o "hoje" é o do país (fuso): 2026-11-03T02:30Z ainda é 02/11 — um pedido de 02/11 é Próximas', async () => {
    const madrugada = new Date('2026-11-03T02:30:00Z');
    expect(madrugada.toISOString().slice(0, 10)).toBe('2026-11-03'); // sanidade
    const r = rows({ headers: [header('r-1')], absences: [absence({ requestId: 'r-1', onDate: '2026-11-02' })] });
    const upcoming = await build(r).useCase.execute({ patientId: 'p', serviceId: 's', when: 'upcoming', now: madrugada });
    expect(upcoming.requests.map((x) => x.requestId)).toEqual(['r-1']);
  });

  it('SEM a célula: nenhum decrypt e todos os nomes null (a lista continua inteira)', async () => {
    const k = kms();
    const result = await build(rows(), k).useCase.execute({ patientId: 'p', serviceId: 's', when: 'upcoming', cells: ['patient_services:read'], now: NOW });
    expect(k.decrypt).not.toHaveBeenCalled();
    expect(result.requests[0]).toMatchObject({ outgoingDisplayName: null, entraDisplayNames: [null], shiftDisplayNames: [null] });
    expect(result.requests).toHaveLength(3);
  });

  it('"Nadie todavía": turno sem substituto → nome do turno null, entra.kind NOBODY', async () => {
    const r = rows({ headers: [header('r-1')], absences: [absence({ requestId: 'r-1', onDate: '2026-11-03', substituteWorkerId: null })] });
    const result = await build(r).useCase.execute({ patientId: 'p', serviceId: 's', when: 'upcoming', cells: null, now: NOW });
    expect(result.requests[0].entra.kind).toBe('NOBODY');
    expect(result.requests[0].shiftDisplayNames).toEqual([null]);
  });

  it('pedido permanente: os registros do log e a alocação nova entram na descrição', async () => {
    const r = rows({
      headers: [header('r-perm')],
      absences: [],
      logRows: [{ requestId: 'r-perm', kind: 'REPLACE', assignmentId: 'a-1', newAssignmentId: 'n-1', effectiveDate: '2026-11-20' }],
      newAssignments: [{ assignmentId: 'n-1', workerId: 'w-sub', status: 'ACTIVE' }],
    });
    const result = await build(r).useCase.execute({ patientId: 'p', serviceId: 's', when: 'upcoming', cells: ['worker_contact:read'], now: NOW });
    expect(result.requests[0]).toMatchObject({ type: 'PERMANENT', from: '2026-11-20', entraDisplayNames: ['dec:fs dec:ls'] });
  });

  it('log de OUTRO pedido não contamina; serviço inexistente → SubstitutionServiceNotFoundError; construtor e `now`/`cells` omitidos usam o padrão', async () => {
    const r = rows({
      headers: [header('r-1')],
      absences: [absence({ requestId: 'r-1', onDate: '2999-01-01' })],
      logRows: [{ requestId: 'outro', kind: 'REMOVE', assignmentId: 'a-9', newAssignmentId: null, effectiveDate: '2026-11-20' }],
    });
    const result = await build(r).useCase.execute({ patientId: 'p', serviceId: 's', when: 'upcoming' });
    expect(result.requests[0].type).toBe('ONE_DAY');

    await expect(build(null).useCase.execute({ patientId: 'p', serviceId: 's', when: 'upcoming' })).rejects.toThrow(SubstitutionServiceNotFoundError);
    expect(() => new ListSubstitutionRequestsUseCase()).not.toThrow();
  });
});
