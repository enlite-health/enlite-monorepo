/**
 * notificationTypeRegistry — spec 022, Rodada 2/R2-F. Fonte única de "o que cada TIPO de
 * notificação faz" (texto FR-015 + deep-link) — antes espalhado em `notificationText.ts` (texto)
 * e `NotificationPanel.handleClick` (deep-link), cada um com seu próprio `if/else` por typeCode.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AdminNotification } from '@infrastructure/http/AdminNotificationApiService';
import i18next from 'i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
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
      expect(deepLink?.focusRequest?.token).toEqual(expect.any(Number));
    }
  });

  it('sem patientId (D-08, notificação sem paciente associado): getDeepLink devolve null', () => {
    const handler = getNotificationTypeHandler('CONVERSATION_MENTIONED');
    expect(handler.getDeepLink(notif({ patientId: null }))).toBeNull();
  });

  it('rootMessageId ausente (mensagem de topo, não reply): focusRequest.rootMessageId é null', () => {
    const handler = getNotificationTypeHandler('CONVERSATION_MENTIONED');
    const deepLink = handler.getDeepLink(notif({ rootMessageId: null }));
    expect(deepLink?.focusRequest?.rootMessageId).toBeNull();
  });

  it('messageId null: focusRequest.messageId vira undefined (nunca "null" string)', () => {
    const handler = getNotificationTypeHandler('CONVERSATION_MENTIONED');
    const deepLink = handler.getDeepLink(notif({ messageId: null }));
    expect(deepLink?.focusRequest?.messageId).toBeUndefined();
  });
});

// Spec 049 (F7, A7-7): o aviso do vínculo do Tactiq — o servidor manda só `{reason}`; o TEXTO vive aqui.
describe('ADMISSION_TACTIQ_LINK_REQUIRED (spec 049, A7-7)', () => {
  const tactiq = (reason: string | null) =>
    notif({
      typeCode: 'ADMISSION_TACTIQ_LINK_REQUIRED',
      actorUid: 'system:admission',
      actorDisplayName: null,
      patientId: null,
      patientDisplayName: null,
      messageId: null,
      payload: reason === null ? null : ({ reason } as never),
    });

  it('o deep link abre /admin/mi-cuenta, sem paciente e sem pedido de foco', () => {
    const link = getNotificationTypeHandler('ADMISSION_TACTIQ_LINK_REQUIRED').getDeepLink(tactiq('missing'));
    expect(link).toEqual({ path: '/admin/mi-cuenta' });
  });

  it.each([['missing'], ['broken']])('motivo %s → "Tu usuario no está vinculado a Tactiq…" (chave do texto sem vínculo)', (reason) => {
    const h = getNotificationTypeHandler('ADMISSION_TACTIQ_LINK_REQUIRED');
    expect(h.buildText(tactiq(reason), t)).toBe('admin.notifications.tactiq.' + (reason === 'broken' ? 'broken' : 'missing') + ':{}');
  });

  it('wrong_account tem o texto PRÓPRIO; payload ausente/estranho cai no texto de "sem vínculo", nunca crash', () => {
    const h = getNotificationTypeHandler('ADMISSION_TACTIQ_LINK_REQUIRED');
    expect(h.buildText(tactiq('wrong_account'), t)).toBe('admin.notifications.tactiq.wrong_account:{}');
    expect(h.buildText(tactiq(null), t)).toBe('admin.notifications.tactiq.missing:{}');
    expect(h.buildText(tactiq('qualquer'), t)).toBe('admin.notifications.tactiq.missing:{}');
  });

  it('linhas do card: autor "Enlite" (nunca o uid sentinela), ação "Vincular Tactiq" e a frase do motivo', () => {
    const h = getNotificationTypeHandler('ADMISSION_TACTIQ_LINK_REQUIRED');
    expect(h.actorLabel?.(tactiq('missing'), t)).toBe('admin.notifications.ptContactsPendingActor:{}');
    expect(h.contextLine?.(tactiq('missing'), t)).toBe('admin.notifications.tactiq.action:{}');
    expect(h.detailLine?.(tactiq('wrong_account'), t)).toBe('admin.notifications.tactiq.wrong_account:{}');
  });
});

// Spec 050 (F15, R-3): o aviso da transição do relatório do Chrome — o servidor manda só `{state}`; o TEXTO vive aqui.
describe('ADMISSION_TACTIQ_EXTENSION_CHANGED (spec 050, F15)', () => {
  const ext = (state: string | null) =>
    notif({
      typeCode: 'ADMISSION_TACTIQ_EXTENSION_CHANGED',
      actorUid: 'system:admission',
      actorDisplayName: null,
      patientId: null,
      patientDisplayName: null,
      messageId: null,
      payload: state === null ? null : ({ state } as never),
    });

  it('o deep link abre /admin/mi-cuenta, sem paciente e sem pedido de foco', () => {
    const link = getNotificationTypeHandler('ADMISSION_TACTIQ_EXTENSION_CHANGED').getDeepLink(ext('installed'));
    expect(link).toEqual({ path: '/admin/mi-cuenta' });
  });

  it.each([['installed'], ['missing'], ['disabled']])('estado %s tem o texto PRÓPRIO', (state) => {
    const h = getNotificationTypeHandler('ADMISSION_TACTIQ_EXTENSION_CHANGED');
    expect(h.buildText(ext(state), t)).toBe(`admin.notifications.tactiqExtension.${state}:{}`);
    expect(h.detailLine?.(ext(state), t)).toBe(`admin.notifications.tactiqExtension.${state}:{}`);
  });

  it('payload ausente/estranho cai no texto de "não está ativa", nunca no de "instalada" e nunca crash', () => {
    const h = getNotificationTypeHandler('ADMISSION_TACTIQ_EXTENSION_CHANGED');
    expect(h.buildText(ext(null), t)).toBe('admin.notifications.tactiqExtension.missing:{}');
    expect(h.buildText(ext('qualquer'), t)).toBe('admin.notifications.tactiqExtension.missing:{}');
  });
});

// Spec 069 (FR-35): o aviso diário "Sin cubrir" — o servidor manda só ids, contagem e data; o TEXTO vive aqui.
describe('ITINERARY_UNCOVERED_SHIFTS (spec 069, FR-35)', () => {
  const item = (patientId: string, serviceId: string, shifts: number, firstDate: string) => ({ patientId, serviceId, shifts, firstDate });
  const aviso = (items: ReturnType<typeof item>[] | null) =>
    notif({
      typeCode: 'ITINERARY_UNCOVERED_SHIFTS',
      actorUid: 'system:itinerary-daily',
      actorDisplayName: null,
      patientId: null,
      patientDisplayName: null,
      messageId: null,
      payload: items === null ? null : { operationDate: '2026-11-02', items },
    });
  const handler = () => getNotificationTypeHandler('ITINERARY_UNCOVERED_SHIFTS');
  const ITEMS = [item('p-b', 's-b', 3, '2026-11-05'), item('p-a', 's-a', 2, '2026-11-03')];

  it('texto: soma dos turnos e nº de serviços, CADA UM com a sua chave de plural (turnos e serviços não compartilham `count`)', () => {
    expect(handler().buildText(aviso(ITEMS), t)).toBe(
      'admin.notifications.itineraryUncoveredText:{"shifts":"admin.notifications.itineraryUncoveredShifts:{\\"count\\":5}","services":"admin.notifications.itineraryUncoveredServices:{\\"count\\":2}"}',
    );
  });

  // D5 (QA caça): "1 turnos sin cubrir" — o plural de "turno" seguia a contagem de SERVIÇOS. Aqui o i18next REAL renderiza os dois idiomas.
  it.each([
    ['es', esJson, [[1, 1, '1 turno sin cubrir en 1 servicio'], [5, 2, '5 turnos sin cubrir en 2 servicios'], [4, 1, '4 turnos sin cubrir en 1 servicio'], [3, 3, '3 turnos sin cubrir en 3 servicios']]],
    ['pt-BR', ptBRJson, [[1, 1, '1 turno sem cobertura em 1 serviço'], [5, 2, '5 turnos sem cobertura em 2 serviços'], [3, 3, '3 turnos sem cobertura em 3 serviços'], [4, 1, '4 turnos sem cobertura em 1 serviço']]],
  ] as const)('texto renderizado (%s) pluraliza turno(s) pelos TURNOS e servicio(s) pelos SERVIÇOS', async (lng, json, casos) => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: { admin: { notifications: json.admin.notifications } } } }, interpolation: { escapeValue: false } });
    for (const [shifts, services, esperado] of casos) {
      // `services` serviços, o total de `shifts` turnos repartido no primeiro (os demais com 0 não existem: cada item tem ≥ 1 turno)
      const items = Array.from({ length: services }, (_, i) => item(`p${i}`, `s${i}`, i === 0 ? shifts - (services - 1) : 1, '2026-11-03'));
      expect(handler().buildText(aviso(items), i18n.t.bind(i18n) as never)).toBe(esperado);
    }
  });

  it('o clique abre o serviço MAIS URGENTE (primeiro turno mais cedo) direto na aba, por ?tab=itinerary&serviceId=', () => {
    expect(handler().getDeepLink(aviso(ITEMS))).toEqual({ path: '/admin/patients/p-a?tab=itinerary&serviceId=s-a' });
  });

  it('linhas do cartão: ator "Enlite", contexto "Itinerario" e o primeiro turno em DD/MM', () => {
    const n = aviso(ITEMS);
    expect(handler().actorLabel?.(n, t)).toBe('admin.notifications.ptContactsPendingActor:{}');
    expect(handler().contextLine?.(n, t)).toBe('admin.notifications.itineraryUncoveredContext:{}');
    expect(handler().detailLine?.(n, t)).toBe('admin.notifications.itineraryUncoveredDetail:{"date":"03/11"}');
  });

  it('payload ausente/vazio: texto zerado, sem link e sem detalhe — nunca crash', () => {
    for (const n of [aviso(null), aviso([])]) {
      expect(handler().buildText(n, t)).toBe(
        'admin.notifications.itineraryUncoveredText:{"shifts":"admin.notifications.itineraryUncoveredShifts:{\\"count\\":0}","services":"admin.notifications.itineraryUncoveredServices:{\\"count\\":0}"}',
      );
      expect(handler().getDeepLink(n)).toBeNull();
      expect(handler().detailLine?.(n, t)).toBeNull();
    }
  });

  it('payload de OUTRO tipo (sem `items`) é tratado como vazio', () => {
    const n = notif({ typeCode: 'ITINERARY_UNCOVERED_SHIFTS', payload: { reason: 'missing' } as never });
    expect(handler().getDeepLink(n)).toBeNull();
  });
});

// Spec 078 (M3b-2): o aviso do pedido do Sol — sem assunto, sem texto, sem paciente; o clique leva à página de pedidos.
describe('PEDIDO_IA_NOVO / PEDIDO_IA_GRAVE (spec 078, M3b-2)', () => {
  const aviso = (typeCode: 'PEDIDO_IA_NOVO' | 'PEDIDO_IA_GRAVE') =>
    notif({ typeCode, actorUid: 'system:sol-fila', actorDisplayName: null, patientId: null, patientDisplayName: null, messageId: null });

  it.each([
    ['PEDIDO_IA_NOVO', 'pedidoIaNovo', 'Novo pedido do Sol', 'Nuevo pedido del Sol'],
    ['PEDIDO_IA_GRAVE', 'pedidoIaGrave', 'Pedido grave do Sol aguarda sua decisão', 'Pedido grave del Sol espera tu decisión'],
  ] as const)('%s: chave própria, texto renderizado es/pt-BR e link para a página de pedidos', async (code, key, pt, es) => {
    const h = getNotificationTypeHandler(code);
    expect(h.buildText(aviso(code), t)).toBe(`admin.notifications.${key}:{}`);
    expect(h.getDeepLink(aviso(code))).toEqual({ path: '/admin/pedidos-ia' });
    for (const [lng, json, esperado] of [['es', esJson, es], ['pt-BR', ptBRJson, pt]] as const) {
      const i18n = i18next.createInstance();
      await i18n.init({ lng, resources: { [lng]: { translation: { admin: { notifications: json.admin.notifications } } } } });
      expect(h.buildText(aviso(code), i18n.t.bind(i18n) as never)).toBe(esperado);
    }
  });

  it('ator "Sol" e contexto "Pedidos do Sol"; sem detalhe (nada do pedido aparece no cartão)', () => {
    const h = getNotificationTypeHandler('PEDIDO_IA_GRAVE');
    expect(h.actorLabel?.(aviso('PEDIDO_IA_GRAVE'), t)).toBe('admin.notifications.pedidoIaActor:{}');
    expect(h.contextLine?.(aviso('PEDIDO_IA_GRAVE'), t)).toBe('admin.notifications.pedidoIaContext:{}');
    expect(h.detailLine).toBeUndefined();
  });
});
