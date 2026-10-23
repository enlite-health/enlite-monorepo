/**
 * UndoSubstitutionRequestUseCase — spec 069, FR-21/FR-22/FR-33 (US7). Portas injetadas: o que se prova é a DECISÃO (`undoable` da
 * fonte única), a ORDEM do desfazer permanente (cancela a entrada ANTES de soltar o fim do titular) e os erros. Os efeitos nas linhas
 * e a Trava A de verdade são provados no e2e contra Postgres real.
 */
import { UndoSubstitutionRequestUseCase } from '../UndoSubstitutionRequestUseCase';
import { AllocationRestoreConflictError } from '../restoreTitular';
import { SubstitutionRequestAlreadyUndoneError, SubstitutionRequestNotFoundError, SubstitutionRequestNotUndoableError } from '../substitutionRequestErrors';
import { ItineraryOverlapError } from '../../domain/itineraryOverlap';
import type { AllocationRow } from '../../infrastructure/ItineraryAllocationWriter';
import type { ServiceRequestRows } from '../../infrastructure/SubstitutionRequestReader';
import { CLIENT, NOW, RID, absence, header, log, serviceRows } from './substitutionRequestFixtures';

interface Opts {
  rows?: ServiceRequestRows | null;
  markRows?: number;
  markError?: unknown;
  allocations?: Record<string, AllocationRow | null>;
  cancelRows?: Record<string, number>;
  restoreError?: unknown;
  clearError?: unknown;
}

function build(opts: Opts = {}) {
  const order: string[] = [];
  const reader = { readForServiceWith: jest.fn(async () => (opts.rows === undefined ? serviceRows() : opts.rows)) };
  const requests = {
    markUndone: jest.fn(async () => {
      order.push('mark');
      if (opts.markError) throw opts.markError;
      return opts.markRows ?? 1;
    }),
  };
  const absences = { cancelAbsence: jest.fn(async (_c: unknown, id: string) => (order.push(`cancel-absence:${id}`), id === 'ab-gone' ? 0 : 1)) };
  const schedule = {
    findAllocation: jest.fn(async (_c: unknown, _p: string, _s: string, id: string) => (opts.allocations && id in opts.allocations ? opts.allocations[id] : null)),
    cancelAllocation: jest.fn(async (_c: unknown, id: string) => (order.push(`cancel-entry:${id}`), opts.cancelRows?.[id] ?? 1)),
    clearScheduledEnd: jest.fn(async (_c: unknown, id: string) => {
      order.push(`clear-end:${id}`);
      if (opts.clearError) throw opts.clearError;
      return 1;
    }),
    restoreCancelled: jest.fn(async (_c: unknown, id: string) => {
      order.push(`restore:${id}`);
      if (opts.restoreError) throw opts.restoreError;
      return 1;
    }),
  };
  const derivation = { run: jest.fn(async () => (order.push('derive'), 'unchanged' as const)) };
  const runInTransaction = jest.fn(async (fn: (c: never) => Promise<unknown>) => fn(CLIENT)) as never;
  const useCase = new UndoSubstitutionRequestUseCase(reader, requests, absences, schedule, derivation, runInTransaction);
  return { useCase, order, reader, requests, absences, schedule, derivation };
}

const input = { patientId: 'p-1', serviceId: 's-1', requestId: RID, actorUid: 'u-1', now: NOW };
const titular = (status: AllocationRow['status'], validTo: string | null): AllocationRow => ({ id: 'x', status, validFrom: '2026-01-01', validTo, slotId: 'sl' });

describe('UndoSubstitutionRequestUseCase — DIAS', () => {
  const diasRows = serviceRows({
    absences: [
      absence('ab-passada', '2026-10-28'), // ontem-ish: intocada (US7)
      absence('ab-hoje', '2026-10-30'),
      absence('ab-futura', '2026-11-04'),
      absence('ab-ja-cancelada', '2026-11-06', { cancelledAt: '2026-10-29T10:00:00.000Z' }),
    ],
  });

  it('cancela só as ausências vivas de hoje em diante (as passadas e as já canceladas ficam), carimba o desfeito DEPOIS e deriva por último', async () => {
    const t = build({ rows: diasRows });

    const result = await t.useCase.execute(input);

    expect(t.order).toEqual(['cancel-absence:ab-hoje', 'cancel-absence:ab-futura', 'mark', 'derive']);
    expect(t.requests.markUndone).toHaveBeenCalledWith(CLIENT, RID, 'u-1');
    expect(result).toEqual({ requestId: RID, type: 'DAYS', cancelledAbsences: 2, cancelledEntries: 0, restoredTitulars: 0 });
    expect(t.schedule.cancelAllocation).not.toHaveBeenCalled();
  });

  it('ausência que já estava cancelada por fora (0 linhas) não entra na contagem', async () => {
    const t = build({ rows: serviceRows({ absences: [absence('ab-gone', '2026-11-02'), absence('ab-ok', '2026-11-03')] }) });
    expect((await t.useCase.execute(input)).cancelledAbsences).toBe(1);
  });

  it('pedido todo PASSADO (nada futuro a desfazer, FR-22) → REQUEST_NOT_UNDOABLE, nada escrito', async () => {
    const t = build({ rows: serviceRows({ absences: [absence('ab-1', '2026-10-20'), absence('ab-2', '2026-10-21')] }) });
    await expect(t.useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionRequestNotUndoableError);
    expect(t.absences.cancelAbsence).not.toHaveBeenCalled();
    expect(t.requests.markUndone).not.toHaveBeenCalled();
  });

  it('pedido já desfeito → REQUEST_ALREADY_UNDONE; pedido/serviço inexistente → NotFound; nada escrito', async () => {
    const desfeito = build({ rows: serviceRows({ headers: [header({ undoneAt: '2026-10-25T10:00:00.000Z', undoneBy: 'u-9' })], absences: [absence('ab-1', '2026-11-02')] }) });
    await expect(desfeito.useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionRequestAlreadyUndoneError);
    await expect(build({ rows: null }).useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionRequestNotFoundError);
    await expect(build({ rows: serviceRows({ headers: [] }) }).useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionRequestNotFoundError);
    expect(desfeito.requests.markUndone).not.toHaveBeenCalled();
  });

  it('o carimbo do banco: 0 linhas = corrida (ALREADY_UNDONE); 23514 pisr_desfazer_com_turno_aberto = NOT_UNDOABLE; outro erro sobe CRU; sem derivação', async () => {
    const corrida = build({ rows: diasRows, markRows: 0 });
    await expect(corrida.useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionRequestAlreadyUndoneError);
    const aberto = build({ rows: diasRows, markError: Object.assign(new Error('pisr_desfazer_com_turno_aberto'), { code: '23514' }) });
    await expect(aberto.useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionRequestNotUndoableError);
    const cru = new Error('conexão caiu');
    const outro = build({ rows: diasRows, markError: cru });
    await expect(outro.useCase.execute(input)).rejects.toBe(cru);
    const semCodigo = build({ rows: diasRows, markError: 'texto' });
    await expect(semCodigo.useCase.execute(input)).rejects.toBe('texto');
    for (const t of [corrida, aberto, outro]) expect(t.derivation.run).not.toHaveBeenCalled();
  });

  it('sem `now` injetado usa o relógio; construtor sem argumentos monta as portas reais', async () => {
    expect(() => new UndoSubstitutionRequestUseCase()).not.toThrow();
    const futuro = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const t = build({ rows: serviceRows({ absences: [absence('ab-1', futuro)] }) });
    const { now: _now, ...semNow } = input;
    await expect(t.useCase.execute(semNow)).resolves.toMatchObject({ cancelledAbsences: 1 });
  });
});

describe('UndoSubstitutionRequestUseCase — PERMANENTE (antes de D)', () => {
  /** "No vuelve más" a partir de 2026-11-02 com substituto em 2 faixas (REPLACE ligando titular → entrada). */
  const comSubstituto = serviceRows({
    logRows: [
      log('REPLACE', 'a-seg', '2026-11-02', { newAssignmentId: 'new-seg' }),
      log('REPLACE', 'a-qua', '2026-11-02', { newAssignmentId: 'new-qua' }),
    ],
  });
  const titulares = { 'a-seg': titular('ACTIVE', '2026-11-01'), 'a-qua': titular('CANCELLED', null) };

  it('ORDEM: cancela as ENTRADAS dos substitutos ANTES de soltar o fim do titular / restaurá-lo; carimba e deriva por último', async () => {
    const t = build({ rows: comSubstituto, allocations: titulares });

    const result = await t.useCase.execute(input);

    expect(t.order).toEqual(['cancel-entry:new-seg', 'cancel-entry:new-qua', 'clear-end:a-seg', 'restore:a-qua', 'mark', 'derive']);
    expect(t.schedule.cancelAllocation).toHaveBeenCalledWith(CLIENT, 'new-seg', '2026-11-02', 'u-1');
    expect(t.schedule.restoreCancelled).toHaveBeenCalledWith(CLIENT, 'a-qua', '2026-11-02', 'u-1');
    expect(t.absences.cancelAbsence).not.toHaveBeenCalled(); // as faltas canceladas pelo FR-23 NÃO voltam e nada mais é cancelado
    expect(result).toEqual({ requestId: RID, type: 'PERMANENT', cancelledAbsences: 0, cancelledEntries: 2, restoredTitulars: 2 });
  });

  it('saída SEM substituto (só REMOVE, effective = D-1): não há entrada a cancelar; o titular com fim em D-1 é solto', async () => {
    const t = build({ rows: serviceRows({ logRows: [log('REMOVE', 'a-seg', '2026-11-01')] }), allocations: { 'a-seg': titular('ACTIVE', '2026-11-01') } });
    const result = await t.useCase.execute(input);
    expect(t.order).toEqual(['clear-end:a-seg', 'mark', 'derive']);
    expect(result).toMatchObject({ cancelledEntries: 0, restoredTitulars: 1 });
  });

  it('REMOVE seguido de "Elegir quién entra" (REPLACE com a entrada): a entrada é cancelada UMA vez e o titular volta UMA vez', async () => {
    const t = build({
      rows: serviceRows({ logRows: [log('REMOVE', 'a-seg', '2026-11-01'), log('REPLACE', 'a-seg', '2026-11-02', { newAssignmentId: 'new-seg' })] }),
      allocations: { 'a-seg': titular('ACTIVE', '2026-11-01') },
    });
    await t.useCase.execute(input);
    expect(t.order).toEqual(['cancel-entry:new-seg', 'clear-end:a-seg', 'mark', 'derive']);
  });

  it('entrada já cancelada (0 linhas) não conta; titular sumido, ENDED por outro caminho ou com fim em outra data não é reaberto', async () => {
    const t = build({
      rows: serviceRows({ logRows: [log('REPLACE', 'a-1', '2026-11-02', { newAssignmentId: 'e-1' }), log('REPLACE', 'a-2', '2026-11-02', { newAssignmentId: 'e-2' }), log('REPLACE', 'a-3', '2026-11-02'), log('REPLACE', 'a-4', '2026-11-02')] }),
      cancelRows: { 'e-1': 0 },
      allocations: { 'a-1': null, 'a-2': titular('ENDED', '2026-11-01'), 'a-3': titular('ACTIVE', '2026-12-31'), 'a-4': titular('ACTIVE', null) },
    });
    const result = await t.useCase.execute(input);
    expect(result).toMatchObject({ cancelledEntries: 1, restoredTitulars: 0 });
    expect(t.schedule.clearScheduledEnd).not.toHaveBeenCalled();
    expect(t.schedule.restoreCancelled).not.toHaveBeenCalled();
  });

  it('o restore bate em uq_pia_open_pair (defeito 17) → AllocationRestoreConflictError (409), sem carimbar nem derivar; sobreposição → ItineraryOverlapError; outro erro CRU', async () => {
    const aberto = build({ rows: comSubstituto, allocations: titulares, restoreError: Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_pia_open_pair' }) });
    await expect(aberto.useCase.execute(input)).rejects.toBeInstanceOf(AllocationRestoreConflictError);
    expect(aberto.requests.markUndone).not.toHaveBeenCalled();
    expect(aberto.derivation.run).not.toHaveBeenCalled();

    const detail = JSON.stringify({
      existingServiceId: 's-1', existingWeekday: 1, existingStart: '08:00', existingEnd: '12:00',
      requestedServiceId: 's-1', requestedWeekday: 1, requestedStart: '08:00', requestedEnd: '12:00', sameAddress: true, minGapMinutes: null,
    });
    const sobrepoe = build({ rows: comSubstituto, allocations: titulares, restoreError: Object.assign(new Error('itinerary_overlap'), { code: '23P01', detail }) });
    await expect(sobrepoe.useCase.execute(input)).rejects.toBeInstanceOf(ItineraryOverlapError);

    const cru = Object.assign(new Error('trava'), { code: 'P0001' });
    await expect(build({ rows: comSubstituto, allocations: titulares, restoreError: cru }).useCase.execute(input)).rejects.toBe(cru);
  });

  it('soltar o fim do titular também reabre o par: 23505 de uq_pia_open_pair → AllocationRestoreConflictError; outro erro sobe CRU', async () => {
    const aberto = build({ rows: comSubstituto, allocations: titulares, clearError: Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_pia_open_pair' }) });
    await expect(aberto.useCase.execute(input)).rejects.toBeInstanceOf(AllocationRestoreConflictError);
    expect(aberto.requests.markUndone).not.toHaveBeenCalled();
    const cru = new Error('boom');
    await expect(build({ rows: comSubstituto, allocations: titulares, clearError: cru }).useCase.execute(input)).rejects.toBe(cru);
  });

  it('D = hoje ou passado (since ≤ hoje): FR-33 só ANTES de D → REQUEST_NOT_UNDOABLE; nada escrito', async () => {
    const t = build({ rows: serviceRows({ logRows: [log('REMOVE', 'a-seg', '2026-10-29')] }), allocations: { 'a-seg': titular('ACTIVE', '2026-10-29') } });
    await expect(t.useCase.execute(input)).rejects.toBeInstanceOf(SubstitutionRequestNotUndoableError);
    expect(t.schedule.cancelAllocation).not.toHaveBeenCalled();
    expect(t.schedule.clearScheduledEnd).not.toHaveBeenCalled();
    expect(t.requests.markUndone).not.toHaveBeenCalled();
  });
});
