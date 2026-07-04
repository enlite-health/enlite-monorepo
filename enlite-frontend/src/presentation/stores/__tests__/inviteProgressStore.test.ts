/**
 * inviteProgressStore.test.ts
 *
 * Núcleo assíncrono do envio em lote (estilo "upload do Drive"), agora global:
 *   - envio sequencial com espaçamento (rate-limit Twilio)
 *   - callback onMessaged por sucesso
 *   - auto-descarte após concluir sem erros
 *   - painel permanece aberto quando há erro
 *   - cancel interrompe os pendentes
 *   - dedupe de re-enqueue do mesmo worker ainda pendente
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useInviteProgressStore } from '../inviteProgressStore';
import type { InviteTarget } from '@presentation/components/features/admin/VacancyMatch/inviteTypes';

const sendMock = vi.fn();

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    sendVacancyMatchInvite: (workerId: string, vacancyId: string) =>
      sendMock(workerId, vacancyId),
  },
}));

function targets(n: number): InviteTarget[] {
  return Array.from({ length: n }, (_, i) => ({
    workerId: `w-${i}`,
    workerName: `Worker ${i}`,
    messagedAt: null,
  }));
}

const store = () => useInviteProgressStore.getState();

describe('inviteProgressStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMock.mockReset();
    sendMock.mockResolvedValue({ ok: true });
    store().dismiss();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('envia sequencialmente e marca todos como enviados', async () => {
    const onMessaged = vi.fn();
    store().enqueue('vac-1', targets(3), onMessaged);

    expect(store().isOpen).toBe(true);
    expect(store().isSending).toBe(true);

    await vi.advanceTimersByTimeAsync(1000); // > 2 × 300ms de espaçamento

    expect(store().items.map((i) => i.status)).toEqual(['sent', 'sent', 'sent']);
    expect(store().isSending).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock).toHaveBeenCalledWith('w-0', 'vac-1');
    expect(onMessaged).toHaveBeenCalledTimes(3);
  });

  it('auto-descarta ~5s após concluir sem erros', async () => {
    store().enqueue('vac-1', targets(1));
    await vi.advanceTimersByTimeAsync(50);

    expect(store().items).toHaveLength(1);
    expect(store().isOpen).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);

    expect(store().isOpen).toBe(false);
    expect(store().items).toHaveLength(0);
  });

  it('mantém o painel aberto quando há erro (sem auto-descarte)', async () => {
    sendMock.mockRejectedValueOnce(new Error('Twilio down'));
    store().enqueue('vac-1', targets(1));

    await vi.advanceTimersByTimeAsync(6000);

    const item = store().items[0];
    expect(item.status).toBe('error');
    expect(item.error).toBe('Twilio down');
    expect(store().isOpen).toBe(true);
  });

  it('cancel interrompe os envios pendentes', async () => {
    store().enqueue('vac-1', targets(3));
    await vi.advanceTimersByTimeAsync(50); // 1º envia

    store().cancel();
    await vi.advanceTimersByTimeAsync(2000);

    const statuses = store().items.map((i) => i.status);
    expect(statuses[0]).toBe('sent');
    expect(statuses.slice(1)).toEqual(['cancelled', 'cancelled']);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(store().isSending).toBe(false);
  });

  it('deduplica re-enqueue do mesmo worker ainda pendente', async () => {
    store().enqueue('vac-1', targets(2));
    store().enqueue('vac-1', targets(2)); // mesmos w-0, w-1

    await vi.advanceTimersByTimeAsync(1000);

    expect(store().items).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
