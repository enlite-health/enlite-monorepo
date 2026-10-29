/**
 * AssignSubstitutionCoverUseCase — spec 069, FR-20 "Elegir quién entra" (T305). Portas injetadas: prova a seleção do que cobrir
 * (só o futuro e só o que está sem ninguém), o REPLACE ligado (request_id, titular, nova alocação, destino do REMOVE) e os erros.
 */
import { AssignSubstitutionCoverUseCase } from '../AssignSubstitutionCoverUseCase';
import { AllocationNotFoundError, AlreadyAllocatedInSlotError, NotSelectedForServiceError } from '../ItineraryAllocationUseCase';
import { SubstitutionNothingToCoverError, SubstitutionRequestAlreadyUndoneError, SubstitutionRequestNotFoundError, SubstitutionServiceNotFoundError } from '../substitutionRequestErrors';
import { ItineraryOverlapError } from '../../domain/itineraryOverlap';
import type { ServiceTeamRows } from '../../infrastructure/ServiceTeamReader';
import type { ServiceRequestRows } from '../../infrastructure/SubstitutionRequestReader';
import { CLIENT, NOW, RID, absence, header, log, serviceRows } from './substitutionRequestFixtures';

const TEAM: ServiceTeamRows = {
  serviceId: 's-1', country: 'AR', liveVacancyId: 'v-live',
  candidacies: [{ workerId: 'w-in', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null }],
  assignments: [], marks: [], substitutions: [],
};

interface Opts {
  rows?: ServiceRequestRows | null;
  team?: ServiceTeamRows | null;
  applicationId?: string | null;
  titulares?: Record<string, { slotId?: string } | null>;
  insertError?: unknown;
  setError?: unknown;
}

function build(opts: Opts = {}) {
  const order: string[] = [];
  const reader = { readForServiceWith: jest.fn(async () => (opts.rows === undefined ? serviceRows() : opts.rows)), lockHeader: jest.fn(async () => undefined) };
  const absenceUseCase = {
    setSubstituteWith: jest.fn(async (_c: unknown, i: { absenceId: string }) => {
      order.push(`set:${i.absenceId}`);
      if (opts.setError) throw opts.setError;
      return { absenceId: i.absenceId, allocationId: 'a', date: 'd', substituteWorkerId: 'w-in', status: 'OPEN' as const };
    }),
  };
  const team = { readWith: jest.fn(async () => (opts.team === undefined ? TEAM : opts.team)) };
  const allocations = {
    findAllocation: jest.fn(async (_c: unknown, _p: string, _s: string, id: string) => {
      const t = opts.titulares ? opts.titulares[id] : { slotId: `slot-${id}` };
      return t === null || t === undefined ? null : { id, status: 'ENDED' as const, validFrom: '2026-01-01', slotId: t.slotId, workerId: 'w-out' };
    }),
    findApplicationId: jest.fn(async () => (opts.applicationId === undefined ? 'wja-1' : opts.applicationId)),
    insertAllocation: jest.fn(async (_c: unknown, i: { slotId: string; validFrom: string }) => {
      order.push(`insert:${i.slotId}`);
      if (opts.insertError) throw opts.insertError;
      return { id: `new-${i.slotId}`, validFrom: i.validFrom };
    }),
  };
  const changeLog = { insert: jest.fn(async (_c: unknown, _i: unknown) => (order.push('log'), { id: 'log' })) };
  const derivation = { run: jest.fn(async () => (order.push('derive'), 'unchanged' as const)) };
  const runInTransaction = jest.fn(async (fn: (c: never) => Promise<unknown>) => fn(CLIENT)) as never;
  const useCase = new AssignSubstitutionCoverUseCase(reader, absenceUseCase, team, allocations, changeLog, derivation, runInTransaction);
  return { useCase, order, reader, absenceUseCase, team, allocations, changeLog, derivation };
}

const input = { patientId: 'p-1', serviceId: 's-1', requestId: RID, substituteWorkerId: 'w-in', actorUid: 'u-1', now: NOW };

describe('AssignSubstitutionCoverUseCase — DIAS', () => {
  const dias = serviceRows({
    absences: [
      absence('ab-passada', '2026-10-28'), // passada: fica
      absence('ab-1', '2026-11-02'),
      absence('ab-2', '2026-11-04'),
      absence('ab-com-sub', '2026-11-06', { substituteWorkerId: 'w-outro' }), // já tem quem entra
      absence('ab-cancelada', '2026-11-09', { cancelledAt: '2026-10-29T10:00:00.000Z' }),
    ],
  });

  it('D4: trava o cabeçalho ANTES de ler; cada turno é gravado com a guarda `onlyIfUncovered` (a corrida perdida vira ALREADY_COVERED, nunca sobrescreve)', async () => {
    const t = build({ rows: dias });
    await t.useCase.execute(input);
    expect(t.reader.lockHeader).toHaveBeenCalledWith(CLIENT, 's-1', RID);
    expect(t.reader.lockHeader.mock.invocationCallOrder[0]).toBeLessThan(t.reader.readForServiceWith.mock.invocationCallOrder[0]);
    expect(t.absenceUseCase.setSubstituteWith).toHaveBeenCalledTimes(2);
    for (const call of t.absenceUseCase.setSubstituteWith.mock.calls) expect(call[1]).toMatchObject({ onlyIfUncovered: true });
  });

  it('põe o substituto SÓ nas ausências futuras, vivas e sem ninguém, no mesmo client; não deriva (falta temporária não move o paciente)', async () => {
    const t = build({ rows: dias });

    const result = await t.useCase.execute(input);

    expect(t.order).toEqual(['set:ab-1', 'set:ab-2']);
    expect(t.absenceUseCase.setSubstituteWith).toHaveBeenCalledWith(CLIENT, { patientId: 'p-1', serviceId: 's-1', absenceId: 'ab-1', substituteWorkerId: 'w-in', actorUid: 'u-1', now: NOW, onlyIfUncovered: true });
    expect(result).toEqual({ requestId: RID, type: 'DAYS', covered: 2 });
    expect(t.derivation.run).not.toHaveBeenCalled();
  });

  it('nada sem ninguém a cobrir → NOTHING_TO_COVER; pedido desfeito → ALREADY_UNDONE; inexistente → NotFound; nada escrito', async () => {
    const todasCobertas = build({ rows: serviceRows({ absences: [absence('ab-1', '2026-11-02', { substituteWorkerId: 'w-x' })] }) });
    await expect(todasCobertas.useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionNothingToCoverError);
    const desfeito = build({ rows: serviceRows({ headers: [header({ undoneAt: '2026-10-25T10:00:00.000Z', undoneBy: 'u-9' })], absences: [absence('ab-1', '2026-11-02')] }) });
    await expect(desfeito.useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionRequestAlreadyUndoneError);
    await expect(build({ rows: null }).useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionRequestNotFoundError);
    for (const t of [todasCobertas, desfeito]) expect(t.absenceUseCase.setSubstituteWith).not.toHaveBeenCalled();
  });

  it('o erro do substituto (gate/sobreposição) sobe e PARA — a transação desfaz as anteriores', async () => {
    const t = build({ rows: dias, setError: new NotSelectedForServiceError('p-1', 's-1', 'w-in') });
    await expect(t.useCase.execute(input)).rejects.toBeInstanceOf(NotSelectedForServiceError);
    expect(t.absenceUseCase.setSubstituteWith).toHaveBeenCalledTimes(1);
  });

  it('sem `now` injetado usa o relógio; construtor sem argumentos monta as portas reais', async () => {
    expect(() => new AssignSubstitutionCoverUseCase()).not.toThrow();
    const futuro = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const t = build({ rows: serviceRows({ absences: [absence('ab-1', futuro)] }) });
    const { now: _now, ...semNow } = input;
    await expect(t.useCase.execute(semNow)).resolves.toMatchObject({ covered: 1 });
  });
});

describe('AssignSubstitutionCoverUseCase — PERMANENTE sem substituto', () => {
  /** "No vuelve más" a partir de 2026-11-02: 2 saídas (REMOVE, effective = D-1 = 2026-11-01); a 2ª já tem REPLACE. */
  const semNinguem = serviceRows({
    logRows: [
      log('REMOVE', 'a-seg', '2026-11-01', { destination: 'RESERVE' }),
      log('REMOVE', 'a-qua', '2026-11-01', { destination: 'LEAVE_SERVICE' }),
      log('REMOVE', 'a-sex', '2026-11-01', { destination: null }),
      log('REPLACE', 'a-sex', '2026-11-02', { newAssignmentId: 'new-sex' }),
    ],
  });

  it('aloca a pessoa na MESMA faixa de cada saída ainda sem REPLACE, a partir de D, e liga o REPLACE (request_id, titular, nova, destino do REMOVE); deriva por último; gate uma vez', async () => {
    const t = build({ rows: semNinguem });

    const result = await t.useCase.execute(input);

    expect(t.order).toEqual(['insert:slot-a-seg', 'log', 'insert:slot-a-qua', 'log', 'derive']);
    expect(t.allocations.insertAllocation).toHaveBeenCalledWith(CLIENT, { slotId: 'slot-a-seg', workerId: 'w-in', applicationId: 'wja-1', validFrom: '2026-11-02', actorUid: 'u-1' });
    expect(t.allocations.findApplicationId).toHaveBeenCalledTimes(1);
    expect(t.changeLog.insert.mock.calls[0]).toEqual([
      CLIENT,
      { serviceId: 's-1', kind: 'REPLACE', outgoingWorkerId: 'w-out', incomingWorkerId: 'w-in', assignmentId: 'a-seg', newAssignmentId: 'new-slot-a-seg', requestId: RID, effectiveDate: '2026-11-02', reasonCode: 'OTHER', destination: 'RESERVE', actorUid: 'u-1' },
    ]);
    expect(t.changeLog.insert.mock.calls[1][1]).toMatchObject({ assignmentId: 'a-qua', destination: 'LEAVE_SERVICE' });
    expect(result).toEqual({ requestId: RID, type: 'PERMANENT', covered: 2 });
  });

  it('D já passado: a entrada começa HOJE (max(D, hoje)); REMOVE sem destino lido cai em RESERVE', async () => {
    const t = build({ rows: serviceRows({ logRows: [log('REMOVE', 'a-seg', '2026-10-20', { destination: null })] }) });
    await t.useCase.execute(input);
    expect(t.allocations.insertAllocation.mock.calls[0][1]).toMatchObject({ validFrom: '2026-10-30' });
    expect(t.changeLog.insert.mock.calls[0][1]).toMatchObject({ destination: 'RESERVE', effectiveDate: '2026-10-30' });
  });

  it('todas as saídas já têm REPLACE → NOTHING_TO_COVER; serviço sem time → 404; titular sumido → AllocationNotFoundError (sem slot)', async () => {
    const cobertas = build({ rows: serviceRows({ logRows: [log('REMOVE', 'a-1', '2026-11-01'), log('REPLACE', 'a-1', '2026-11-02', { newAssignmentId: 'n' })] }) });
    await expect(cobertas.useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionNothingToCoverError);
    await expect(build({ rows: semNinguem, team: null }).useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionServiceNotFoundError);
    await expect(build({ rows: semNinguem, titulares: { 'a-seg': null } }).useCase.execute(input)).rejects.toBeInstanceOf(AllocationNotFoundError);
    await expect(build({ rows: semNinguem, titulares: { 'a-seg': {} } }).useCase.execute(input)).rejects.toBeInstanceOf(AllocationNotFoundError);
  });

  it('gate do substituto: fora do pool / sem candidatura → NotSelectedForServiceError e nada é alocado', async () => {
    const foraDoPool = build({ rows: semNinguem, team: { ...TEAM, candidacies: [] } });
    await expect(foraDoPool.useCase.execute(input)).rejects.toBeInstanceOf(NotSelectedForServiceError);
    const semCandidatura = build({ rows: semNinguem, applicationId: null });
    await expect(semCandidatura.useCase.execute(input)).rejects.toBeInstanceOf(NotSelectedForServiceError);
    expect(foraDoPool.allocations.insertAllocation).not.toHaveBeenCalled();
    expect(semCandidatura.allocations.insertAllocation).not.toHaveBeenCalled();
  });

  it('INSERT: 23P01 vira ItineraryOverlapError; 23505 de uq_pia_open_pair vira AlreadyAllocatedInSlotError; outro erro sobe CRU; sem registro nem derivação', async () => {
    const detail = JSON.stringify({
      existingServiceId: 's-9', existingWeekday: 1, existingStart: '08:00', existingEnd: '12:00',
      requestedServiceId: 's-1', requestedWeekday: 1, requestedStart: '08:00', requestedEnd: '12:00', sameAddress: false, minGapMinutes: 60,
    });
    const sobrepoe = build({ rows: semNinguem, insertError: Object.assign(new Error('itinerary_overlap'), { code: '23P01', detail }) });
    await expect(sobrepoe.useCase.execute(input)).rejects.toBeInstanceOf(ItineraryOverlapError);
    const aberto = build({ rows: semNinguem, insertError: Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_pia_open_pair' }) });
    await expect(aberto.useCase.execute(input)).rejects.toBeInstanceOf(AlreadyAllocatedInSlotError);
    const cru = new Error('boom');
    await expect(build({ rows: semNinguem, insertError: cru }).useCase.execute(input)).rejects.toBe(cru);
    for (const t of [sobrepoe, aberto]) {
      expect(t.changeLog.insert).not.toHaveBeenCalled();
      expect(t.derivation.run).not.toHaveBeenCalled();
    }
  });
});
