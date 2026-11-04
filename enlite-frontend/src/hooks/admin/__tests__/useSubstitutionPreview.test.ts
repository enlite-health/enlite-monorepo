/**
 * useSubstitutionPreview — spec 069, FR-15: a pré-visão (turnos, conflito tri-estado, estado novo) carrega do servidor; `body = null` não
 * pergunta; muda o CORPO (por valor) → refaz; resposta atrasada não sobrescreve; erro com código expõe o código, nunca vira "sem conflito".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { SubstitutionPreviewBody } from '@domain/entities/SubstitutionRequest';
import { useSubstitutionPreview } from '../useSubstitutionPreview';

vi.mock('@infrastructure/http/AdminSubstitutionRequestsApiService', () => ({ AdminSubstitutionRequestsApiService: { preview: vi.fn() } }));
const preview = AdminSubstitutionRequestsApiService.preview as ReturnType<typeof vi.fn>;

const BODY: SubstitutionPreviewBody = { type: 'ONE_DAY', outgoingWorkerId: 'w-1', from: '2026-11-03', candidateWorkerIds: [] };
const RESULT = { shifts: [{ date: '2026-11-03', slotId: 's', assignmentId: 'a', startTime: '09:00', endTime: '17:00' }], conflicts: [], statusAfter: null };

beforeEach(() => {
  preview.mockReset();
});

describe('useSubstitutionPreview', () => {
  it('body null → idle, nenhuma chamada', () => {
    const { result } = renderHook(() => useSubstitutionPreview('p-1', 's-1', null));
    expect(result.current).toEqual({ status: 'idle', preview: null, errorCode: null });
    expect(preview).not.toHaveBeenCalled();
  });

  it('feliz: 1 POST com o corpo; loading → ok com a pré-visão', async () => {
    preview.mockResolvedValue(RESULT);
    const { result } = renderHook(() => useSubstitutionPreview('p-1', 's-1', BODY));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.preview).toEqual(RESULT);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith('p-1', 's-1', BODY);
  });

  it('corpo igual POR VALOR (objeto novo, mesmo conteúdo) não refaz; corpo diferente refaz e zera a anterior enquanto carrega', async () => {
    preview.mockResolvedValue(RESULT);
    const { result, rerender } = renderHook(({ body }) => useSubstitutionPreview('p-1', 's-1', body), { initialProps: { body: BODY } });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    rerender({ body: { ...BODY } });
    expect(preview).toHaveBeenCalledTimes(1);
    rerender({ body: { ...BODY, candidateWorkerIds: ['w-2'] } });
    expect(result.current.status).toBe('loading');
    expect(result.current.preview).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(preview).toHaveBeenCalledTimes(2);
    rerender({ body: null as unknown as typeof BODY });
    expect(result.current.status).toBe('idle');
  });

  it('erro com código (422) expõe o código; erro sem código → errorCode null; nunca preview', async () => {
    preview.mockRejectedValueOnce(new ContractedServiceApiError('x', 422, { code: 'SUBSTITUTION_NO_SHIFTS_IN_PERIOD' }));
    const a = renderHook(() => useSubstitutionPreview('p-1', 's-1', BODY));
    await waitFor(() => expect(a.result.current.status).toBe('error'));
    expect(a.result.current).toEqual({ status: 'error', preview: null, errorCode: 'SUBSTITUTION_NO_SHIFTS_IN_PERIOD' });
    preview.mockRejectedValueOnce(new Error('boom'));
    const b = renderHook(() => useSubstitutionPreview('p-1', 's-1', BODY));
    await waitFor(() => expect(b.result.current.status).toBe('error'));
    expect(b.result.current.errorCode).toBeNull();
  });

  it('guarda por requestId: a resposta (sucesso ou erro) de um corpo antigo NÃO sobrescreve a do corpo atual', async () => {
    let resolveFirst: (v: unknown) => void = () => undefined;
    let rejectSecond: (e: unknown) => void = () => undefined;
    preview.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    preview.mockImplementationOnce(() => new Promise((_r, rej) => (rejectSecond = rej)));
    preview.mockResolvedValueOnce(RESULT);
    const { result, rerender } = renderHook(({ body }) => useSubstitutionPreview('p-1', 's-1', body), { initialProps: { body: BODY } });
    rerender({ body: { ...BODY, from: '2026-11-04' } });
    rerender({ body: { ...BODY, from: '2026-11-05' } });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    resolveFirst({ ...RESULT, shifts: [] });
    rejectSecond(new Error('tarde'));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.status).toBe('ok');
    expect(result.current.preview).toEqual(RESULT);
  });
});
