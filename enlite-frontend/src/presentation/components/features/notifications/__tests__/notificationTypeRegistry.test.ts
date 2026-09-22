/**
 * notificationTypeRegistry — spec 022, Rodada 2/R2-F. Fonte única de "o que cada TIPO de
 * notificação faz" (texto FR-015 + deep-link) — antes espalhado em `notificationText.ts` (texto)
 * e `NotificationPanel.handleClick` (deep-link), cada um com seu próprio `if/else` por typeCode.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AdminNotification } from '@infrastructure/http/AdminNotificationApiService';
import { getNotificationTypeHandler } from '../notificationTypeRegistry';

const t = vi.fn((key: string, opts?: Record<string, unknown>) => `${key}:${JSON.stringify(opts ?? {})}`);

function notif(overrides: Partial<AdminNotification> = {}): AdminNotification {
  return {
    id: 'n1',
    typeCode: 'CONVERSATION_MENTIONED',
    actorUid: 'staff-1',
    actorDisplayName: 'Ana Staff',
    patientId: 'p1',
    patientDisplayName: 'Fulano Paciente',
    conversationId: 'c1',
    messageId: 'm1',
    rootMessageId: null,
    messageExcerpt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('notificationTypeRegistry (spec 022, Rodada 2/R2-F)', () => {
  it('CONVERSATION_MENTIONED: buildText usa a chave "mentioned" com actor/patient', () => {
    const handler = getNotificationTypeHandler('CONVERSATION_MENTIONED');
    const text = handler.buildText(notif(), t);
    expect(text).toBe('admin.notifications.mentioned:{"actor":"Ana Staff","patient":"Fulano Paciente"}');
  });

  it('CONVERSATION_REPLIED: buildText usa a chave "replied"', () => {
    const handler = getNotificationTypeHandler('CONVERSATION_REPLIED');
    const text = handler.buildText(notif({ typeCode: 'CONVERSATION_REPLIED' }), t);
    expect(text).toBe('admin.notifications.replied:{"actor":"Ana Staff","patient":"Fulano Paciente"}');
  });

  it('actorDisplayName null: cai no actorUid cru (nunca inventa nome)', () => {
    const handler = getNotificationTypeHandler('CONVERSATION_MENTIONED');
    handler.buildText(notif({ actorDisplayName: null }), t);
    expect(t).toHaveBeenLastCalledWith('admin.notifications.mentioned', { actor: 'staff-1', patient: 'Fulano Paciente' });
  });

  it('patientDisplayName null (D-13): cai no fallback unknownPatient', () => {
    const handler = getNotificationTypeHandler('CONVERSATION_MENTIONED');
    handler.buildText(notif({ patientDisplayName: null }), t);
    expect(t).toHaveBeenCalledWith('admin.notifications.unknownPatient');
  });

  it('tipo DESCONHECIDO: fallback genérico, nunca crash', () => {
    const handler = getNotificationTypeHandler('SOME_FUTURE_TYPE');
    const text = handler.buildText(notif({ typeCode: 'SOME_FUTURE_TYPE' as never }), t);
    expect(text).toBe('admin.notifications.generic:{"actor":"Ana Staff"}');
  });

  it('os 2 tipos conhecidos e o fallback: getDeepLink com patientId navega pra conversa do paciente (comportamento IGUAL nos 3)', () => {
    for (const typeCode of ['CONVERSATION_MENTIONED', 'CONVERSATION_REPLIED', 'SOME_FUTURE_TYPE']) {
      const handler = getNotificationTypeHandler(typeCode);
      const deepLink = handler.getDeepLink(notif({ typeCode: typeCode as never, messageId: 'm1', rootMessageId: 'root1' }));
      expect(deepLink).toMatchObject({
        path: '/admin/patients/p1',
        focusRequest: { code: 'conversation', messageId: 'm1', rootMessageId: 'root1' },
      });
      expect(deepLink?.focusRequest.token).toEqual(expect.any(Number));
    }
  });

  it('sem patientId (D-08, notificação sem paciente associado): getDeepLink devolve null', () => {
    const handler = getNotificationTypeHandler('CONVERSATION_MENTIONED');
    expect(handler.getDeepLink(notif({ patientId: null }))).toBeNull();
  });

  it('rootMessageId ausente (mensagem de topo, não reply): focusRequest.rootMessageId é null', () => {
    const handler = getNotificationTypeHandler('CONVERSATION_MENTIONED');
    const deepLink = handler.getDeepLink(notif({ rootMessageId: null }));
    expect(deepLink?.focusRequest.rootMessageId).toBeNull();
  });

  it('messageId null: focusRequest.messageId vira undefined (nunca "null" string)', () => {
    const handler = getNotificationTypeHandler('CONVERSATION_MENTIONED');
    const deepLink = handler.getDeepLink(notif({ messageId: null }));
    expect(deepLink?.focusRequest.messageId).toBeUndefined();
  });
});
