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
import type { TFunction } from 'i18next';
import { InviteBlockedError, blockedReasonMessage } from '@infrastructure/http/AdminMessagingApiService';
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

  it('convite bloqueado (422) guarda errorCode/errorDetail no item (mensagem é resolvida no componente)', async () => {
    sendMock.mockRejectedValueOnce(
      new InviteBlockedError('UNANSWERED_THROTTLE', 'texto PT-BR do backend'),
    );
    store().enqueue('vac-1', targets(1));

    await vi.advanceTimersByTimeAsync(6000);

    const item = store().items[0];
    expect(item.status).toBe('error');
    expect(item.errorCode).toBe('UNANSWERED_THROTTLE');
    expect(item.errorDetail).toBe('texto PT-BR do backend');
    // O store NÃO resolve mensagem (não depende de i18n).
    expect(item.error).toBeUndefined();
  });

  it('CODE desconhecido também guarda code+detail no item', async () => {
    sendMock.mockRejectedValueOnce(
      new InviteBlockedError('SOME_NEW_CODE', 'motivo específico del backend'),
    );
    store().enqueue('vac-1', targets(1));

    await vi.advanceTimersByTimeAsync(6000);

    const item = store().items[0];
    expect(item.errorCode).toBe('SOME_NEW_CODE');
    expect(item.errorDetail).toBe('motivo específico del backend');
  });

  it('deduplica re-enqueue do mesmo worker ainda pendente', async () => {
    store().enqueue('vac-1', targets(2));
    store().enqueue('vac-1', targets(2)); // mesmos w-0, w-1

    await vi.advanceTimersByTimeAsync(1000);

    expect(store().items).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});

describe('blockedReasonMessage', () => {
  // t fake: devolve `t:<chave>` pra provar QUAL chave foi pedida, sem i18n real.
  const t = ((key: string) => `t:${key}`) as unknown as TFunction;

  it('CODE conhecido → resolve pela chave localizada admin.messaging.blocked.<CODE>', () => {
    expect(blockedReasonMessage('UNANSWERED_THROTTLE', 'detail PT-BR', t)).toBe(
      't:admin.messaging.blocked.UNANSWERED_THROTTLE',
    );
  });

  it('CODE desconhecido com detail → usa o detail do backend', () => {
    expect(blockedReasonMessage('SOME_NEW_CODE', 'motivo del backend', t)).toBe('motivo del backend');
  });

  it('CODE desconhecido sem detail → cai no fallback genérico', () => {
    expect(blockedReasonMessage('SOME_NEW_CODE', undefined, t)).toBe('t:admin.messaging.statusErrorFallback');
  });
});
