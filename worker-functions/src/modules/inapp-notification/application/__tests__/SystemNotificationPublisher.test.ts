import { SystemNotificationPublisher, buildPtContactsPendingPayload, SYSTEM_NOTIFICATION_ACTOR_UID } from '../SystemNotificationPublisher';

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
