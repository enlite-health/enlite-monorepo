import { describe, it, expect } from 'vitest';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import { classifyActionError, isForbiddenError } from '../contractedServiceActionError';

describe('classifyActionError', () => {
  it('403 → forbidden, mesmo com code no corpo', () => {
    expect(classifyActionError(new ContractedServiceApiError('x', 403, { code: 'FORBIDDEN' }))).toEqual({ kind: 'forbidden' });
  });

  it('erro da API com code (409/422) → coded, com o code e o erro original', () => {
    const err = new ContractedServiceApiError('x', 422, { code: 'SLOT_HAS_ACTIVE_ALLOCATION' });
    expect(classifyActionError(err)).toEqual({ kind: 'coded', code: 'SLOT_HAS_ACTIVE_ALLOCATION', error: err });
  });

  it('409 ITINERARY_OVERLAP → coded, e o erro original leva o overlap', () => {
    const side = { contractedServiceId: 's', startTime: '08:00', endTime: '12:00' };
    const err = new ContractedServiceApiError('x', 409, {
      code: 'ITINERARY_OVERLAP',
      existing: side,
      requested: side,
      sameAddress: false,
      minGapMinutes: null,
    } as never);
    const result = classifyActionError(err);
    expect(result.kind).toBe('coded');
    expect(result.kind === 'coded' && result.error.overlap).toBeTruthy();
  });

  it('erro da API sem code → error', () => {
    expect(classifyActionError(new ContractedServiceApiError('x', 500))).toEqual({ kind: 'error' });
  });

  it('erro que não é da API → error', () => {
    expect(classifyActionError(new Error('rede'))).toEqual({ kind: 'error' });
    expect(classifyActionError(undefined)).toEqual({ kind: 'error' });
  });
});

describe('isForbiddenError', () => {
  it('só o 403 da API é forbidden', () => {
    expect(isForbiddenError(new ContractedServiceApiError('x', 403))).toBe(true);
    expect(isForbiddenError(new ContractedServiceApiError('x', 401))).toBe(false);
    expect(isForbiddenError(Object.assign(new Error('x'), { status: 403 }))).toBe(false);
  });
});
