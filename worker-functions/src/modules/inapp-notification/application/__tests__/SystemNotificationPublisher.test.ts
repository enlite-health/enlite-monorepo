import {
  SystemNotificationPublisher,
  buildAdmissionTactiqLinkPayload,
  buildPtContactsPendingPayload,
  buildItineraryUncoveredShiftsPayload,
  buildPedidoIaAplicarPayload,
  SYSTEM_ITINERARY_ACTOR_UID,
  SYSTEM_ADMISSION_ACTOR_UID,
  SYSTEM_NOTIFICATION_ACTOR_UID,
  SYSTEM_SOL_FILA_ACTOR_UID,
} from '../SystemNotificationPublisher';

const base = { patientId: 'p-1', cycleId: 'c-1', versionId: 'v-1', dayOffset: 5 };

function repo() {
  let n = 0;
  return {
    insertEvent: jest.fn(async () => `ev-${++n}`),
    insertNotifications: jest.fn(async () => undefined),
  };
}

describe('SystemNotificationPublisher (spec 048)', () => {
  it('sem destinatário NUNCA cria evento (evento vazio é proibido)', async () => {
    const r = repo();
    const ids = await new SystemNotificationPublisher(r as never).publishPtContactsPending({} as never, { ...base, recipients: [] });
    expect(ids).toEqual([]);
    expect(r.insertEvent).not.toHaveBeenCalled();
    expect(r.insertNotifications).not.toHaveBeenCalled();
  });

  it('destinatário sem campo nenhum também não recebe nada', async () => {
    const r = repo();
    await new SystemNotificationPublisher(r as never).publishPtContactsPending({} as never, { ...base, recipients: [{ uid: 'u1', fields: [] }] });
    expect(r.insertEvent).not.toHaveBeenCalled();
  });

  it('o evento sai do sistema (sentinela), com payload só de ids + nome de campo, sem conversa nem mensagem', async () => {
    const r = repo();
    await new SystemNotificationPublisher(r as never).publishPtContactsPending({} as never, { ...base, recipients: [{ uid: 'u1', fields: ['RESPONSIBLE', 'CARE_TEAM'] }] });
    expect(r.insertEvent).toHaveBeenCalledWith(
      {
        typeCode: 'THERAPEUTIC_PROJECT_CONTACTS_PENDING',
        actorUid: SYSTEM_NOTIFICATION_ACTOR_UID,
        patientId: 'p-1',
        conversationId: null,
        messageId: null,
        payload: { cycleId: 'c-1', versionId: 'v-1', dayOffset: 5, fields: ['RESPONSIBLE', 'CARE_TEAM'] },
      },
      expect.anything(),
    );
    expect(Object.keys((r.insertEvent.mock.calls[0] as unknown as [{ payload: object }])[0].payload).sort()).toEqual(['cycleId', 'dayOffset', 'fields', 'versionId']);
  });

  it('cada destinatário recebe UMA notificação; quem tem os mesmos campos divide o evento, quem tem outros ganha o seu; uid repetido conta uma vez', async () => {
    const r = repo();
    const ids = await new SystemNotificationPublisher(r as never).publishPtContactsPending({} as never, {
      ...base,
      recipients: [
        { uid: 'op1', fields: ['RESPONSIBLE'] },
        { uid: 'op2', fields: ['RESPONSIBLE'] },
        { uid: 'master', fields: ['RESPONSIBLE', 'CARE_TEAM'] },
        { uid: 'op1', fields: ['CARE_TEAM'] },
      ],
    });
    expect(ids).toEqual(['ev-1', 'ev-2']);
    expect(r.insertNotifications.mock.calls.map((c) => (c as unknown as [string, string[]])[1])).toEqual([['op1', 'op2'], ['master']]);
  });

  it('o payload é fechado: campo fora do conjunto (ex.: um nome) é recusado', () => {
    expect(() => buildPtContactsPendingPayload({ cycleId: 'c', versionId: 'v', dayOffset: 2, fields: ['Maria Souza'] })).toThrow();
  });
});

describe('SystemNotificationPublisher — aviso do vínculo do Tactiq (spec 049 F4)', () => {
  it('um evento + UMA notificação, remetente system:admission, sem paciente/conversa/mensagem, payload só com o motivo', async () => {
    const r = repo();
    const id = await new SystemNotificationPublisher(r as never).publishAdmissionTactiqLinkRequired({} as never, { recipientUid: 'op1', reason: 'broken' });
    expect(id).toBe('ev-1');
    expect(r.insertEvent).toHaveBeenCalledWith(
      { typeCode: 'ADMISSION_TACTIQ_LINK_REQUIRED', actorUid: SYSTEM_ADMISSION_ACTOR_UID, patientId: null, conversationId: null, messageId: null, payload: { reason: 'broken' } },
      expect.anything(),
    );
    expect(r.insertNotifications).toHaveBeenCalledWith('ev-1', ['op1'], expect.anything());
    expect(SYSTEM_ADMISSION_ACTOR_UID).toBe('system:admission');
  });

  it('sem destinatário NUNCA cria evento', async () => {
    const r = repo();
    expect(await new SystemNotificationPublisher(r as never).publishAdmissionTactiqLinkRequired({} as never, { recipientUid: null, reason: 'missing' })).toBeNull();
    expect(r.insertEvent).not.toHaveBeenCalled();
    expect(r.insertNotifications).not.toHaveBeenCalled();
  });

  it('motivo fora do conjunto fechado é erro de programação (lança, nada grava)', async () => {
    const r = repo();
    expect(() => buildAdmissionTactiqLinkPayload('ana@example.test')).toThrow(/conjunto fechado/);
    await expect(new SystemNotificationPublisher(r as never).publishAdmissionTactiqLinkRequired({} as never, { recipientUid: 'op1', reason: 'x' })).rejects.toThrow();
    expect(r.insertEvent).not.toHaveBeenCalled();
  });
});

describe('SystemNotificationPublisher — aviso diário do itinerário (spec 069 F4)', () => {
  const item = { patientId: 'p1', serviceId: 's1', shifts: 2, firstDate: '2026-11-02' };

  it('UM evento (sentinela do sistema, sem paciente/conversa) + UMA notificação para o destinatário, com payload só-ids', async () => {
    const r = repo();
    const id = await new SystemNotificationPublisher(r as never).publishItineraryUncoveredShifts({} as never, { recipientUid: 'u1', operationDate: '2026-11-02', items: [item] });
    expect(id).toBe('ev-1');
    expect(r.insertEvent).toHaveBeenCalledWith(
      { typeCode: 'ITINERARY_UNCOVERED_SHIFTS', actorUid: SYSTEM_ITINERARY_ACTOR_UID, patientId: null, conversationId: null, messageId: null, payload: { operationDate: '2026-11-02', items: [item] } },
      {},
    );
    expect(r.insertNotifications).toHaveBeenCalledWith('ev-1', ['u1'], {});
  });

  it('o builder é FECHADO: campo extra (nome) não entra; valores fora do contrato lançam', () => {
    const comNome = { ...item, patientName: 'Ana Silva' } as typeof item;
    expect(JSON.stringify(buildItineraryUncoveredShiftsPayload({ operationDate: '2026-11-02', items: [comNome] }))).not.toContain('Ana Silva');
    expect(() => buildItineraryUncoveredShiftsPayload({ operationDate: '02/11/2026', items: [item] })).toThrow(/fora do contrato/);
    expect(() => buildItineraryUncoveredShiftsPayload({ operationDate: '2026-11-02', items: [] })).toThrow(/fora do contrato/);
    expect(() => buildItineraryUncoveredShiftsPayload({ operationDate: '2026-11-02', items: [{ ...item, shifts: 0 }] })).toThrow(/fora do contrato/);
    expect(() => buildItineraryUncoveredShiftsPayload({ operationDate: '2026-11-02', items: [{ ...item, shifts: 1.5 }] })).toThrow(/fora do contrato/);
    expect(() => buildItineraryUncoveredShiftsPayload({ operationDate: '2026-11-02', items: [{ ...item, firstDate: 'amanhã' }] })).toThrow(/fora do contrato/);
  });
});

describe('SystemNotificationPublisher.publishPedidoIa (spec 078, M3b-2)', () => {
  it('UM evento sem payload (nem assunto, nem id) e uma notificação por decisor, deduplicado; ator = sentinela da fila', async () => {
    const r = repo();
    const id = await new SystemNotificationPublisher(r as never).publishPedidoIa({} as never, { typeCode: 'PEDIDO_IA_GRAVE', recipientUids: ['u1', 'u2', 'u1'] });
    expect(id).toBe('ev-1');
    expect(r.insertEvent).toHaveBeenCalledTimes(1);
    expect(r.insertEvent).toHaveBeenCalledWith(
      { typeCode: 'PEDIDO_IA_GRAVE', actorUid: SYSTEM_SOL_FILA_ACTOR_UID, patientId: null, conversationId: null, messageId: null },
      expect.anything(),
    );
    expect(SYSTEM_SOL_FILA_ACTOR_UID).toBe('system:sol-fila');
    expect(r.insertNotifications).toHaveBeenCalledWith('ev-1', ['u1', 'u2'], expect.anything());
  });

  it('sem decisor NUNCA cria evento', async () => {
    const r = repo();
    expect(await new SystemNotificationPublisher(r as never).publishPedidoIa({} as never, { typeCode: 'PEDIDO_IA_NOVO', recipientUids: [] })).toBeNull();
    expect(r.insertEvent).not.toHaveBeenCalled();
  });
});

describe('SystemNotificationPublisher.publishPedidoIaAplicar (spec 078, M4.4.2)', () => {
  const PID = '11111111-1111-4111-8111-111111111111';

  it('UM evento com payload só-ids e UMA notificação por decisor (deduplicado); grave -> prazo hoje', async () => {
    const r = repo();
    const id = await new SystemNotificationPublisher(r as never).publishPedidoIaAplicar({} as never, { pedidoId: PID, degrau: 3, grave: true, recipientUids: ['u1', 'u2', 'u1'] });
    expect(id).toBe('ev-1');
    expect(r.insertEvent).toHaveBeenCalledTimes(1);
    expect(r.insertEvent).toHaveBeenCalledWith(
      { typeCode: 'PEDIDO_IA_APLICAR', actorUid: SYSTEM_SOL_FILA_ACTOR_UID, patientId: null, conversationId: null, messageId: null,
        payload: { pedido_id: PID, degrau: 3, grave: true, prazo: 'hoje' } },
      expect.anything(),
    );
    expect(r.insertNotifications).toHaveBeenCalledWith('ev-1', ['u1', 'u2'], expect.anything());
  });

  it('não grave -> prazo semana; sem decisor NUNCA cria evento', async () => {
    expect(buildPedidoIaAplicarPayload({ pedidoId: PID, degrau: 4, grave: false })).toEqual({ pedido_id: PID, degrau: 4, grave: false, prazo: 'semana' });
    const r = repo();
    expect(await new SystemNotificationPublisher(r as never).publishPedidoIaAplicar({} as never, { pedidoId: PID, degrau: 3, grave: false, recipientUids: [] })).toBeNull();
    expect(r.insertEvent).not.toHaveBeenCalled();
  });

  it('payload fora do contrato lança (degrau 1, id que não é uuid)', () => {
    expect(() => buildPedidoIaAplicarPayload({ pedidoId: PID, degrau: 1, grave: false })).toThrow();
    expect(() => buildPedidoIaAplicarPayload({ pedidoId: 'assunto do pedido', degrau: 3, grave: false })).toThrow();
  });
});
