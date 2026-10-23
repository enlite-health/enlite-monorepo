/**
 * PreviewSubstitutionRequestUseCase — spec 069, FR-15/US4/US5. LEITURA pura: o que se prova é (i) os turnos derivados no servidor,
 * (ii) o conflito TRI-ESTADO (a falha da função do banco vira `unknown`, NUNCA `free`), (iii) que nada é escrito e o estado do
 * paciente é lido SEM lock, e (iv) que a regra é a MESMA função pura (`derivarEstadoPaciente`).
 */
import { PreviewSubstitutionRequestUseCase, type PreviewPermanentInput, type PreviewSubstitutionRequestInput, type PermanentPreviewDeps } from '../PreviewSubstitutionRequestUseCase';
import type { KanbanServicesRows } from '../../infrastructure/PatientKanbanServicesReader';
import { ConflictPreviewUnavailableError } from '../../infrastructure/SubstituteConflictPreviewReader';
import {
  SubstitutionNoShiftsInPeriodError,
  SubstitutionPeriodInPastError,
  SubstitutionServiceNotFoundError,
} from '../substitutionRequestErrors';
import type { OccurrenceInputs } from '../../infrastructure/occurrenceInputs';
import type { DerivationEvaluation } from '../PatientStatusDerivation';

const CLIENT = { marker: 'client' } as never;
const NOW = new Date('2026-10-30T15:00:00Z'); // sexta; 2026-11-02 é segunda

const OCCURRENCES: OccurrenceInputs = {
  slots: [
    { slotId: 'seg', serviceId: 's-1', weekday: 1, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null },
    { slotId: 'qua', serviceId: 's-1', weekday: 3, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null },
  ],
  assignments: ['seg', 'qua'].map((slotId) => ({ assignmentId: `a-${slotId}`, slotId, workerId: 'w-out', validFrom: '2026-01-01', validTo: null, status: 'ACTIVE' as const })),
  absences: [],
};

const EVALUATION: DerivationEvaluation = {
  subject: { status: 'ACTIVE', country: 'AR', montado: true },
  input: { status: 'ACTIVE', montado: true, servicos: [{ temVacanteViva: true, cobertas: 8, total: 8 }] },
};

function input(o: Partial<PreviewSubstitutionRequestInput> = {}): PreviewSubstitutionRequestInput {
  return { patientId: 'p-1', serviceId: 's-1', type: 'DAYS', outgoingWorkerId: 'w-out', from: '2026-11-02', to: '2026-11-06', candidateWorkerIds: ['w-a'], now: NOW, ...o };
}

function build(opts: { team?: { country: string } | null; evaluation?: DerivationEvaluation | null; preview?: jest.Mock } = {}) {
  const runInTransaction = jest.fn(async (fn: (c: never) => Promise<unknown>) => fn(CLIENT)) as never;
  const team = { readWith: jest.fn(async () => (opts.team === undefined ? { country: 'AR' } : opts.team)) } as never;
  const occurrences = { readForService: jest.fn(async () => OCCURRENCES) };
  const conflicts = { preview: opts.preview ?? jest.fn(async () => []) };
  const derivation = { evaluate: jest.fn(async () => (opts.evaluation === undefined ? EVALUATION : opts.evaluation)) };
  const useCase = new PreviewSubstitutionRequestUseCase(team, occurrences, conflicts, derivation, runInTransaction);
  return { useCase, team, occurrences, conflicts, derivation, runInTransaction };
}

describe('PreviewSubstitutionRequestUseCase', () => {
  it('turnos da pessoa no período + conflito por candidato × turno, chamando a função do banco com (pessoa, faixa, dia, dia)', async () => {
    const t = build();

    const result = await t.useCase.execute(input({ candidateWorkerIds: ['w-a', 'w-b'] }));

    expect(result.shifts.map((s) => `${s.date}/${s.slotId}`)).toEqual(['2026-11-02/seg', '2026-11-04/qua']);
    expect(result.conflicts).toHaveLength(4); // 2 candidatos × 2 turnos
    expect(t.conflicts.preview).toHaveBeenCalledTimes(4);
    expect(t.conflicts.preview).toHaveBeenCalledWith(CLIENT, { workerId: 'w-a', slotId: 'seg', from: '2026-11-02', to: '2026-11-02' });
    expect(result.conflicts.every((c) => c.state === 'free' && c.overlaps.length === 0)).toBe(true);
    expect(t.runInTransaction).toHaveBeenCalledTimes(1);
  });

  it('candidato repetido é consultado uma vez só; sem candidatos = só os turnos', async () => {
    const t = build();
    expect((await t.useCase.execute(input({ candidateWorkerIds: ['w-a', 'w-a'] }))).conflicts).toHaveLength(2);
    expect((await t.useCase.execute(input({ candidateWorkerIds: [] }))).conflicts).toEqual([]);
  });

  it('conflito: o horário que colide e "mesmo endereço" voltam do banco (estado conflict); sem linhas = free', async () => {
    const preview = jest.fn(async (_c: unknown, i: { workerId: string; slotId: string }) =>
      i.workerId === 'w-a' && i.slotId === 'qua' ? [{ weekday: 3, startTime: '09:00', durationMinutes: 240, sameAddress: false }] : [],
    );
    const t = build({ preview });
    const { conflicts } = await t.useCase.execute(input());
    expect(conflicts.map((c) => [c.slotId, c.state])).toEqual([['seg', 'free'], ['qua', 'conflict']]);
    expect(conflicts[1].overlaps).toEqual([{ weekday: 3, startTime: '09:00', durationMinutes: 240, sameAddress: false }]);
  });

  it('a função do banco FALHOU → unknown (nunca free) e os outros pares seguem; erro que não é da função sobe', async () => {
    const preview = jest.fn(async (_c: unknown, i: { slotId: string }) => {
      if (i.slotId === 'seg') throw new ConflictPreviewUnavailableError(new Error('boom'));
      return [];
    });
    const { conflicts } = await build({ preview }).useCase.execute(input());
    expect(conflicts.map((c) => [c.slotId, c.state])).toEqual([['seg', 'unknown'], ['qua', 'free']]);

    const outro = jest.fn(async () => {
      throw new Error('inesperado');
    });
    await expect(build({ preview: outro }).useCase.execute(input())).rejects.toThrow('inesperado');
  });

  it('serviço inexistente → 404; período passado → SubstitutionPeriodInPastError; sem turno → SubstitutionNoShiftsInPeriodError (nada de função do banco)', async () => {
    await expect(build({ team: null }).useCase.execute(input())).rejects.toThrow(SubstitutionServiceNotFoundError);
    await expect(build().useCase.execute(input({ from: '2026-10-29' }))).rejects.toThrow(SubstitutionPeriodInPastError);
    const t = build();
    await expect(t.useCase.execute(input({ from: '2026-11-03', to: '2026-11-03', type: 'ONE_DAY' }))).rejects.toThrow(SubstitutionNoShiftsInPeriodError); // terça
    expect(t.conflicts.preview).not.toHaveBeenCalled();
  });

  it('estado depois do pedido: a MESMA regra pura, lida SEM lock; falta temporária não move o estado (changes = false)', async () => {
    const t = build();
    const { statusAfter } = await t.useCase.execute(input());
    expect(statusAfter).toEqual({ current: 'ACTIVE', after: 'ACTIVE', changes: false });
    expect(t.derivation.evaluate).toHaveBeenCalledWith(CLIENT, 'p-1', NOW, { lock: false });
  });

  it('paciente com estado derivável diferente do gravado: `after` mostra o derivado, `changes` segue false (o PEDIDO não o causa); manual/sem regra = after é o atual', async () => {
    const stale: DerivationEvaluation = {
      subject: { status: 'ACTIVE', country: 'AR', montado: true },
      input: { status: 'ACTIVE', montado: true, servicos: [{ temVacanteViva: true, cobertas: 4, total: 8 }] },
    };
    expect((await build({ evaluation: stale }).useCase.execute(input())).statusAfter).toEqual({ current: 'ACTIVE', after: 'REPLACEMENT', changes: false });

    const manual: DerivationEvaluation = { subject: { status: 'ON_HOLD', country: 'AR', montado: true }, input: { status: 'ON_HOLD', montado: true, servicos: [] } };
    expect((await build({ evaluation: manual }).useCase.execute(input())).statusAfter).toEqual({ current: 'ON_HOLD', after: 'ON_HOLD', changes: false });
  });

  it('paciente fora da derivação (sem sujeito) → statusAfter null', async () => {
    expect((await build({ evaluation: null }).useCase.execute(input())).statusAfter).toBeNull();
  });

  it('sem `now` injetado usa o relógio; construtor sem argumentos monta as portas reais', async () => {
    expect(() => new PreviewSubstitutionRequestUseCase()).not.toThrow();
    const t = build();
    const base = new Date(Date.now() + 30 * 86_400_000);
    const futureDate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + ((2 - base.getUTCDay() + 7) % 7))); // uma TERÇA (a pessoa só tem seg/qua)
    const future = futureDate.toISOString().slice(0, 10);
    const { now: _now, ...semNow } = input({ type: 'ONE_DAY', from: future, to: future });
    await expect(t.useCase.execute(semNow)).rejects.toThrow(SubstitutionNoShiftsInPeriodError); // chegou ao período = passou da checagem de data com o relógio real
  });
});

describe('PreviewSubstitutionRequestUseCase — PERMANENT ("No vuelve más")', () => {
  const ALLOCS = [
    { id: 'a-seg', slotId: 'seg', validFrom: '2026-01-01', validTo: null },
    { id: 'a-qua', slotId: 'qua', validFrom: '2026-01-01', validTo: null },
    { id: 'a-fora', slotId: 'slot-que-nao-vem', validFrom: '2026-11-02', validTo: null }, // faixa fora da leitura: sem horário, não entra nos turnos
  ];

  function permanentInput(o: Partial<PreviewPermanentInput> = {}): PreviewPermanentInput {
    return { patientId: 'p-1', serviceId: 's-1', type: 'PERMANENT', outgoingWorkerId: 'w-out', from: '2026-11-02', candidateWorkerIds: ['w-a'], now: NOW, ...o };
  }

  function buildPermanent(opts: { allocs?: typeof ALLOCS; scheduled?: Awaited<ReturnType<PermanentPreviewDeps['scheduled']['listFor']>>; evaluations?: Array<DerivationEvaluation | null>; team?: { country: string } | null } = {}) {
    const t = build({ team: opts.team });
    const evaluations = [...(opts.evaluations ?? [EVALUATION, EVALUATION])];
    const derivation = { evaluate: jest.fn(async () => (evaluations.length > 0 ? (evaluations.shift() as DerivationEvaluation | null) : EVALUATION)) };
    const exit: PermanentPreviewDeps = {
      schedule: { listWorkerAllocations: jest.fn(async () => opts.allocs ?? ALLOCS) },
      absenceOps: { listOpenOfWorker: jest.fn(async () => ['ab-1', 'ab-2', 'ab-3']) },
      scheduled: { listFor: jest.fn(async () => opts.scheduled ?? { substitutions: [{ absenceId: 'x', date: '2026-11-01' }, { absenceId: 'y', date: '2026-11-02' }], futureEntries: [] }) },
    };
    const useCase = new PreviewSubstitutionRequestUseCase(t.team, t.occurrences, t.conflicts, derivation, t.runInTransaction, exit);
    return { ...t, useCase, derivation, exit };
  }

  it('um turno por alocação que sai (com horário da faixa); conflito de cada candidato com vigência ABERTA (p_from = D, p_to = null); contagens do FR-23 e P5 livre', async () => {
    const t = buildPermanent({ allocs: ALLOCS });

    const result = await t.useCase.execute(permanentInput({ candidateWorkerIds: ['w-a', 'w-b'] }));

    expect(result.shifts.map((s) => `${s.date}/${s.slotId}/${s.startTime}-${s.endTime}`)).toEqual(['2026-11-02/seg/08:00-12:00', '2026-11-02/qua/08:00-12:00']);
    expect(t.conflicts.preview).toHaveBeenCalledTimes(4);
    expect(t.conflicts.preview).toHaveBeenCalledWith(CLIENT, { workerId: 'w-a', slotId: 'seg', from: '2026-11-02', to: null });
    expect(result.conflicts.every((c) => c.state === 'free')).toBe(true);
    // FR-23: 3 faltas dela com data ≥ D; ela é substituta em 2 turnos, mas só 1 é de D em diante
    expect(result.permanent).toEqual({ allocationCount: 3, cancelledAbsences: 3, clearedSubstitutes: 1, pendingEntry: false });
    expect(t.exit.schedule.listWorkerAllocations).toHaveBeenCalledWith(CLIENT, 's-1', 'w-out', '2026-11-02');
    expect(t.exit.absenceOps.listOpenOfWorker).toHaveBeenCalledWith(CLIENT, 's-1', 'w-out', '2026-11-02');
    expect(t.exit.scheduled.listFor).toHaveBeenCalledWith(CLIENT, 's-1', 'w-out', '2026-10-30');
    expect(t.occurrences.readForService).toHaveBeenCalledWith(CLIENT, 'p-1', 's-1', '2026-11-02', '2026-11-08');
  });

  it('P5: a entrada futura aparece em `pendingEntry` (a pré-visão não lança; o create é quem recusa)', async () => {
    const t = buildPermanent({ scheduled: { substitutions: [], futureEntries: [{ allocationId: 'e', validFrom: '2026-12-01', replaces: null }] } });
    expect((await t.useCase.execute(permanentInput())).permanent).toMatchObject({ pendingEntry: true, clearedSubstitutes: 0 });
  });

  it('estado depois SEM ninguém no lugar: a conta é rodada na data D com a transformação das faixas (simulate), SEM lock; o resultado compara com o estado de hoje', async () => {
    const hoje: DerivationEvaluation = { subject: { status: 'ACTIVE', country: 'AR', montado: true }, input: { status: 'ACTIVE', montado: true, servicos: [{ temVacanteViva: true, cobertas: 8, total: 8 }] } };
    const depois: DerivationEvaluation = { subject: hoje.subject, input: { status: 'ACTIVE', montado: true, servicos: [{ temVacanteViva: true, cobertas: 0, total: 8 }] } };
    const t = buildPermanent({ evaluations: [hoje, depois] });

    const { statusAfter } = await t.useCase.execute(permanentInput());

    expect(statusAfter).toEqual({ current: 'ACTIVE', after: 'SEARCHING', changes: true });
    expect(t.derivation.evaluate).toHaveBeenNthCalledWith(1, CLIENT, 'p-1', NOW, { lock: false });
    expect(t.derivation.evaluate).toHaveBeenNthCalledWith(2, CLIENT, 'p-1', NOW, { lock: false, simulate: { asOf: '2026-11-02', transform: expect.any(Function) } });
  });

  it('a transformação das faixas: só as alocações ACTIVE DELA no serviço mudam — fim em D-1 se já atendia, CANCELLED se só começa em D; o resto fica igual', async () => {
    const t = buildPermanent();
    await t.useCase.execute(permanentInput());
    const transform = (t.derivation.evaluate.mock.calls[1] as unknown as [unknown, unknown, unknown, { simulate: { transform: (r: KanbanServicesRows) => KanbanServicesRows } }])[3].simulate.transform;
    const row = (over: Record<string, unknown>) => ({ id: 'sl', contractedServiceId: 's-1', weekday: 1, startTime: '08:00', durationMinutes: 240, endTime: '12:00', assignmentId: 'a', workerId: 'w-out', applicationId: 'wja', validFrom: '2026-01-01', validTo: null, status: 'ACTIVE', ...over });
    const out = transform({
      patientId: 'p-1', country: 'AR', services: [], slots: [
        row({}), // atende: fim em D-1
        row({ validFrom: '2026-11-02' }), // só começaria em D: cancelada
        row({ workerId: 'w-outro' }), // outra pessoa: igual
        row({ contractedServiceId: 's-9' }), // outro serviço: igual
        row({ status: 'ENDED' }), // já encerrada: igual
        row({ assignmentId: null, workerId: null, validFrom: null, status: null }), // faixa sem alocação: igual
      ] as never,
    });
    expect(out.slots.map((r) => [r.status, r.validTo])).toEqual([['ACTIVE', '2026-11-01'], ['CANCELLED', null], ['ACTIVE', null], ['ACTIVE', null], ['ENDED', null], [null, null]]);
  });

  it('D = hoje: a simulação roda em hoje; sem sujeito da derivação (hoje ou depois) → statusAfter null', async () => {
    const t = buildPermanent();
    await t.useCase.execute(permanentInput({ from: '2026-10-30' }));
    expect(t.derivation.evaluate).toHaveBeenNthCalledWith(2, CLIENT, 'p-1', NOW, { lock: false, simulate: { asOf: '2026-10-30', transform: expect.any(Function) } });

    expect((await buildPermanent({ evaluations: [null] }).useCase.execute(permanentInput())).statusAfter).toBeNull();
    expect((await buildPermanent({ evaluations: [EVALUATION, null] }).useCase.execute(permanentInput())).statusAfter).toBeNull();
  });

  it('estado manual/sem regra: `after` é o atual e `changes` é false', async () => {
    const manual: DerivationEvaluation = { subject: { status: 'ON_HOLD', country: 'AR', montado: true }, input: { status: 'ON_HOLD', montado: true, servicos: [] } };
    const t = buildPermanent({ evaluations: [manual, manual] });
    expect((await t.useCase.execute(permanentInput())).statusAfter).toEqual({ current: 'ON_HOLD', after: 'ON_HOLD', changes: false });
  });

  it('serviço inexistente → 404; D no passado; pessoa sem alocação → NoShifts (nada de função do banco); sem `now` usa o relógio', async () => {
    await expect(buildPermanent({ team: null }).useCase.execute(permanentInput())).rejects.toThrow(SubstitutionServiceNotFoundError);
    await expect(buildPermanent().useCase.execute(permanentInput({ from: '2026-10-29' }))).rejects.toThrow(SubstitutionPeriodInPastError);
    const vazio = buildPermanent({ allocs: [] });
    await expect(vazio.useCase.execute(permanentInput())).rejects.toThrow(SubstitutionNoShiftsInPeriodError);
    expect(vazio.conflicts.preview).not.toHaveBeenCalled();
    const { now: _now, ...semNow } = permanentInput({ from: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) });
    await expect(buildPermanent().useCase.execute(semNow)).resolves.toMatchObject({ permanent: { allocationCount: 3 } });
  });
});
