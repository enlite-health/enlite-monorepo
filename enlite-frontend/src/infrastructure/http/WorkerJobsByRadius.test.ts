/**
 * WorkerJobsByRadius (096, T201): serviço + hook, os 4 estados (ok | no_service_area | inactive | error).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { WorkerJobsByRadiusApiService, WorkerJobsByRadiusError } from './WorkerJobsByRadiusApiService';
import { useWorkerJobsByRadius } from '@presentation/hooks/useWorkerJobsByRadius';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: class { getIdToken = async () => 'tok'; },
}));

const HOME = { items: [], center: { lat: 1, lng: 2 }, applied: { schedule: true, profession: true, sex: true }, missing: [] };
const INCOMPLETE = { items: [], applied: { schedule: false, profession: true, sex: true }, missing: ['address', 'availability'] };
const reply = (status: number, body: unknown) => vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: status < 300, status, json: async () => body } as Response);

beforeEach(() => { vi.restoreAllMocks(); });

describe('WorkerJobsByRadiusApiService', () => {
  it('uma chamada: radius_km=100&view=home, com o token no Authorization', async () => {
    const spy = reply(200, HOME);
    await expect(WorkerJobsByRadiusApiService.getHome()).resolves.toEqual(HOME);
    expect(String(spy.mock.calls[0][0])).toContain('/api/workers/me/jobs?radius_km=100&view=home');
    expect((spy.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });
  it('409 NO_SERVICE_AREA e 403 ACCOUNT_INACTIVE viram erro tipado; outro status, HTTP_ERROR', async () => {
    reply(409, { code: 'NO_SERVICE_AREA' });
    await expect(WorkerJobsByRadiusApiService.getHome()).rejects.toMatchObject({ code: 'NO_SERVICE_AREA' });
    reply(403, { code: 'ACCOUNT_INACTIVE' });
    await expect(WorkerJobsByRadiusApiService.getHome()).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    reply(500, { success: false });
    await expect(WorkerJobsByRadiusApiService.getHome()).rejects.toBeInstanceOf(WorkerJobsByRadiusError);
  });
});

describe('corpo que não é a resposta da rota', () => {
  it('200 sem items/applied/missing (ex.: stub {success,data}) → HTTP_ERROR no serviço e estado error no hook; a home não cai', async () => {
    reply(200, { success: true, data: { id: 'x' } });
    await expect(WorkerJobsByRadiusApiService.getHome()).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    const { result } = renderHook(() => useWorkerJobsByRadius(true));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});

describe('useWorkerJobsByRadius', () => {
  it.each([
    [200, HOME, 'ok'],
    [409, { code: 'NO_SERVICE_AREA' }, 'incomplete'],
    [403, { code: 'ACCOUNT_INACTIVE' }, 'inactive'],
    [500, { success: false }, 'error'],
  ])('HTTP %i → %s', async (status, body, expected) => {
    reply(status, body);
    const { result } = renderHook(() => useWorkerJobsByRadius(true));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe(expected));
  });

  it('200 com missing → incomplete com a lista do que falta (sem endereço, sem center)', async () => {
    reply(200, INCOMPLETE);
    const { result } = renderHook(() => useWorkerJobsByRadius(true));
    await waitFor(() => expect(result.current).toEqual({ status: 'incomplete', missing: ['address', 'availability'] }));
  });

  it('409 NO_SERVICE_AREA (rota sem view) → incomplete [address]', async () => {
    reply(409, { code: 'NO_SERVICE_AREA' });
    const { result } = renderHook(() => useWorkerJobsByRadius(true));
    await waitFor(() => expect(result.current).toEqual({ status: 'incomplete', missing: ['address'] }));
  });

  it('desabilitado → idle (a home segue como sempre)', () => {
    expect(renderHook(() => useWorkerJobsByRadius(false)).result.current).toEqual({ status: 'idle' });
  });

  it('rede caída → error (a lista pública continua)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useWorkerJobsByRadius(true));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('desabilitado (sem usuário) → não chama a rota', () => {
    const spy = reply(200, HOME);
    renderHook(() => useWorkerJobsByRadius(false));
    expect(spy).not.toHaveBeenCalled();
  });
});
