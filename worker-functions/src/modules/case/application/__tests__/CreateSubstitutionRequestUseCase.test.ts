/**
 * CreateSubstitutionRequestUseCase — spec 069, FR-10/FR-11 (parte DIAS). Portas injetadas, sem banco: o que se prova é a ORDEM
 * (cabeçalho → ausências → registros), que TUDO roda no MESMO client/transação, e que nada é gravado quando uma validação ou uma
 * escrita falha. O rollback de verdade (cabeçalho incluso, 23P01 no 3º turno) é provado no e2e contra Postgres real.
 */
import {
  CreateSubstitutionRequestUseCase,
  assertShiftsMatch,
  type CreateSubstitutionRequestInput,
} from '../CreateSubstitutionRequestUseCase';
import {
  SubstitutionNoShiftsInPeriodError,
  SubstitutionPeriodInPastError,
  SubstitutionServiceNotFoundError,
  SubstitutionShiftsMismatchError,
} from '../substitutionRequestErrors';
import { ServiceExitReasonInvalidError, ServiceExitReasonRequiredError } from '../../domain/serviceExitReason';
import { NotSelectedForServiceError } from '../ItineraryAllocationUseCase';
import { AbsenceAlreadyExistsError } from '../ItineraryAbsenceUseCase';
import { ItineraryOverlapError } from '../../domain/itineraryOverlap';
import type { ServiceTeamRows } from '../../infrastructure/ServiceTeamReader';
import type { OccurrenceInputs } from '../../infrastructure/occurrenceInputs';

const CLIENT = { marker: 'client' } as never;
const NOW = new Date('2026-10-30T15:00:00Z'); // asOf AR = 2026-10-30 (sexta); 2026-11-02 é segunda

const TEAM: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [
    { workerId: 'w-sub', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null },
    { workerId: 'w-sub2', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null },
  ],
  assignments: [],
  marks: [],
  substitutions: [],
};

/** Titular `w-out` com seg/qua/sex no serviço. */
const OCCURRENCES: OccurrenceInputs = {
  slots: [
    { slotId: 'seg', serviceId: 's-1', weekday: 1, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null },
    { slotId: 'qua', serviceId: 's-1', weekday: 3, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null },
    { slotId: 'sex', serviceId: 's-1', weekday: 5, startTime: '14:00', endTime: '18:00', validFrom: '2026-01-01', validTo: null },
  ],
  assignments: ['seg', 'qua', 'sex'].map((slotId) => ({ assignmentId: `a-${slotId}`, slotId, workerId: 'w-out', validFrom: '2026-01-01', validTo: null, status: 'ACTIVE' as const })),
  absences: [],
};

const SIX_DATES: Array<[string, string]> = [
  ['2026-11-02', 'seg'], ['2026-11-04', 'qua'], ['2026-11-06', 'sex'], ['2026-11-09', 'seg'], ['2026-11-11', 'qua'], ['2026-11-13', 'sex'],
];

function shiftsWith(substitute: string | null, overrides: Record<string, string | null> = {}) {
  return SIX_DATES.map(([date, slotId]) => ({ date, slotId, substituteWorkerId: date in overrides ? overrides[date] : substitute }));
}

function build(opts: { team?: ServiceTeamRows | null; occurrences?: OccurrenceInputs; failInsertAt?: number; insertError?: unknown; applicationId?: string | null; reasons?: string[]; logError?: unknown } = {}) {
  const order: string[] = [];
  const runInTransaction = jest.fn(async (fn: (c: never) => Promise<unknown>) => fn(CLIENT)) as never;
  const team = { readWith: jest.fn(async () => (opts.team === undefined ? TEAM : opts.team)) };
  let n = 0;
  const absences = {
    insertAbsence: jest.fn(async (_c: unknown, input: { date: string }) => {
      n += 1;
      if (opts.failInsertAt === n) throw opts.insertError;
      order.push(`absence:${n}`);
      return { id: `ab-${n}`, date: input.date };
    }),
  };
  const allocationWriter = { findApplicationId: jest.fn(async () => (opts.applicationId === undefined ? 'wja-1' : opts.applicationId)) };
  const reasons = { findActiveByCode: jest.fn(async (_c: unknown, code: string) => ((opts.reasons ?? ['OTHER']).includes(code) ? { code, label: code } : null)) };
  const changeLog = {
    insert: jest.fn(async (_c: unknown, _i: unknown) => {
      if (opts.logError) throw opts.logError;
      order.push('log');
      return { id: 'log-1' };
    }),
  };
  const requests = { insert: jest.fn(async (_c: unknown, _i: unknown) => (order.push('header'), { id: 'req-1' })) };
  const occurrences = { readForService: jest.fn(async () => opts.occurrences ?? OCCURRENCES) };
  const useCase = new CreateSubstitutionRequestUseCase(team, absences, allocationWriter, runInTransaction, reasons, changeLog, requests, occurrences);
  return { useCase, order, team, absences, allocationWriter, reasons, changeLog, requests, occurrences, runInTransaction };
}

function input(o: Partial<CreateSubstitutionRequestInput> = {}): CreateSubstitutionRequestInput {
  return {
    patientId: 'p-1', serviceId: 's-1', type: 'DAYS', outgoingWorkerId: 'w-out', from: '2026-11-02', to: '2026-11-13',
    reasonCategory: 'OTHER', shifts: shiftsWith('w-sub'), actorUid: 'u-1', now: NOW, ...o,
  };
}

describe('CreateSubstitutionRequestUseCase', () => {
  it('feliz: 6 turnos → 1 cabeçalho, 6 ausências e 6 registros ABSENCE com o MESMO request_id, nesta ORDEM, no mesmo client', async () => {
    const t = build();

    const result = await t.useCase.execute(input());

    expect(t.order).toEqual(['header', 'absence:1', 'absence:2', 'absence:3', 'absence:4', 'absence:5', 'absence:6', 'log', 'log', 'log', 'log', 'log', 'log']);
    expect(result).toMatchObject({ requestId: 'req-1', type: 'DAYS', from: '2026-11-02', to: '2026-11-13', shiftCount: 6 });
    expect(result.absences.map((a) => `${a.date}/${a.slotId}`)).toEqual(SIX_DATES.map(([d, s]) => `${d}/${s}`));
    expect(t.requests.insert).toHaveBeenCalledWith(CLIENT, { serviceId: 's-1', outgoingWorkerId: 'w-out', reasonCode: 'OTHER', actorUid: 'u-1' });
    for (const [, call] of t.absences.insertAbsence.mock.calls.entries()) {
      expect(call[0]).toBe(CLIENT);
      expect(call[1]).toMatchObject({ requestId: 'req-1', substituteWorkerId: 'w-sub', substituteApplicationId: 'wja-1', actorUid: 'u-1' });
    }
    expect(t.changeLog.insert).toHaveBeenCalledTimes(6);
    expect(t.changeLog.insert.mock.calls[0]).toEqual([
      CLIENT,
      expect.objectContaining({ kind: 'ABSENCE', requestId: 'req-1', outgoingWorkerId: 'w-out', incomingWorkerId: 'w-sub', reasonCode: 'OTHER', absenceId: 'ab-1', assignmentId: 'a-seg', effectiveDate: '2026-11-02' }),
    ]);
    expect(t.runInTransaction).toHaveBeenCalledTimes(1);
    expect(t.occurrences.readForService).toHaveBeenCalledWith(CLIENT, 'p-1', 's-1', '2026-11-02', '2026-11-13');
  });

  it('"Nadie todavía" por turno: substituteWorkerId null grava os dois campos do substituto null e NÃO consulta o gate; candidatura só 1× por pessoa distinta', async () => {
    const t = build();

    const nobody = await t.useCase.execute(input({ shifts: shiftsWith(null) }));
    expect(nobody.absences.every((a) => a.substituteWorkerId === null)).toBe(true);
    expect(t.allocationWriter.findApplicationId).not.toHaveBeenCalled();
    expect(t.absences.insertAbsence.mock.calls[0][1]).toMatchObject({ substituteWorkerId: null, substituteApplicationId: null });

    const mixed = build();
    await mixed.useCase.execute(input({ shifts: shiftsWith('w-sub', { '2026-11-06': null, '2026-11-09': 'w-sub2' }) }));
    expect(mixed.allocationWriter.findApplicationId).toHaveBeenCalledTimes(2); // w-sub e w-sub2, uma vez cada
    expect(mixed.changeLog.insert.mock.calls[2][1]).toMatchObject({ incomingWorkerId: null, absenceId: 'ab-3' });
  });

  it('ONE_DAY: um dia só (todos os turnos da pessoa naquela data)', async () => {
    const t = build();
    const result = await t.useCase.execute(input({ type: 'ONE_DAY', to: '2026-11-02', shifts: [{ date: '2026-11-02', slotId: 'seg', substituteWorkerId: 'w-sub' }] }));
    expect(result).toMatchObject({ type: 'ONE_DAY', shiftCount: 1, to: '2026-11-02' });
  });

  it('motivo ausente/vazio → ServiceExitReasonRequiredError ANTES de abrir transação; motivo não-string → Invalid; código inexistente/inativo → Invalid sem escrever', async () => {
    for (const reasonCategory of [undefined, null, '']) {
      const t = build();
      await expect(t.useCase.execute(input({ reasonCategory }))).rejects.toThrow(ServiceExitReasonRequiredError);
      expect(t.runInTransaction).not.toHaveBeenCalled();
    }
    const naoString = build();
    await expect(naoString.useCase.execute(input({ reasonCategory: 42 }))).rejects.toThrow(ServiceExitReasonInvalidError);
    expect(naoString.runInTransaction).not.toHaveBeenCalled();

    const inativo = build();
    await expect(inativo.useCase.execute(input({ reasonCategory: 'NOPE' }))).rejects.toThrow(ServiceExitReasonInvalidError);
    expect(inativo.requests.insert).not.toHaveBeenCalled();
    expect(inativo.absences.insertAbsence).not.toHaveBeenCalled();
  });

  it('serviço inexistente (time null) → SubstitutionServiceNotFoundError, nada escrito', async () => {
    const t = build({ team: null });
    await expect(t.useCase.execute(input())).rejects.toThrow(SubstitutionServiceNotFoundError);
    expect(t.requests.insert).not.toHaveBeenCalled();
  });

  it('período que começa antes de hoje (data de operação do país, não a UTC) → SubstitutionPeriodInPastError', async () => {
    const t = build();
    // 2026-11-03T02:30Z já é 03/11 em UTC, mas ainda 02/11 em AR: from = 02/11 NÃO é passado; 01/11 é.
    const madrugada = new Date('2026-11-03T02:30:00Z');
    expect(madrugada.toISOString().slice(0, 10)).toBe('2026-11-03'); // sanidade do fuso
    await expect(t.useCase.execute(input({ from: '2026-11-01', now: madrugada }))).rejects.toThrow(SubstitutionPeriodInPastError);
    await expect(t.useCase.execute(input({ from: '2026-11-02', now: madrugada }))).resolves.toMatchObject({ requestId: 'req-1' });
    expect(t.requests.insert).toHaveBeenCalledTimes(1); // só o 2º chamou
  });

  it('período sem nenhum turno da pessoa → SubstitutionNoShiftsInPeriodError (US4), nada escrito', async () => {
    const t = build();
    await expect(t.useCase.execute(input({ from: '2026-11-03', to: '2026-11-03', type: 'ONE_DAY', shifts: [] }))).rejects.toThrow(SubstitutionNoShiftsInPeriodError); // terça
    expect(t.requests.insert).not.toHaveBeenCalled();
    const outra = build();
    await expect(outra.useCase.execute(input({ outgoingWorkerId: 'w-ninguem' }))).rejects.toThrow(SubstitutionNoShiftsInPeriodError);
  });

  it('turnos do corpo diferentes dos da pessoa (faltando, sobrando, repetido, data trocada) → SubstitutionShiftsMismatchError, nada escrito', async () => {
    const casos: Array<ReturnType<typeof shiftsWith>> = [
      shiftsWith('w-sub').slice(1), // falta um
      [...shiftsWith('w-sub'), { date: '2026-11-03', slotId: 'seg', substituteWorkerId: null }], // sobra um
      [...shiftsWith('w-sub').slice(1), shiftsWith('w-sub')[1]], // repete (mesmo tamanho)
      shiftsWith('w-sub').map((s, i) => (i === 0 ? { ...s, date: '2026-11-03' } : s)), // data que a pessoa não tem
    ];
    for (const shifts of casos) {
      const t = build();
      await expect(t.useCase.execute(input({ shifts }))).rejects.toThrow(SubstitutionShiftsMismatchError);
      expect(t.requests.insert).not.toHaveBeenCalled();
    }
  });

  it('assertShiftsMatch: ordem diferente do corpo NÃO é divergência (é conjunto)', () => {
    const expected = shiftsWith(null).map((s) => ({ ...s, assignmentId: `a-${s.slotId}`, startTime: '08:00', endTime: '12:00' }));
    expect(() => assertShiftsMatch(expected, [...shiftsWith(null)].reverse())).not.toThrow();
  });

  it('substituto fora do pool do step final (gate canAllocate) → NotSelectedForServiceError; sem vaga viva, sem candidatura → idem; nada escrito', async () => {
    const foraDoPool = build({ team: { ...TEAM, candidacies: [] } });
    await expect(foraDoPool.useCase.execute(input())).rejects.toThrow(NotSelectedForServiceError);
    const semVaga = build({ team: { ...TEAM, liveVacancyId: null } });
    await expect(semVaga.useCase.execute(input())).rejects.toThrow(NotSelectedForServiceError);
    const semCandidatura = build({ applicationId: null });
    await expect(semCandidatura.useCase.execute(input())).rejects.toThrow(NotSelectedForServiceError);
    for (const t of [foraDoPool, semVaga, semCandidatura]) {
      expect(t.requests.insert).not.toHaveBeenCalled();
      expect(t.absences.insertAbsence).not.toHaveBeenCalled();
    }
  });

  it('23P01 no 3º turno vira ItineraryOverlapError (409) e PARA: nenhum registro de troca é gravado (a transação do banco desfaz o resto)', async () => {
    const detail = JSON.stringify({
      existingServiceId: 's-9', existingWeekday: 3, existingStart: '08:00', existingEnd: '12:00',
      requestedServiceId: 's-1', requestedWeekday: 3, requestedStart: '08:00', requestedEnd: '12:00', sameAddress: false, minGapMinutes: 60,
    });
    const overlap = Object.assign(new Error('itinerary_overlap'), { code: '23P01', detail });
    const t = build({ failInsertAt: 3, insertError: overlap });
    await expect(t.useCase.execute(input())).rejects.toBeInstanceOf(ItineraryOverlapError);
    expect(t.absences.insertAbsence).toHaveBeenCalledTimes(3);
    expect(t.changeLog.insert).not.toHaveBeenCalled();
  });

  it('erro do banco que não é de ausência: o 23505 de uq_piab_open é decodificado; o desconhecido sobe CRU', async () => {
    const dup = build({ failInsertAt: 1, insertError: Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_piab_open' }) });
    await expect(dup.useCase.execute(input())).rejects.toBeInstanceOf(AbsenceAlreadyExistsError);

    const cru = new Error('conexão caiu');
    const desconhecido = build({ failInsertAt: 1, insertError: cru });
    await expect(desconhecido.useCase.execute(input())).rejects.toBe(cru);
  });

  it('falha do registro de trocas NÃO é decodificada como erro de ausência: sobe CRU (a transação desfaz tudo)', async () => {
    const boom = Object.assign(new Error('fk'), { code: '23503' });
    const t = build({ logError: boom });
    await expect(t.useCase.execute(input())).rejects.toBe(boom);
  });

  it('sem `now` injetado usa o relógio (data de operação do país): período daqui a 30 dias passa', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const weekday = new Date(`${future}T00:00:00Z`).getUTCDay();
    const occurrences: OccurrenceInputs = {
      slots: [{ slotId: 'wd', serviceId: 's-1', weekday, startTime: '08:00', endTime: '12:00', validFrom: '2020-01-01', validTo: null }],
      assignments: [{ assignmentId: 'a-wd', slotId: 'wd', workerId: 'w-out', validFrom: '2020-01-01', validTo: null, status: 'ACTIVE' }],
      absences: [],
    };
    const t = build({ occurrences });
    const { now: _now, ...semNow } = input({ type: 'ONE_DAY', from: future, to: future, shifts: [{ date: future, slotId: 'wd', substituteWorkerId: null }] });
    await expect(t.useCase.execute(semNow)).resolves.toMatchObject({ shiftCount: 1 });
  });

  it('construtor sem argumentos monta as portas reais (nenhuma abre banco no construtor)', () => {
    expect(() => new CreateSubstitutionRequestUseCase()).not.toThrow();
  });
});
