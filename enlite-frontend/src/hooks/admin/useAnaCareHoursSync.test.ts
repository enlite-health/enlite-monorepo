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

  it('CANCELAMENTO (A) — trocar de mês no meio de uma corrida em voo: o laço antigo NÃO marca done nem chama onComplete no mês novo', async () => {
    let resolveFirstRound: ((value: TriggerSyncResult) => void) | undefined;
    const pendingFirstRound = new Promise<TriggerSyncResult>((resolve) => {
      resolveFirstRound = resolve;
    });
    const trigger = vi.fn().mockReturnValueOnce(pendingFirstRound);
    const service = baseService(trigger);
    const onComplete = vi.fn();

    const { result: hook, rerender } = renderHook(({ month }) => useAnaCareHoursSync(service, month, onComplete), {
      initialProps: { month: '2026-08' },
    });

    act(() => hook.current.start());
    expect(hook.current.status).toBe('running');

    // Troca de mês ENQUANTO a rodada 1 do mês antigo ainda está em voo (promise não resolveu).
    rerender({ month: '2026-09' });
    expect(hook.current.status).toBe('idle');

    // A rodada do mês ANTIGO agora resolve — o laço antigo tenta seguir, mas tem de estar cancelado.
    await act(async () => {
      resolveFirstRound?.(result({ nextCursor: null }));
      await pendingFirstRound;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.current.status).not.toBe('done');
    expect(hook.current.status).toBe('idle');
    expect(onComplete).not.toHaveBeenCalled();
  });

  // D9 (cobertura, 18/09): os 3 `catch` de sessionStorage (readResumableCursor, persistCursor,
  // clearCursor) nunca tiveram o storage LANÇANDO de fato — os testes acima só exercitam o
  // caminho feliz do storage. Aqui o storage lança de verdade e a corrida PROSSEGUE (best-effort,
  // ver comentário de `readResumableCursor` no arquivo de produção).
  it('POSITIVO — sessionStorage.getItem lança (ex.: modo privado): resumableCursor cai para null, sem quebrar', async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('modo privado');
    });
    try {
      const trigger = vi.fn().mockResolvedValueOnce(result({ nextCursor: null }));
      const service = baseService(trigger);
      const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH));
      expect(hook.current.resumableCursor).toBeNull();

      act(() => hook.current.start());
      await waitFor(() => expect(hook.current.status).toBe('done'));
      expect(trigger.mock.calls[0][0]).toMatchObject({ month: MONTH, cursor: undefined });
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it('POSITIVO — sessionStorage.setItem lança no meio da corrida: cursor em memória avança normalmente, storage não trava a rodada seguinte', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota excedida');
    });
    try {
      const trigger = vi
        .fn()
        .mockResolvedValueOnce(result({ reservationsProcessed: 4, nextCursor: 50 }))
        .mockResolvedValueOnce(result({ reservationsProcessed: 3, nextCursor: null }));
      const service = baseService(trigger);
      const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH));
      act(() => hook.current.start());

      await waitFor(() => expect(hook.current.status).toBe('done'));
      expect(trigger).toHaveBeenCalledTimes(2);
      expect(trigger.mock.calls[1][0]).toMatchObject({ month: MONTH, cursor: 50 });
      expect(hook.current.resumableCursor).toBeNull();
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('POSITIVO — sessionStorage.removeItem lança ao terminar: status ainda vira "done" (limpeza é best-effort)', async () => {
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('indisponível');
    });
    try {
      const trigger = vi.fn().mockResolvedValueOnce(result({ nextCursor: null }));
      const service = baseService(trigger);
      const onComplete = vi.fn();
      const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH, onComplete));
      act(() => hook.current.start());

      await waitFor(() => expect(hook.current.status).toBe('done'));
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(hook.current.resumableCursor).toBeNull();
    } finally {
      removeItemSpy.mockRestore();
    }
  });

  it('DEDUPED (B) — resposta com deduped=true PARA o laço, não avança cursor nem chama onComplete', async () => {
    const trigger = vi.fn().mockResolvedValueOnce(result({ deduped: true, reservationsProcessed: 99, nextCursor: 50 }));
    const service = baseService(trigger);
    const onComplete = vi.fn();

    const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH, onComplete));
    act(() => hook.current.start());

    await waitFor(() => expect(hook.current.status).toBe('deduped'));

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(hook.current.reservationsProcessed).toBe(0);
    expect(hook.current.round).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
    expect(hook.current.resumableCursor).toBeNull();
    expect(sessionStorage.getItem('anacare-hours-sync:2026-08')).toBeNull();
  });
});
