/**
 * flowModel — spec 069, US3-US5: o modelo do fluxo. A tela só COLETA a escolha; o que o sistema sabe vem da pré-visão do servidor.
 * O que importa aqui: P16 (o passo 3 abre SEM escolha — "Siguiente" bloqueado), conflito tri-estado nunca vira livre, e o corpo do POST
 * leva o substituto OBRIGATÓRIO e nullable em cada turno.
 */
import { describe, it, expect } from 'vitest';
import type { PreviewConflict, PreviewShift } from '@domain/entities/SubstitutionRequest';
import {
  EMPTY_DRAFT,
  canAdvanceCover,
  chosenWorkers,
  conflictFor,
  createBody,
  periodPreviewBody,
  periodProblem,
  resolveCover,
  shiftKey,
  summarizeEntra,
  type FlowDraft,
} from '../flowModel';

const AS_OF = '2026-10-21';
const S1: PreviewShift = { date: '2026-11-02', slotId: 'sl-1', assignmentId: 'a-1', startTime: '09:00', endTime: '17:00' };
const S2: PreviewShift = { date: '2026-11-04', slotId: 'sl-2', assignmentId: 'a-2', startTime: '09:00', endTime: '17:00' };
const draft = (over: Partial<FlowDraft> = {}): FlowDraft => ({ ...EMPTY_DRAFT, outgoingWorkerId: 'w-out', type: 'DAYS', from: '2026-11-02', to: '2026-11-06', ...over });
const conflict = (workerId: string, shift: PreviewShift, state: PreviewConflict['state']): PreviewConflict => ({ workerId, date: shift.date, slotId: shift.slotId, state, overlaps: [] });

describe('periodProblem / periodPreviewBody', () => {
  it('sem tipo ou data → incomplete; data passada → past; fim antes do início → toBeforeFrom; ok → null', () => {
    expect(periodProblem(draft({ type: null }), AS_OF)).toBe('incomplete');
    expect(periodProblem(draft({ from: '' }), AS_OF)).toBe('incomplete');
    expect(periodProblem(draft({ from: '2026-10-20' }), AS_OF)).toBe('past');
    expect(periodProblem(draft({ to: '' }), AS_OF)).toBe('incomplete');
    expect(periodProblem(draft({ to: '2026-11-01' }), AS_OF)).toBe('toBeforeFrom');
    expect(periodProblem(draft(), AS_OF)).toBeNull();
    expect(periodProblem(draft({ type: 'ONE_DAY', to: '' }), AS_OF)).toBeNull();
    expect(periodProblem(draft({ type: 'PERMANENT', from: AS_OF }), AS_OF)).toBeNull(); // D = hoje vale
  });

  it('o corpo da pré-visão tem a forma de cada tipo (DAYS leva `to`; ONE_DAY e PERMANENT, não); período inválido ou sem pessoa → null', () => {
    expect(periodPreviewBody(draft(), AS_OF, ['w-a'])).toEqual({ type: 'DAYS', outgoingWorkerId: 'w-out', from: '2026-11-02', to: '2026-11-06', candidateWorkerIds: ['w-a'] });
    expect(periodPreviewBody(draft({ type: 'ONE_DAY' }), AS_OF)).toEqual({ type: 'ONE_DAY', outgoingWorkerId: 'w-out', from: '2026-11-02', candidateWorkerIds: [] });
    expect(periodPreviewBody(draft({ type: 'PERMANENT' }), AS_OF)).toEqual({ type: 'PERMANENT', outgoingWorkerId: 'w-out', from: '2026-11-02', candidateWorkerIds: [] });
    expect(periodPreviewBody(draft({ from: '2026-10-01' }), AS_OF)).toBeNull();
    expect(periodPreviewBody(draft({ outgoingWorkerId: null }), AS_OF)).toBeNull();
  });
});

describe('resolveCover / chosenWorkers / summarizeEntra', () => {
  it('P16: sem modo escolhido NINGUÉM está resolvido (undefined), em nenhum turno', () => {
    expect(resolveCover(draft(), [S1, S2])).toEqual({ [shiftKey(S1)]: undefined, [shiftKey(S2)]: undefined });
  });

  it('"Nadie todavía" resolve todo turno para null; "uma pessoa" vale para todos, com exceção por dia (null ou outra pessoa); "por día" só o que foi escolhido', () => {
    expect(resolveCover(draft({ coverMode: 'nobody', person: 'w-a' }), [S1, S2])).toEqual({ [shiftKey(S1)]: null, [shiftKey(S2)]: null });
    expect(resolveCover(draft({ coverMode: 'one', person: 'w-a' }), [S1, S2])).toEqual({ [shiftKey(S1)]: 'w-a', [shiftKey(S2)]: 'w-a' });
    expect(resolveCover(draft({ coverMode: 'one', person: 'w-a', dayChoices: { [shiftKey(S2)]: null } }), [S1, S2])).toEqual({ [shiftKey(S1)]: 'w-a', [shiftKey(S2)]: null });
    expect(resolveCover(draft({ coverMode: 'one', person: null }), [S1])).toEqual({ [shiftKey(S1)]: undefined });
    expect(resolveCover(draft({ coverMode: 'perDay', dayChoices: { [shiftKey(S1)]: 'w-b' } }), [S1, S2])).toEqual({ [shiftKey(S1)]: 'w-b', [shiftKey(S2)]: undefined });
  });

  it('chosenWorkers: só pessoas (nunca null/undefined), sem repetição, na ordem dos turnos', () => {
    expect(chosenWorkers({ a: 'w-b', b: null, c: undefined, d: 'w-a', e: 'w-b' })).toEqual(['w-b', 'w-a']);
  });

  it('summarizeEntra: ninguém → NOBODY; pessoas + os dias sem ninguém ("salvo …"), sem repetir a data', () => {
    expect(summarizeEntra({ [shiftKey(S1)]: null, [shiftKey(S2)]: null }, [S1, S2])).toEqual({ kind: 'NOBODY' });
    expect(summarizeEntra({ [shiftKey(S1)]: 'w-a', [shiftKey(S2)]: null }, [S1, S2])).toEqual({ kind: 'PEOPLE', workerIds: ['w-a'], uncoveredDates: ['2026-11-04'] });
    expect(summarizeEntra({ [shiftKey(S1)]: 'w-a' }, [S1, { ...S1, slotId: 'sl-9' }])).toEqual({ kind: 'PEOPLE', workerIds: ['w-a'], uncoveredDates: [] });
  });
});

describe('conflictFor / canAdvanceCover — tri-estado, falha nunca vira livre', () => {
  it('sem resposta (null) ou par ausente → pending; achado → o estado dele', () => {
    expect(conflictFor(null, 'w-a', S1)).toEqual({ state: 'pending', conflict: null });
    expect(conflictFor([], 'w-a', S1).state).toBe('pending');
    const c = conflict('w-a', S1, 'conflict');
    expect(conflictFor([c], 'w-a', S1)).toEqual({ state: 'conflict', conflict: c });
    expect(conflictFor([c], 'w-b', S1).state).toBe('pending'); // outra pessoa
    expect(conflictFor([c], 'w-a', S2).state).toBe('pending'); // outro turno
  });

  it('T609 (a prova da sabotagem): o passo 3 abre SEM escolha → "Siguiente" bloqueado; marcar "Nadie todavía" é uma escolha EXPLÍCITA', () => {
    expect(canAdvanceCover(draft(), [S1, S2], [])).toBe(false);
    expect(canAdvanceCover(draft({ coverMode: 'nobody' }), [S1, S2], [])).toBe(true);
  });

  it('sem turnos → bloqueado; "uma pessoa" sem a pessoa → bloqueado', () => {
    expect(canAdvanceCover(draft({ coverMode: 'nobody' }), [], [])).toBe(false);
    expect(canAdvanceCover(draft({ coverMode: 'one', person: null }), [S1], [])).toBe(false);
  });

  it('com pessoa: só avança com TODO turno livre; conflito, falha da verificação (null) e turno sem resposta bloqueiam', () => {
    const one = draft({ coverMode: 'one', person: 'w-a' });
    expect(canAdvanceCover(one, [S1, S2], [conflict('w-a', S1, 'free'), conflict('w-a', S2, 'free')])).toBe(true);
    expect(canAdvanceCover(one, [S1, S2], [conflict('w-a', S1, 'free'), conflict('w-a', S2, 'conflict')])).toBe(false);
    expect(canAdvanceCover(one, [S1, S2], [conflict('w-a', S1, 'free'), conflict('w-a', S2, 'unknown')])).toBe(false);
    expect(canAdvanceCover(one, [S1, S2], [conflict('w-a', S1, 'free')])).toBe(false);
    expect(canAdvanceCover(one, [S1, S2], null)).toBe(false);
  });

  it('o conflito de UM dia se resolve trocando a pessoa ou "Nadie todavía" NAQUELE dia', () => {
    const conflicts = [conflict('w-a', S1, 'conflict'), conflict('w-a', S2, 'free'), conflict('w-b', S1, 'free')];
    expect(canAdvanceCover(draft({ coverMode: 'one', person: 'w-a' }), [S1, S2], conflicts)).toBe(false);
    expect(canAdvanceCover(draft({ coverMode: 'one', person: 'w-a', dayChoices: { [shiftKey(S1)]: 'w-b' } }), [S1, S2], conflicts)).toBe(true);
    expect(canAdvanceCover(draft({ coverMode: 'one', person: 'w-a', dayChoices: { [shiftKey(S1)]: null } }), [S1, S2], conflicts)).toBe(true);
  });

  it('"por día": exige escolha em CADA turno', () => {
    const conflicts = [conflict('w-a', S1, 'free'), conflict('w-b', S2, 'free')];
    expect(canAdvanceCover(draft({ coverMode: 'perDay', dayChoices: { [shiftKey(S1)]: 'w-a' } }), [S1, S2], conflicts)).toBe(false);
    expect(canAdvanceCover(draft({ coverMode: 'perDay', dayChoices: { [shiftKey(S1)]: 'w-a', [shiftKey(S2)]: 'w-b' } }), [S1, S2], conflicts)).toBe(true);
  });
});

describe('createBody — o contrato do POST', () => {
  it('DAYS: turnos com o substituto OBRIGATÓRIO (pessoa ou null); motivo; período com `to`', () => {
    const body = createBody(draft({ coverMode: 'one', person: 'w-a', dayChoices: { [shiftKey(S2)]: null }, reason: 'VACATION' }), [S1, S2], false);
    expect(body).toEqual({
      type: 'DAYS', outgoingWorkerId: 'w-out', from: '2026-11-02', to: '2026-11-06', reasonCategory: 'VACATION',
      shifts: [{ date: S1.date, slotId: 'sl-1', substituteWorkerId: 'w-a' }, { date: S2.date, slotId: 'sl-2', substituteWorkerId: null }],
    });
    for (const shift of (body as unknown as { shifts: Array<Record<string, unknown>> }).shifts) expect('substituteWorkerId' in shift).toBe(true);
  });

  it('ONE_DAY: sem `to`', () => {
    expect(createBody(draft({ type: 'ONE_DAY', coverMode: 'nobody', reason: 'OTHER' }), [S1], false)).toEqual({
      type: 'ONE_DAY', outgoingWorkerId: 'w-out', from: '2026-11-02', reasonCategory: 'OTHER', shifts: [{ date: S1.date, slotId: 'sl-1', substituteWorkerId: null }],
    });
  });

  it('PERMANENT: `substituteWorkerId` pessoa ou null ("Nadie todavía" é aceito); destino só quando perguntado (D = hoje)', () => {
    const base = draft({ type: 'PERMANENT', reason: 'LEAVE', destination: 'RESERVE' });
    expect(createBody({ ...base, coverMode: 'one', person: 'w-a' }, [S1], false)).toEqual({ type: 'PERMANENT', outgoingWorkerId: 'w-out', from: '2026-11-02', reasonCategory: 'LEAVE', substituteWorkerId: 'w-a' });
    expect(createBody({ ...base, coverMode: 'nobody' }, [S1], false)).toMatchObject({ substituteWorkerId: null });
    expect(createBody({ ...base, coverMode: 'nobody' }, [S1], true)).toMatchObject({ substituteWorkerId: null, destination: 'RESERVE' });
    expect(createBody({ ...base, coverMode: 'nobody', destination: '' }, [S1], true)).not.toHaveProperty('destination');
    expect(createBody({ ...base, coverMode: 'nobody' }, [], false)).toMatchObject({ substituteWorkerId: null });
  });
});
