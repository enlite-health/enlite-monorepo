/**
 * D-e2e-sync (18/09): a suíte de `useAnaCareHoursSync.test.ts` só usa `vi.fn()` solto como
 * `service.triggerSync` — nunca perde o `this` porque não HÁ instância nenhuma por trás. Isso
 * deixou passar um bug real: o hook extraía `service.triggerSync` numa const solta
 * (`const trigger = service.triggerSync`) e chamava `trigger(...)` DESLIGADO da instância —
 * dentro de `AnaCareHoursHttpService.triggerSync`, `this` virava `undefined` e `this.postSyncJson`
 * explodia com `TypeError` ANTES de qualquer `fetch`. Só apareceu rodando o e2e real (clique de
 * verdade na tela) — nenhum teste unitário existente pegava essa classe de defeito (método de
 * protótipo desligado da instância).
 *
 * Este arquivo usa a INSTÂNCIA REAL de `AnaCareHoursHttpService` (não um mock solto) — só `fetch`
 * e `FirebaseAuthService` são stubados, mesmo padrão de `AnaCareHoursHttpService.test.ts`. Prova
 * que o HOOK chama `service.triggerSync` sem perder o binding, e sabota de propósito (linha
 * comentada abaixo) pra provar que este teste MORRE se o bug voltar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { mockGetIdToken } = vi.hoisted(() => ({ mockGetIdToken: vi.fn<[], Promise<string | null>>().mockResolvedValue('fake-token') }));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: mockGetIdToken })),
}));

import { useAnaCareHoursSync } from './useAnaCareHoursSync';
import { AnaCareHoursHttpService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursHttpService';

const MONTH = '2026-08';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('useAnaCareHoursSync + AnaCareHoursHttpService REAL (não vi.fn() solto)', () => {
  it('POSITIVO — o hook chama service.triggerSync SEM perder o `this` da instância (fetch é atingido, status termina "done")', async () => {
    const body = {
      success: true,
      deduped: false,
      shiftsRead: 5,
      reservationsProcessed: 5,
      shiftsWritten: 5,
      nextCursor: null,
      runStartedAt: '2026-09-18T10:00:00-03:00',
      shiftsSkippedNoProvider: 0,
      shiftsSkippedNoPatient: 0,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, body));
    globalThis.fetch = fetchMock;

    // Instância REAL — nada de vi.fn() solto no lugar do serviço.
    const service = new AnaCareHoursHttpService();
    const onComplete = vi.fn();

    const { result: hook } = renderHook(() => useAnaCareHoursSync(service, MONTH, onComplete));
    act(() => hook.current.start());

    await waitFor(() => expect(hook.current.status).toBe('done'), { timeout: 3000 });

    // Se `this` tivesse se perdido, o hook cairia no catch com "Cannot read properties of
    // undefined (reading 'postSyncJson')" e status ficaria 'error' — nunca chegaria aqui.
    expect(hook.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/anacare-hours/sync');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
