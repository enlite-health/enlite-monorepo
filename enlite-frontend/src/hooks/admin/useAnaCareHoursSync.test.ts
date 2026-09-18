import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAnaCareHoursSync } from './useAnaCareHoursSync';
import { AnaCareHoursServiceError } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { AnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { TriggerSyncResult } from '@presentation/components/features/admin/AnaCareHours/types';

function baseService(triggerSync: AnaCareHoursService['triggerSync']): AnaCareHoursService {
  return {
    getMonthSnapshot: vi.fn(),
    getPatientMonth: vi.fn(),
    getRetratoStatus: vi.fn(),
    validateShift: vi.fn(),
    validateBatch: vi.fn(),
    contestShift: vi.fn(),
    triggerSync,
  };
}

function result(overrides: Partial<TriggerSyncResult> = {}): TriggerSyncResult {
  return {
    success: true,
    deduped: false,
    shiftsRead: 10,
    reservationsProcessed: 5,
    shiftsWritten: 10,
    nextCursor: null,
    runStartedAt: '2026-09-18T10:00:00-03:00',
    shiftsSkippedNoProvider: 0,
    shiftsSkippedNoPatient: 0,
    ...overrides,
  };
}

const MONTH = '2026-08';

beforeEach(() => {
  sessionStorage.clear();
});

describe('useAnaCareHoursSync', () => {
  it('POSITIVO — laço com 2 rodadas até nextCursor null, soma reservationsProcessed, chama onComplete e limpa sessionStorage', async () => {
    const trigger = vi
      .fn()
      .mockResolvedValueOnce(result({ reservationsProcessed: 4, nextCursor: 50 }))
      .mockResolvedValueOnce(result({ reservationsProcessed: 3, nextCursor: null }));
    const service = baseService(trigger);
    const onComplete = vi.fn();

    const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH, onComplete));
    act(() => hook.current.start());

    await waitFor(() => expect(hook.current.status).toBe('done'));

    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger.mock.calls[0][0]).toMatchObject({ month: MONTH, cursor: undefined });
    expect(trigger.mock.calls[1][0]).toMatchObject({ month: MONTH, cursor: 50 });
    expect(hook.current.round).toBe(2);
    expect(hook.current.reservationsProcessed).toBe(7);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(hook.current.resumableCursor).toBeNull();
    expect(sessionStorage.getItem('anacare-hours-sync:2026-08')).toBeNull();
  });

  it('NEGATIVO — erro na 2ª rodada PARA o laço, preserva o cursor da 1ª rodada e NUNCA marca sucesso', async () => {
    const trigger = vi
      .fn()
      .mockResolvedValueOnce(result({ reservationsProcessed: 4, nextCursor: 50 }))
      .mockRejectedValueOnce(new AnaCareHoursServiceError('DESCONHECIDO', 'Erro ao conectar ao servidor (HTTP 500).'));
    const service = baseService(trigger);
    const onComplete = vi.fn();

    const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH, onComplete));
    act(() => hook.current.start());

    await waitFor(() => expect(hook.current.status).toBe('error'));

    expect(hook.current.status).not.toBe('done');
    expect(onComplete).not.toHaveBeenCalled();
    expect(hook.current.error).toBe('Erro ao conectar ao servidor (HTTP 500).');
    // cursor da rodada 1 (bem-sucedida) foi persistido; a rodada 2 (que falhou) nunca sobrescreveu.
    expect(hook.current.resumableCursor).toBe(50);
    expect(sessionStorage.getItem('anacare-hours-sync:2026-08')).toBe(JSON.stringify({ cursor: 50 }));
  });

  it('POSITIVO — retomada do sessionStorage: hook novo (ex.: após refresh) lê o cursor persistido e o usa na 1ª rodada', async () => {
    sessionStorage.setItem('anacare-hours-sync:2026-08', JSON.stringify({ cursor: 120 }));
    const trigger = vi.fn().mockResolvedValueOnce(result({ nextCursor: null }));
    const service = baseService(trigger);

    const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH));
    expect(hook.current.resumableCursor).toBe(120);

    act(() => hook.current.start());
    await waitFor(() => expect(hook.current.status).toBe('done'));

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0]).toMatchObject({ month: MONTH, cursor: 120 });
  });
});
