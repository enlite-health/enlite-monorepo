import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAnaCareHoursSync } from './useAnaCareHoursSync';
import { AnaCareHoursServiceError } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { AnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { TriggerSyncResult } from '@presentation/components/features/admin/AnaCareHours/types';

// change `anacare-horas-feedback-visual-sync` (Requisito 3) — o hook agora traduz o erro por
// CÓDIGO via `t(key, fallback)` (nunca `err.message`). O ambiente de teste (`src/test/setup.ts`)
// inicializa i18next com `resources: {}` (sem os JSON de verdade) — mockar `t` para devolver a
// PRÓPRIA CHAVE deixa o teste verificar qual chave o hook escolheu para cada classe de erro, sem
// depender do texto final (isso é responsabilidade do teste de paridade i18n, tarefa 7.1, e do
// e2e real, que carrega o Vite com os JSON de verdade).
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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
    reservationsTotal: 0,
    reservationsDone: 0,
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
    // Requisito 3: NUNCA `err.message`/texto técnico — tradução por CÓDIGO
    // (`admin.anacareHours.error.byCode.<CODE>`, mesmo namespace de `AnaCareHoursDetailContainer`).
    // O mock de `t` (topo do arquivo) devolve a própria chave — aqui só provamos QUAL chave, não o
    // texto final (isso é o teste de paridade i18n + o e2e real).
    expect(hook.current.error).toBe('admin.anacareHours.error.byCode.DESCONHECIDO');
    expect(hook.current.error).not.toContain('HTTP 500');
    // cursor da rodada 1 (bem-sucedida) foi persistido; a rodada 2 (que falhou) nunca sobrescreveu.
    expect(hook.current.resumableCursor).toBe(50);
    expect(sessionStorage.getItem('anacare-hours-sync:2026-08')).toBe(JSON.stringify({ cursor: 50 }));
  });

  it('NEGATIVO (Requisito 3) — erro de REDE (fetch rejeitando, sem AnaCareHoursServiceError) nunca vaza texto técnico do fetch — traduz por código NETWORK_ERROR', async () => {
    const trigger = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const service = baseService(trigger);

    const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH));
    act(() => hook.current.start());

    await waitFor(() => expect(hook.current.status).toBe('error'));

    expect(hook.current.error).toBe('admin.anacareHours.error.byCode.NETWORK_ERROR');
    expect(hook.current.error).not.toContain('Failed to fetch');
    expect(hook.current.error).not.toMatch(/^TypeError/);
  });

  it('NEGATIVO (Requisito 3) — 409 de colisão (AnaCareHoursServiceError DESCONHECIDO cuja .message embute anaCarePatientIds) nunca aparece na tela', async () => {
    // Mesmo formato que `AnaCareHoursHttpService.mapErrorCode` produz para o 409
    // `ANACARE_PATIENT_MONTH_COLLISION` (código fora de `KNOWN_ERROR_CODES` → cai em
    // 'DESCONHECIDO', mas a MENSAGEM original do backend (`e.message` de
    // `AnaCarePatientMonthCollisionError`) embute os ids do paciente).
    const leakedMessage = 'Conflito: anaCarePatientIds=["E2E-PATIENT-123"] já sendo processados por outra corrida';
    const trigger = vi.fn().mockRejectedValueOnce(new AnaCareHoursServiceError('DESCONHECIDO', leakedMessage));
    const service = baseService(trigger);

    const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH));
    act(() => hook.current.start());

    await waitFor(() => expect(hook.current.status).toBe('error'));

    expect(hook.current.error).not.toContain('anaCarePatientIds');
    expect(hook.current.error).not.toContain('E2E-PATIENT-123');
    expect(hook.current.error).toBe('admin.anacareHours.error.byCode.DESCONHECIDO');
  });

  it('POSITIVO (Requisito 1) — reservationsTotal/reservationsDone refletem o ACUMULADO de cada rodada (sobrescreve, nunca soma) e crescem a cada rodada', async () => {
    // Rodada 2 fica PENDENTE de propósito (mesmo padrão dos testes CANCELAMENTO acima) — sem
    // controlar o momento em que ela resolve, as duas rodadas resolveriam no mesmo flush de
    // microtasks e não daria para observar o estado INTERMEDIÁRIO (round 1) de forma determinística.
    let resolveSecondRound: ((value: TriggerSyncResult) => void) | undefined;
    const pendingSecondRound = new Promise<TriggerSyncResult>((resolve) => {
      resolveSecondRound = resolve;
    });
    const trigger = vi
      .fn()
      .mockResolvedValueOnce(result({ reservationsProcessed: 120, reservationsTotal: 285, reservationsDone: 120, nextCursor: 120 }))
      .mockReturnValueOnce(pendingSecondRound);
    const service = baseService(trigger);

    const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH));
    act(() => hook.current.start());

    // Rodada 1 já resolveu e a 2ª foi disparada (mock chamado) mas está presa em `pendingSecondRound`.
    await waitFor(() => expect(trigger).toHaveBeenCalledTimes(2));
    expect(hook.current.status).toBe('running');
    expect(hook.current.reservationsTotal).toBe(285);
    expect(hook.current.reservationsDone).toBe(120);

    await act(async () => {
      resolveSecondRound?.(result({ reservationsProcessed: 165, reservationsTotal: 285, reservationsDone: 285, nextCursor: null }));
      await pendingSecondRound;
    });

    await waitFor(() => expect(hook.current.status).toBe('done'));
    expect(hook.current.reservationsTotal).toBe(285);
    expect(hook.current.reservationsDone).toBe(285); // cresceu, nunca diminuiu
  });

  it('POSITIVO (risco nomeado em design.md) — resposta sem reservationsTotal/reservationsDone (ex.: backend antigo em cache) vira "sem contagem" (null), nunca NaN/undefined', async () => {
    const legacyResponse = { ...result({ nextCursor: null }) } as Partial<TriggerSyncResult>;
    delete legacyResponse.reservationsTotal;
    delete legacyResponse.reservationsDone;
    const trigger = vi.fn().mockResolvedValueOnce(legacyResponse as TriggerSyncResult);
    const service = baseService(trigger);

    const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH));
    act(() => hook.current.start());

    await waitFor(() => expect(hook.current.status).toBe('done'));
    expect(hook.current.reservationsTotal).toBeNull();
    expect(hook.current.reservationsDone).toBeNull();
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

  it('CANCELAMENTO (C) — trocar de mês e VOLTAR antes da rodada em voo resolver: o cursor persistido reidrata o estado, e o próximo start() o usa (não recomeça do zero)', async () => {
    let resolveFirstRound: ((value: TriggerSyncResult) => void) | undefined;
    const pendingFirstRound = new Promise<TriggerSyncResult>((resolve) => {
      resolveFirstRound = resolve;
    });
    const trigger = vi
      .fn()
      .mockReturnValueOnce(pendingFirstRound)
      .mockResolvedValueOnce(result({ nextCursor: null }));
    const service = baseService(trigger);
    const onComplete = vi.fn();

    const { result: hook, rerender } = renderHook(({ month }) => useAnaCareHoursSync(service, month, onComplete), {
      initialProps: { month: '2026-08' },
    });

    act(() => hook.current.start());
    expect(hook.current.status).toBe('running');

    // Troca para outro mês ENQUANTO a rodada do mês A ainda está em voo.
    rerender({ month: '2026-09' });
    expect(hook.current.status).toBe('idle');

    // Volta para o mês A ANTES de a rodada em voo resolver (cenário do gate de revisão).
    rerender({ month: '2026-08' });
    expect(hook.current.status).toBe('idle');
    expect(hook.current.interruptedMonth).toBeNull();

    await act(async () => {
      resolveFirstRound?.(result({ reservationsProcessed: 4, nextCursor: 5 }));
      await pendingFirstRound;
      await Promise.resolve();
      await Promise.resolve();
    });

    // O cursor foi persistido no storage do mês A...
    expect(sessionStorage.getItem('anacare-hours-sync:2026-08')).toBe(JSON.stringify({ cursor: 5 }));
    // ...e o estado do hook (já de volta a este mês) tem de refletir isso — sem duplicar aviso de
    // "outro mês interrompido", já que o usuário está literalmente neste mês agora.
    expect(hook.current.resumableCursor).toBe(5);
    expect(hook.current.interruptedMonth).toBeNull();
    expect(hook.current.status).toBe('idle');

    // O próximo start() deste mesmo mês tem de USAR o cursor persistido — não recomeçar do zero.
    act(() => hook.current.start());
    await waitFor(() => expect(hook.current.status).toBe('done'));
    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger.mock.calls[1][0]).toMatchObject({ month: '2026-08', cursor: 5 });
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

  it('POSITIVO — budgetMs enviado por rodada cabe no corte de 60s do Firebase Hosting em api.enlite.health: budget + overhead medido (~16s) fica abaixo de 60s, senão a resposta nunca chega ao navegador e a corrida fica "running" para sempre', async () => {
    const trigger = vi.fn().mockResolvedValueOnce(result({ nextCursor: null }));
    const service = baseService(trigger);

    const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH));
    act(() => hook.current.start());

    await waitFor(() => expect(hook.current.status).toBe('done'));

    const FIREBASE_HOSTING_CUTOFF_MS = 60_000;
    const MEASURED_OVERHEAD_MS = 16_000; // overhead medido em prd (Cloud Run + rede) até a resposta chegar ao navegador
    const budgetMs = trigger.mock.calls[0][0].budgetMs as number;
    expect(
      budgetMs,
      `budgetMs=${budgetMs}ms + overhead medido de até ${MEASURED_OVERHEAD_MS}ms tem que ficar abaixo do corte de ${FIREBASE_HOSTING_CUTOFF_MS}ms que o Firebase Hosting aplica em api.enlite.health — senão o navegador nunca recebe a resposta (CORS/ERR_FAILED) e a corrida trava em "running" para sempre em prd`,
    ).toBeLessThan(FIREBASE_HOSTING_CUTOFF_MS - MEASURED_OVERHEAD_MS);
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
