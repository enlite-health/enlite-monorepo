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

// F3 (tactiq-vinculo-resiliente, D11/D14): assento e token morto; a chave sai de audience/adminNotified/autoReactivates.
describe('ADMISSION_TACTIQ_LINK_REQUIRED — F3 (seat_missing, audience, master broken)', () => {
  const h = () => getNotificationTypeHandler('ADMISSION_TACTIQ_LINK_REQUIRED');
  const tq = (payload: Record<string, unknown>) =>
    notif({ typeCode: 'ADMISSION_TACTIQ_LINK_REQUIRED', actorUid: 'system:admission', actorDisplayName: null, patientId: null, patientDisplayName: null, messageId: null, payload: payload as never });
  const base = 'admin.notifications.tactiq.';

  it('host auto: avisado e reativa sozinho → seatAuto', () => {
    expect(h().buildText(tq({ reason: 'seat_missing', audience: 'host', adminNotified: true, autoReactivates: true }), t)).toBe(`${base}seatAuto:{}`);
  });
  it('host wait: avisado e NÃO reativa sozinho → seatWait', () => {
    expect(h().buildText(tq({ reason: 'seat_missing', audience: 'host', adminNotified: true, autoReactivates: false }), t)).toBe(`${base}seatWait:{}`);
  });
  it('host sem master (ninguém avisado) → seatAskAdmin; adminNotified ausente também (não afirma que avisou)', () => {
    expect(h().buildText(tq({ reason: 'seat_missing', audience: 'host', adminNotified: false, autoReactivates: true }), t)).toBe(`${base}seatAskAdmin:{}`);
    expect(h().buildText(tq({ reason: 'seat_missing' }), t)).toBe(`${base}seatAskAdmin:{}`);
  });
  it('master auto com nome: masterSeat + masterSeatAuto, com o nome', () => {
    const out = h().buildText(tq({ reason: 'seat_missing', audience: 'master', hostName: 'Ana Souza', autoReactivates: true }), t);
    expect(out).toBe(`${base}masterSeat:{"host":"Ana Souza"}${base}masterSeatAuto:{"host":"Ana Souza"}`);
  });
  it('master ¬auto: masterSeat + masterSeatWait', () => {
    const out = h().buildText(tq({ reason: 'seat_missing', audience: 'master', hostName: 'Ana Souza', autoReactivates: false }), t);
    expect(out).toBe(`${base}masterSeat:{"host":"Ana Souza"}${base}masterSeatWait:{"host":"Ana Souza"}`);
  });
  it('master sem nome: usa o hostFallbackStart (nunca "undefined")', () => {
    const out = h().buildText(tq({ reason: 'seat_missing', audience: 'master' }), t);
    expect(out).toContain('admin.notifications.importBlocked.hostFallbackStart:{}');
    expect(out).not.toContain('undefined');
  });
  it('master broken (token morto) sem nome → masterBroken; broken do host segue "broken"', () => {
    expect(h().buildText(tq({ reason: 'broken', audience: 'master' }), t)).toBe(`${base}masterBroken:{"host":"admin.notifications.importBlocked.hostFallbackStart:{}"}`);
    expect(h().buildText(tq({ reason: 'broken', audience: 'host' }), t)).toBe(`${base}broken:{}`);
    expect(h().buildText(tq({ reason: 'broken' }), t)).toBe(`${base}broken:{}`);
  });
  it('valor estranho de reason continua em "missing", mesmo com audience master', () => {
    expect(h().buildText(tq({ reason: 'seat_banana', audience: 'master' }), t)).toBe(`${base}missing:{}`);
  });
  it('(F5) master seat_pending: com nome e sem nome (hostFallbackStart, nunca "undefined")', () => {
    expect(h().buildText(tq({ reason: 'seat_pending', audience: 'master', hostName: 'Ana Souza' }), t)).toBe(`${base}masterSeatPending:{"host":"Ana Souza"}`);
    const out = h().buildText(tq({ reason: 'seat_pending', audience: 'master' }), t);
    expect(out).toBe(`${base}masterSeatPending:{"host":"admin.notifications.importBlocked.hostFallbackStart:{}"}`);
    expect(out).not.toContain('undefined');
  });
  it('(F5) host seat_ready: firstLink=true → seatReadyFirst; firstLink=false → seatReadyAgain; audience/firstLink ausentes = host, 1º', () => {
    expect(h().buildText(tq({ reason: 'seat_ready', audience: 'host', firstLink: true }), t)).toBe(`${base}seatReadyFirst:{}`);
    expect(h().buildText(tq({ reason: 'seat_ready', audience: 'host', firstLink: false }), t)).toBe(`${base}seatReadyAgain:{}`);
    expect(h().buildText(tq({ reason: 'seat_ready' }), t)).toBe(`${base}seatReadyFirst:{}`);
  });
  it('(F5) combinação fora do contrato (seat_ready ao master, seat_pending ao host) cai em "missing"', () => {
    expect(h().buildText(tq({ reason: 'seat_ready', audience: 'master', firstLink: true }), t)).toBe(`${base}missing:{}`);
    expect(h().buildText(tq({ reason: 'seat_pending', audience: 'host' }), t)).toBe(`${base}missing:{}`);
    expect(h().detailLine?.(tq({ reason: 'seat_ready', audience: 'host', firstLink: true }), t)).toBe(`${base}seatReadyFirst:{}`);
  });
  it.each([['es', esJson], ['pt-BR', ptBRJson]] as const)('(F5) %s: textos reais de licença — nome do master, sem placeholder, Settings → MCP só no "again"', async (lng, json) => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: json } }, interpolation: { escapeValue: false } });
    const tr = i18n.t.bind(i18n) as unknown as (k: string, o?: Record<string, unknown>) => string;
    const pending = h().buildText(tq({ reason: 'seat_pending', audience: 'master', hostName: 'Ana Souza' }), tr);
    expect(pending).toContain('Ana Souza');
    expect(pending).not.toContain('{{');
    const first = h().buildText(tq({ reason: 'seat_ready', audience: 'host', firstLink: true }), tr);
    const again = h().buildText(tq({ reason: 'seat_ready', audience: 'host', firstLink: false }), tr);
    expect(first).not.toContain('Settings → MCP');
    expect(again).toContain('Settings → MCP');
    expect(first).toMatch(/@enlite\.health/);
  });
  it('detailLine acompanha o texto', () => {
    const n = tq({ reason: 'seat_missing', audience: 'host', adminNotified: true });
    expect(h().detailLine?.(n, t)).toBe(`${base}seatAuto:{}`);
  });

  it.each([['es', esJson], ['pt-BR', ptBRJson]] as const)('%s: textos reais — host sem "vincular"; master leva o nome (ou o fallback)', async (lng, json) => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: json } }, interpolation: { escapeValue: false } });
    const tr = i18n.t.bind(i18n) as unknown as (k: string, o?: Record<string, unknown>) => string;
    const host = [
      h().buildText(tq({ reason: 'seat_missing', audience: 'host', adminNotified: true, autoReactivates: true }), tr),
      h().buildText(tq({ reason: 'seat_missing', audience: 'host', adminNotified: true, autoReactivates: false }), tr),
      h().buildText(tq({ reason: 'seat_missing', audience: 'host', adminNotified: false }), tr),
    ];
    for (const text of host) {
      expect(text.length).toBeGreaterThan(20);
      expect(text.toLowerCase()).not.toMatch(/vincular|vinculá|vincule/);
    }
    const master = h().buildText(tq({ reason: 'seat_missing', audience: 'master', hostName: 'Ana Souza', autoReactivates: true }), tr);
    expect(master).toContain('Ana Souza');
    expect(master).not.toContain('{{');
    const fallback = h().buildText(tq({ reason: 'broken', audience: 'master' }), tr);
    expect(fallback).not.toContain('{{');
    expect(fallback).toMatch(lng === 'es' ? /La persona responsable/ : /A pessoa responsável/);
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

// Spec 078 (M4.4.2, gatilho (d)): pedido aceito em degrau 3/4 — texto com degrau e prazo, vindo do payload só-ids.
describe('PEDIDO_IA_APLICAR (spec 078, M4.4.2)', () => {
  const aviso = (payload: unknown) =>
    notif({ typeCode: 'PEDIDO_IA_APLICAR', actorUid: 'system:sol-fila', actorDisplayName: null, patientId: null, patientDisplayName: null, messageId: null, payload: payload as never });

  it.each([
    [{ pedido_id: 'p', degrau: 3, grave: false, prazo: 'semana' }, 'es', 'Pedido aceptado en escalón 3: aplicar esta semana'],
    [{ pedido_id: 'p', degrau: 4, grave: true, prazo: 'hoje' }, 'es', 'Pedido aceptado en escalón 4: aplicar hoy'],
    [{ pedido_id: 'p', degrau: 3, grave: false, prazo: 'semana' }, 'pt-BR', 'Pedido aceito no degrau 3: aplicar esta semana'],
    [{ pedido_id: 'p', degrau: 4, grave: true, prazo: 'hoje' }, 'pt-BR', 'Pedido aceito no degrau 4: aplicar hoje'],
    [null, 'es', 'Pedido aceptado: aplicar'],
    [{ degrau: 1, prazo: 'amanha' }, 'pt-BR', 'Pedido aceito: aplicar'],
  ] as const)('payload %j em %s -> "%s"; link para a página de pedidos', async (payload, lng, esperado) => {
    const json = lng === 'es' ? esJson : ptBRJson;
    const i18n = i18next.createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: { admin: { notifications: json.admin.notifications } } } } });
    const h = getNotificationTypeHandler('PEDIDO_IA_APLICAR');
    expect(h.buildText(aviso(payload), i18n.t.bind(i18n) as never)).toBe(esperado);
    expect(h.getDeepLink(aviso(payload))).toEqual({ path: '/admin/pedidos-ia' });
  });

  it('ator "Sol" e contexto "Pedidos do Sol"; sem detalhe', () => {
    const h = getNotificationTypeHandler('PEDIDO_IA_APLICAR');
    expect(h.actorLabel?.(aviso(null), t)).toBe('admin.notifications.pedidoIaActor:{}');
    expect(h.contextLine?.(aviso(null), t)).toBe('admin.notifications.pedidoIaContext:{}');
    expect(h.detailLine).toBeUndefined();
  });

  it('paridade es = pt-BR: as chaves de admin.notifications são as mesmas nos dois idiomas', () => {
    const flat = (o: Record<string, unknown>, pre = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${pre}${k}.`) : [`${pre}${k}`]));
    expect(flat(esJson.admin.notifications).sort()).toEqual(flat(ptBRJson.admin.notifications).sort());
  });
});

// Spec 083 (F4): o aviso "a transcrição não chegou por falta de vínculo do Tactiq" — o servidor manda só enums + 2 datas ISO (+ nome do host na cópia do supervisor).
describe('ADMISSION_IMPORT_BLOCKED (spec 083, F4)', () => {
  const aviso = (payload: unknown) =>
    notif({ typeCode: 'ADMISSION_IMPORT_BLOCKED', actorUid: 'system:admission', actorDisplayName: null, patientId: null, patientDisplayName: null, messageId: null, payload: payload as never });
  // 17:00Z = 14:00 em Buenos Aires (-03); 6/11 idem. Em UTC/Tokyo/LA o relógio local NÃO dá 14:00 — é o que a sabotagem de fuso mede.
  const HOST = { stage: 'blocked', kind: 'admission', reason: 'no_link', audience: 'host', meetingAt: '2026-11-04T17:00:00.000Z', deadlineAt: '2026-11-06T17:00:00.000Z' };
  const SUP = { ...HOST, stage: 'will_be_lost', audience: 'supervisor' };
  const handler = () => getNotificationTypeHandler('ADMISSION_IMPORT_BLOCKED');
  const realT = async (lng: 'es' | 'pt-BR') => {
    const json = lng === 'es' ? esJson : ptBRJson;
    const i18n = i18next.createInstance();
    await i18n.init({
      lng,
      resources: { [lng]: { translation: { admin: { notifications: json.admin.notifications, patients: { detail: { conversation: { thread: json.admin.patients.detail.conversation.thread } } } } } } },
      interpolation: { escapeValue: false },
    });
    return i18n.t.bind(i18n) as never;
  };

  it('o deep link abre /admin/mi-cuenta (seção Tactiq), sem paciente e sem pedido de foco', () => {
    expect(handler().getDeepLink(aviso(HOST))).toEqual({ path: '/admin/mi-cuenta' });
  });

  it('linhas do cartão: autor "Enlite", ação "Vincular Tactiq" (a MESMA chave dos vizinhos Tactiq) e o corpo na linha 3', () => {
    const n = aviso(HOST);
    expect(handler().actorLabel?.(n, t)).toBe('admin.notifications.ptContactsPendingActor:{}');
    expect(handler().contextLine?.(n, t)).toBe('admin.notifications.tactiq.action:{}');
    expect(handler().detailLine?.(n, t)).toContain('admin.notifications.importBlocked.blocked.body');
  });

  it.each([
    ['pt-BR', 'Não conseguimos trazer a transcrição da sua reunião de admissão de 4 de nov. às 14:00, porque a sua conta do Tactiq não está conectada.', 'Você tem até 6 de nov. às 14:00;'],
    ['es', 'No pudimos traer la transcripción de tu reunión de admisión del 4 de nov. a las 14:00, porque tu cuenta de Tactiq no está conectada.', 'Tenés tiempo hasta el 6 de nov. a las 14:00;'],
  ] as const)('data da reunião e prazo no FUSO DO OPERADOR com ISO fixo (%s)', async (lng, inicio, prazo) => {
    const body = handler().detailLine?.(aviso(HOST), await realT(lng)) ?? '';
    expect(body.startsWith(inicio)).toBe(true);
    expect(body).toContain(prazo);
  });

  it('enquadre usa "entrevista de enquadre"; wrong_account tem o motivo PRÓPRIO', async () => {
    const body = handler().detailLine?.(aviso({ ...HOST, kind: 'enquadre', reason: 'wrong_account' }), await realT('pt-BR')) ?? '';
    expect(body).toContain('sua entrevista de enquadre de 4 de nov. às 14:00, porque a conta do Tactiq conectada não é a sua.');
  });

  it.each([
    ['pt-BR', 'Esta entrevista não foi gravada no Tactiq', 'A sua reunião de admissão de 4 de nov. às 14:00 não foi gravada no Tactiq, então não há transcrição nem resumo.'],
    ['es', 'Esta entrevista no quedó grabada en Tactiq', 'Tu reunión de admisión del 4 de nov. a las 14:00 no quedó grabada en Tactiq, así que no hay transcripción ni resumen.'],
  ] as const)('not_recorded (expired, host) usa título e corpo PRÓPRIOS, sem prazo nem motivo de vínculo (%s)', async (lng, titulo, inicio) => {
    const t2 = await realT(lng);
    const n = aviso({ ...HOST, stage: 'expired', reason: 'not_recorded' });
    const body = handler().detailLine?.(n, t2) ?? '';
    expect(handler().buildText(n, t2).startsWith(`${titulo}. `)).toBe(true);
    expect(body.startsWith(inicio)).toBe(true);
    expect(body).not.toMatch(/\{\{|admin\.notifications/);
    expect(body).not.toContain('Vincular');
  });

  it('not_recorded fora de expired/host NÃO usa o texto de reunião sem gravação (cai no texto do estágio)', async () => {
    const t2 = await realT('pt-BR');
    for (const p of [{ ...HOST, reason: 'not_recorded' }, { ...HOST, stage: 'expired', reason: 'not_recorded', audience: 'supervisor' }]) {
      expect(handler().detailLine?.(aviso(p), t2) ?? '').not.toContain('não foi gravada no Tactiq');
    }
  });

  it.each([['pt-BR', 'a pessoa responsável'], ['es', 'la persona responsable']] as const)('supervisor: mostra o nome de quem fez a reunião; sem nome usa o fallback (%s)', async (lng, fallback) => {
    const t2 = await realT(lng);
    const com = handler().detailLine?.(aviso({ ...SUP, hostName: 'Marina Gómez' }), t2) ?? '';
    const sem = handler().detailLine?.(aviso(SUP), t2) ?? '';
    expect(com).toContain('Marina Gómez');
    expect(com).not.toContain(fallback);
    expect(sem).toContain(fallback);
    expect(sem).not.toContain('Marina');
    expect(handler().buildText(aviso({ ...SUP, hostName: 'Marina Gómez' }), t2)).toContain('Marina Gómez'); // título + corpo no aria-label
  });

  it('payload ausente/estranho: nunca crash, cai no aviso do host sem datas inventadas', async () => {
    for (const p of [null, {}, { stage: 'x', kind: 1, meetingAt: 5 }]) {
      expect(() => handler().buildText(aviso(p), t)).not.toThrow();
      expect(handler().getDeepLink(aviso(p))).toEqual({ path: '/admin/mi-cuenta' });
    }
    const body = handler().detailLine?.(aviso(null), await realT('pt-BR')) ?? '';
    expect(body).not.toMatch(/\d{4}-\d{2}/);
  });
});

// Spec 095 (T-095-43): o aviso do webhook do Talentum — o servidor manda só `{ alarme, quantidade, desde }`; o TEXTO vive aqui.
describe('TALENTUM_WEBHOOK_ALARM (spec 095, T-095-43)', () => {
  const aviso = (payload: unknown) =>
    notif({ typeCode: 'TALENTUM_WEBHOOK_ALARM', actorUid: 'system:talentum-webhook', actorDisplayName: null, patientId: null, patientDisplayName: null, messageId: null, payload: payload as never });
  const h = () => getNotificationTypeHandler('TALENTUM_WEBHOOK_ALARM');
  const realT = async (lng: 'es' | 'pt-BR') => {
    const i18n = i18next.createInstance();
    const json = lng === 'es' ? esJson : ptBRJson;
    await i18n.init({ lng, resources: { [lng]: { translation: { admin: { notifications: json.admin.notifications } } } } });
    return i18n.t.bind(i18n) as never;
  };

  it.each([
    [{ alarme: 'inbox_falha', quantidade: 3, desde: '2026-11-25T10:00:00.000Z' }, 'es', 'Webhook de Talentum: 3 eventos con error'],
    [{ alarme: 'silencio', quantidade: 1, desde: '2026-11-25T10:00:00.000Z' }, 'pt-BR', 'Webhook do Talentum: sem eventos em 6 h'],
    [{ alarme: 'silencio', quantidade: 1, desde: '2026-11-25T10:00:00.000Z' }, 'es', 'Webhook de Talentum: sin eventos en 6 h'],
    [{ alarme: 'CONFLITO_HUMANO', quantidade: 2, desde: '2026-11-25T10:00:00.000Z' }, 'pt-BR', 'Webhook do Talentum: 2 mudança manual no Talentum em conflito com um movimento da equipe'],
  ] as const)('payload %j em %s -> "%s"', async (payload, lng, esperado) => {
    expect(h().buildText(aviso(payload), await realT(lng))).toBe(esperado);
  });

  it('autor "Enlite" (nunca o uid do sistema), sem paciente e sem deep link', async () => {
    for (const lng of ['es', 'pt-BR'] as const) {
      expect(h().actorLabel?.(aviso(null), await realT(lng))).toBe('Enlite');
    }
    expect(h().getDeepLink(aviso({ alarme: 'inbox_falha', quantidade: 1, desde: 'x' }))).toBeNull();
  });

  it('alarme desconhecido / payload ausente ou estranho: rótulo genérico, nunca crash', async () => {
    for (const p of [null, {}, { alarme: 'futuro', quantidade: 'x' }, { alarme: 'inbox_falha', quantidade: -4 }]) {
      for (const lng of ['es', 'pt-BR'] as const) {
        const tt = await realT(lng);
        expect(() => h().buildText(aviso(p), tt)).not.toThrow();
        expect(h().buildText(aviso(p), tt)).toMatch(/^Webhook d[eo]l? Talentum: 1 /);
      }
    }
  });
});

// Emenda 077 §5.5 (T-806-54): os 2 avisos de presença à coordenação — payload só-ids, texto montado no cliente, link para a fila.
describe('PRESENCE_OPEN_4H / CHECK_IN_REFUSED_NO_ENTRY (emenda 077 §5.5)', () => {
  const PAYLOAD = { occurrence_id: 'o1', slot_id: 's1', on_date: '2026-11-25', worker_id: 'w1', service_id: 'sv1' };
  const aviso = (typeCode: 'PRESENCE_OPEN_4H' | 'CHECK_IN_REFUSED_NO_ENTRY', payload: unknown = PAYLOAD) =>
    notif({ typeCode, actorUid: 'system:presence-alert', actorDisplayName: null, patientDisplayName: null, messageId: null, payload: payload as never });
  const realT = async (lng: 'es' | 'pt-BR') => {
    const json = lng === 'es' ? esJson : ptBRJson;
    const i18n = i18next.createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: { admin: { notifications: json.admin.notifications } } } }, interpolation: { escapeValue: false } });
    return i18n.t.bind(i18n) as never;
  };

  it.each(['PRESENCE_OPEN_4H', 'CHECK_IN_REFUSED_NO_ENTRY'] as const)('%s: o deep link abre a fila "Revisión de presencia", sem paciente e sem pedido de foco', (code) => {
    expect(getNotificationTypeHandler(code).getDeepLink(aviso(code))).toEqual({ path: '/admin/presencia/revision' });
  });

  it.each([
    ['PRESENCE_OPEN_4H', 'es', 'Turno sin salida registrada: pasaron más de 4 h del fin previsto (25/11/2026).'],
    ['PRESENCE_OPEN_4H', 'pt-BR', 'Turno sem saída registrada: passaram mais de 4 h do fim previsto (25/11/2026).'],
    ['CHECK_IN_REFUSED_NO_ENTRY', 'es', 'Entrada rechazada y sin entrada aceptada: turno del 25/11/2026.'],
    ['CHECK_IN_REFUSED_NO_ENTRY', 'pt-BR', 'Entrada recusada e sem entrada aceita: turno de 25/11/2026.'],
  ] as const)('%s em %s: texto renderizado com a data do payload', async (code, lng, esperado) => {
    expect(getNotificationTypeHandler(code).buildText(aviso(code), await realT(lng))).toBe(esperado);
  });

  it('payload ausente/estranho: variante sem data, nunca "undefined" nem crash', async () => {
    for (const payload of [null, {}, { on_date: '25/11/2026' }]) {
      const es = getNotificationTypeHandler('PRESENCE_OPEN_4H').buildText(aviso('PRESENCE_OPEN_4H', payload), await realT('es'));
      expect(es).toBe('Turno sin salida registrada: pasaron más de 4 h del fin previsto.');
    }
  });

  it('o cartão não mostra nome de ninguém: ator "Enlite", contexto "Revisión de presencia", sem detalhe', () => {
    const h = getNotificationTypeHandler('PRESENCE_OPEN_4H');
    expect(h.actorLabel?.(aviso('PRESENCE_OPEN_4H'), t)).toBe('admin.notifications.presenceActor:{}');
    expect(h.contextLine?.(aviso('PRESENCE_OPEN_4H'), t)).toBe('admin.notifications.presenceContext:{}');
    expect(h.detailLine).toBeUndefined();
  });
});
