/**
 * useSubstitutionPeople — spec 069, US3/US5: "¿Quién no va a venir?" (pessoas com alocação no serviço) e "¿Quién la cubre?" (o pool do
 * serviço, `allocation-options`). 1 GET por montagem; falha vira `error` com lista vazia; desmontar antes da resposta não pinta nada.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import { useCoverCandidates, useOutgoingCandidates } from '../useSubstitutionPeople';

vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({ AdminContractedServicesApiService: { getAllocationOptions: vi.fn() } }));
vi.mock('@infrastructure/http/AdminSubstitutionRequestsApiService', () => ({ AdminSubstitutionRequestsApiService: { outgoingOptions: vi.fn() } }));
const outgoing = AdminSubstitutionRequestsApiService.outgoingOptions as ReturnType<typeof vi.fn>;
const options = AdminContractedServicesApiService.getAllocationOptions as ReturnType<typeof vi.fn>;

beforeEach(() => {
  outgoing.mockReset();
  options.mockReset();
});

describe('useOutgoingCandidates', () => {
  it('loading → ok com as pessoas', async () => {
    outgoing.mockResolvedValue([{ workerId: 'w-1', displayName: 'Ana' }]);
    const { result } = renderHook(() => useOutgoingCandidates('p-1', 's-1'));
    expect(result.current).toEqual({ people: [], status: 'loading' });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.people).toEqual([{ workerId: 'w-1', displayName: 'Ana' }]);
    expect(outgoing).toHaveBeenCalledWith('p-1', 's-1');
  });

  it('falha → error e lista vazia; desmontar antes da resposta não pinta', async () => {
    outgoing.mockRejectedValueOnce(new Error('boom'));
    const a = renderHook(() => useOutgoingCandidates('p-1', 's-1'));
    await waitFor(() => expect(a.result.current.status).toBe('error'));
    expect(a.result.current.people).toEqual([]);

    let resolve: (v: unknown) => void = () => undefined;
    outgoing.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const b = renderHook(() => useOutgoingCandidates('p-1', 's-1'));
    b.unmount();
    resolve([{ workerId: 'w-1', displayName: 'Ana' }]);
    await new Promise((r) => setTimeout(r, 5));
    expect(b.result.current.status).toBe('loading');
  });
});

describe('useCoverCandidates', () => {
  it('loading → ok com o pool (allocation-options)', async () => {
    options.mockResolvedValue({ options: [{ workerId: 'w-2', displayName: 'Bia', status: 'QUICK_RESPONSE' }] });
    const { result } = renderHook(() => useCoverCandidates('p-1', 's-1'));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.candidates).toEqual([{ workerId: 'w-2', displayName: 'Bia', status: 'QUICK_RESPONSE' }]);
    expect(options).toHaveBeenCalledWith('p-1', 's-1');
  });

  it('falha → error e lista vazia; desmontar antes da resposta não pinta', async () => {
    options.mockRejectedValueOnce(new Error('boom'));
    const a = renderHook(() => useCoverCandidates('p-1', 's-1'));
    await waitFor(() => expect(a.result.current.status).toBe('error'));
    expect(a.result.current.candidates).toEqual([]);

    let resolve: (v: unknown) => void = () => undefined;
    options.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const b = renderHook(() => useCoverCandidates('p-1', 's-1'));
    b.unmount();
    resolve({ options: [{ workerId: 'w-2' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(b.result.current.status).toBe('loading');
  });
});
