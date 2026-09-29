/**
 * PatientItinerary (Fase 12, DX-12.6/DX-12.11) — as 2 funções puras da entidade.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isVigenteAt, coverageHoursPair, type PatientItineraryAssignment } from '../PatientItinerary';

const AS_OF = '2026-10-07';

function assignment(over: Partial<PatientItineraryAssignment> = {}): PatientItineraryAssignment {
  return {
    workerId: 'w1',
    applicationId: 'a1',
    validFrom: '2026-10-01',
    validTo: null,
    status: 'ACTIVE',
    allocationId: 'al1',
    displayName: null,
    ...over,
  };
}

describe('isVigenteAt', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('ACTIVE sem fim, iniciada antes de asOf → vigente', () => {
    expect(isVigenteAt(assignment(), AS_OF)).toBe(true);
  });

  it('validTo === asOf → vigente (último dia trabalhado é inclusivo)', () => {
    expect(isVigenteAt(assignment({ validTo: AS_OF }), AS_OF)).toBe(true);
  });

  it('validTo < asOf → não vigente', () => {
    expect(isVigenteAt(assignment({ validTo: '2026-10-06' }), AS_OF)).toBe(false);
  });

  it('validFrom === asOf → vigente; validFrom > asOf → não vigente', () => {
    expect(isVigenteAt(assignment({ validFrom: AS_OF }), AS_OF)).toBe(true);
    expect(isVigenteAt(assignment({ validFrom: '2026-10-08' }), AS_OF)).toBe(false);
  });

  it('ENDED → não vigente, mesmo dentro do intervalo', () => {
    expect(isVigenteAt(assignment({ status: 'ENDED' }), AS_OF)).toBe(false);
  });

  it('CANCELLED → não vigente, mesmo dentro do intervalo', () => {
    expect(isVigenteAt(assignment({ status: 'CANCELLED' }), AS_OF)).toBe(false);
  });

  it('não lê o relógio (Date.now nunca chamado)', () => {
    const spy = vi.spyOn(Date, 'now');
    isVigenteAt(assignment(), AS_OF);
    coverageHoursPair(4, 20);
    expect(spy).toHaveBeenCalledTimes(0);
  });
});

describe('coverageHoursPair', () => {
  it('(4, 20) → "4/20"', () => {
    expect(coverageHoursPair(4, 20)).toBe('4/20');
  });

  it('(0, null) → "0/—"', () => {
    expect(coverageHoursPair(0, null)).toBe('0/—');
  });
});
