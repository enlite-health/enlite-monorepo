/**
 * useServiceTeamContact — modal do prestador (rodada 2, decisão D): 1 GET por abertura (workerId
 * novo), `register` grava e recebe o histórico já recalculado (0 GET extra). Molde `useServiceTeam.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const getServiceTeamContact = vi.fn();
const registerServiceTeamContact = vi.fn();

vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    getServiceTeamContact: (...a: unknown[]) => getServiceTeamContact(...a),
    registerServiceTeamContact: (...a: unknown[]) => registerServiceTeamContact(...a),
  },
  ContractedServiceApiError: class ContractedServiceApiError extends Error {
    readonly status: number;
    readonly code?: string;
    constructor(message: string, status: number, body?: { code?: string }) {
      super(message);
      this.name = 'ContractedServiceApiError';
      this.status = status;
      this.code = body?.code;
    }
  },
}));

import { useServiceTeamContact } from '../useServiceTeamContact';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { ServiceTeamContact } from '@domain/entities/ServiceTeam';

function contact(workerId: string, history: ServiceTeamContact['history'] = []): ServiceTeamContact {
  return { workerId, displayName: 'Fixture', history };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useServiceTeamContact', () => {
  beforeEach(() => {
    getServiceTeamContact.mockReset();
    registerServiceTeamContact.mockReset();
  });

  it('serviceId ou workerId null: loading, 0 chamadas', () => {
    const { result } = renderHook(() => useServiceTeamContact('p1', null, null));
    expect(result.current.status).toBe('loading');
    expect(getServiceTeamContact).not.toHaveBeenCalled();
  });

  it('serviceId+workerId presentes: 1 GET, status ok, contact preenchido', async () => {
    getServiceTeamContact.mockResolvedValue(contact('w-1'));
    const { result } = renderHook(() => useServiceTeamContact('p1', 'svc-1', 'w-1'));

    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(getServiceTeamContact).toHaveBeenCalledTimes(1);
    expect(getServiceTeamContact).toHaveBeenCalledWith('p1', 'svc-1', 'w-1');
    expect(result.current.contact?.workerId).toBe('w-1');
  });

  it('403 → status forbidden', async () => {
    getServiceTeamContact.mockRejectedValue(new ContractedServiceApiError('forbidden', 403));
    const { result } = renderHook(() => useServiceTeamContact('p1', 'svc-1', 'w-1'));
    await waitFor(() => expect(result.current.status).toBe('forbidden'));
  });

  it('erro genérico → status error', async () => {
    getServiceTeamContact.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useServiceTeamContact('p1', 'svc-1', 'w-1'));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('trocar workerId descarta resposta atrasada da seleção anterior', async () => {
    const first = deferred<ServiceTeamContact>();
    const second = deferred<ServiceTeamContact>();
    getServiceTeamContact.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(({ workerId }) => useServiceTeamContact('p1', 'svc-1', workerId), {
      initialProps: { workerId: 'w-1' },
    });
    rerender({ workerId: 'w-2' });

    second.resolve(contact('w-2'));
    await waitFor(() => expect(result.current.contact?.workerId).toBe('w-2'));

    first.resolve(contact('w-1'));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.contact?.workerId).toBe('w-2');
  });

  it('register: chama registerServiceTeamContact e atualiza contact com a resposta (0 GET extra)', async () => {
    getServiceTeamContact.mockResolvedValue(contact('w-1', []));
    registerServiceTeamContact.mockResolvedValue(contact('w-1', [{ id: 'c-1', contacted: true, eventDate: '2026-09-29', note: 'ok', createdAt: '2026-09-29T10:00:00Z' }]));
    const { result } = renderHook(() => useServiceTeamContact('p1', 'svc-1', 'w-1'));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    await act(async () => {
      await result.current.register({ contacted: true, eventDate: '2026-09-29', note: 'ok' });
    });

    expect(registerServiceTeamContact).toHaveBeenCalledTimes(1);
    expect(registerServiceTeamContact).toHaveBeenCalledWith('p1', 'svc-1', 'w-1', { contacted: true, eventDate: '2026-09-29', note: 'ok' });
    expect(getServiceTeamContact).toHaveBeenCalledTimes(1); // só o GET inicial — register não refaz GET
    expect(result.current.contact?.history).toHaveLength(1);
    expect(result.current.saving).toBe(false);
    expect(result.current.saveError).toBeNull();
  });

  it('register com erro: saveError populado, contact anterior preservado', async () => {
    getServiceTeamContact.mockResolvedValue(contact('w-1', []));
    registerServiceTeamContact.mockRejectedValue(new ContractedServiceApiError('bad', 422, { code: 'SOME_CODE' }));
    const { result } = renderHook(() => useServiceTeamContact('p1', 'svc-1', 'w-1'));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    await act(async () => {
      await result.current.register({ contacted: false, eventDate: '2026-09-29', note: null });
    });

    expect(result.current.saveError).toBe('SOME_CODE');
    expect(result.current.contact?.workerId).toBe('w-1');
    expect(result.current.saving).toBe(false);
  });

  it('register sem serviceId/workerId: no-op (nenhuma chamada)', async () => {
    const { result } = renderHook(() => useServiceTeamContact('p1', null, null));
    await act(async () => {
      await result.current.register({ contacted: true, eventDate: '2026-09-29', note: null });
    });
    expect(registerServiceTeamContact).not.toHaveBeenCalled();
  });
});
