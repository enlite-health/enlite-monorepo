import {
  SystemNotificationPublisher,
  buildAdmissionTactiqLinkPayload,
  buildPtContactsPendingPayload,
  buildItineraryUncoveredShiftsPayload,
  buildPedidoIaAplicarPayload,
  buildAdmissionImportBlockedPayload,
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

describe('buildAdmissionTactiqLinkPayload — contrato da falta de assento (tactiq-vinculo-resiliente, D11)', () => {
  it('seat_missing ao host: audience + adminNotified + autoReactivates, e nada além', () => {
    expect(buildAdmissionTactiqLinkPayload('seat_missing', { audience: 'host', adminNotified: true, autoReactivates: false })).toEqual({
      reason: 'seat_missing', audience: 'host', adminNotified: true, autoReactivates: false,
    });
  });

  it('seat_missing ao master: hostName opcional (vazio some) e autoReactivates', () => {
    expect(buildAdmissionTactiqLinkPayload('seat_missing', { audience: 'master', hostName: 'Fulana Fake', autoReactivates: true })).toEqual({
      reason: 'seat_missing', audience: 'master', hostName: 'Fulana Fake', autoReactivates: true,
    });
    expect(buildAdmissionTactiqLinkPayload('seat_missing', { audience: 'master', hostName: '', autoReactivates: true })).toEqual({
      reason: 'seat_missing', audience: 'master', autoReactivates: true,
    });
  });

  it('broken ao master (token morto): audience + hostName, sem autoReactivates; sem extras segue só { reason }', () => {
    expect(buildAdmissionTactiqLinkPayload('broken', { audience: 'master', hostName: 'Fulana Fake' })).toEqual({
      reason: 'broken', audience: 'master', hostName: 'Fulana Fake',
    });
    expect(buildAdmissionTactiqLinkPayload('broken')).toEqual({ reason: 'broken' });
  });

  it.each([
    ['master com missing', 'missing', { audience: 'master' }],
    ['master com wrong_account', 'wrong_account', { audience: 'master' }],
    ['hostName em audience host', 'seat_missing', { audience: 'host', hostName: 'Fulana Fake', adminNotified: true, autoReactivates: true }],
    ['hostName sem audience', 'broken', { hostName: 'Fulana Fake' }],
    ['adminNotified na cópia master', 'seat_missing', { audience: 'master', adminNotified: true, autoReactivates: true }],
    ['adminNotified em broken', 'broken', { audience: 'host', adminNotified: true }],
    ['autoReactivates em broken', 'broken', { audience: 'master', autoReactivates: true }],
    ['seat_missing sem audience', 'seat_missing', { autoReactivates: true }],
    ['seat_missing sem autoReactivates', 'seat_missing', { audience: 'master' }],
    ['seat_missing ao host sem adminNotified', 'seat_missing', { audience: 'host', autoReactivates: true }],
    ['audience fora do conjunto', 'broken', { audience: 'supervisor' }],
  ])('combinação proibida lança: %s', (_n, reason, extras) => {
    expect(() => buildAdmissionTactiqLinkPayload(reason, extras)).toThrow(/admission_tactiq_link_payload/);
  });

  it('o publicador repassa os extras ao payload e NÃO grava com combinação proibida', async () => {
    const r = repo();
    await new SystemNotificationPublisher(r as never).publishAdmissionTactiqLinkRequired({} as never, {
      recipientUid: 'm1', reason: 'seat_missing', audience: 'master', hostName: 'Fulana Fake', autoReactivates: true,
    });
    expect(r.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { reason: 'seat_missing', audience: 'master', hostName: 'Fulana Fake', autoReactivates: true } }),
      expect.anything(),
    );
    const r2 = repo();
    await expect(
      new SystemNotificationPublisher(r2 as never).publishAdmissionTactiqLinkRequired({} as never, { recipientUid: 'm1', reason: 'missing', audience: 'master' }),
    ).rejects.toThrow();
    expect(r2.insertEvent).not.toHaveBeenCalled();
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

describe('SystemNotificationPublisher — importação bloqueada (spec 083, D-7)', () => {
  const host = { stage: 'blocked', kind: 'admission', reason: 'no_link', audience: 'host', meetingAt: '2026-11-02T15:00:00.000Z', deadlineAt: '2026-11-05T16:00:00.000Z' };
  const gestao = { ...host, stage: 'will_be_lost', audience: 'supervisor', hostName: 'Operadora Sintetica' };

  it('UM evento (ator system:admission, patientId null) + UMA notificação, payload com as chaves do contrato', async () => {
    const r = repo();
    const id = await new SystemNotificationPublisher(r as never).publishAdmissionImportBlocked({} as never, { recipientUid: 'op1', payload: host });
    expect(id).toBe('ev-1');
    expect(r.insertEvent).toHaveBeenCalledWith(
      { typeCode: 'ADMISSION_IMPORT_BLOCKED', actorUid: SYSTEM_ADMISSION_ACTOR_UID, patientId: null, conversationId: null, messageId: null, payload: host },
      expect.anything(),
    );
    expect(r.insertNotifications).toHaveBeenCalledWith('ev-1', ['op1'], expect.anything());
  });

  it('sem destinatário NUNCA cria evento', async () => {
    const r = repo();
    expect(await new SystemNotificationPublisher(r as never).publishAdmissionImportBlocked({} as never, { recipientUid: null, payload: host })).toBeNull();
    expect(r.insertEvent).not.toHaveBeenCalled();
  });

  it('o builder é FECHADO: chave extra (nome de paciente, código, id) NÃO entra', () => {
    const extra = { ...host, patientName: 'Ana Silva', code: 'ADM-7K3Q9P', appointmentId: 'x' };
    const out = buildAdmissionImportBlockedPayload(extra);
    expect(Object.keys(out).sort()).toEqual(['audience', 'deadlineAt', 'kind', 'meetingAt', 'reason', 'stage']);
    expect(JSON.stringify(out)).not.toContain('Ana Silva');
    expect(Object.keys(buildAdmissionImportBlockedPayload(gestao)).sort()).toEqual(['audience', 'deadlineAt', 'hostName', 'kind', 'meetingAt', 'reason', 'stage']);
  });

  it.each([
    ['stage', { stage: 'x' }], ['kind', { kind: 'x' }], ['reason', { reason: 'not_found' }], ['audience', { audience: 'x' }],
    ['meetingAt', { meetingAt: 'ontem' }], ['deadlineAt', { deadlineAt: '' }],
  ])('valor fora do conjunto (%s) lança', (_k, over) => {
    expect(() => buildAdmissionImportBlockedPayload({ ...host, ...over })).toThrow(/fora do contrato/);
  });

  it('combinação: will_be_lost só com supervisor; os outros só com host; hostName só com supervisor', () => {
    expect(() => buildAdmissionImportBlockedPayload({ ...host, stage: 'will_be_lost' })).toThrow(/combinação/);
    expect(() => buildAdmissionImportBlockedPayload({ ...gestao, stage: 'reminder' })).toThrow(/combinação/);
    expect(() => buildAdmissionImportBlockedPayload({ ...host, hostName: 'Fulana' })).toThrow(/hostName/);
    for (const stage of ['blocked', 'reminder', 'expired']) expect(buildAdmissionImportBlockedPayload({ ...host, stage }).stage).toBe(stage);
  });

  it('not_recorded (D11): só stage=expired ao host; o payload sai com as 6 chaves', () => {
    const ok = buildAdmissionImportBlockedPayload({ ...host, stage: 'expired', reason: 'not_recorded' });
    expect(ok).toEqual({ ...host, stage: 'expired', reason: 'not_recorded' });
  });

  it.each([
    ['blocked', { stage: 'blocked' }],
    ['reminder', { stage: 'reminder' }],
    ['will_be_lost (supervisor)', { stage: 'will_be_lost', audience: 'supervisor' }],
    ['expired ao supervisor', { stage: 'expired', audience: 'supervisor' }],
  ])('not_recorded fora de expired/host lança: %s', (_n, over) => {
    expect(() => buildAdmissionImportBlockedPayload({ ...host, reason: 'not_recorded', ...over })).toThrow(/combinação/);
  });

  it('publisher publica not_recorded expired/host (um evento, uma notificação)', async () => {
    const r = repo();
    const payload = { ...host, stage: 'expired', reason: 'not_recorded' };
    await new SystemNotificationPublisher(r as never).publishAdmissionImportBlocked({} as never, { recipientUid: 'op1', payload });
    expect(r.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ typeCode: 'ADMISSION_IMPORT_BLOCKED', payload }), expect.anything());
  });

  it('publisher que recebe payload inválido lança e nada grava', async () => {
    const r = repo();
    await expect(new SystemNotificationPublisher(r as never).publishAdmissionImportBlocked({} as never, { recipientUid: 'op1', payload: { ...host, stage: 'will_be_lost' } })).rejects.toThrow();
    expect(r.insertEvent).not.toHaveBeenCalled();
  });
});
