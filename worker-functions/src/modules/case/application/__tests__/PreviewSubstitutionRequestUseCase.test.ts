/**
 * PreviewSubstitutionRequestUseCase — spec 069, FR-15/US4/US5. LEITURA pura: o que se prova é (i) os turnos derivados no servidor,
 * (ii) o conflito TRI-ESTADO (a falha da função do banco vira `unknown`, NUNCA `free`), (iii) que nada é escrito e o estado do
 * paciente é lido SEM lock, e (iv) que a regra é a MESMA função pura (`derivarEstadoPaciente`).
 */
import { PreviewSubstitutionRequestUseCase, type PreviewSubstitutionRequestInput } from '../PreviewSubstitutionRequestUseCase';
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
