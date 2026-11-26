/**
 * CoordinationAlertUseCase (emenda 077 §5.5) — portas com dublês, nenhum canal real (e-mail e notificação são fakes; o `EmailService` real nunca é chamado).
 * O store fake modela a UNIQUE (kind, occurrence_id) do banco (a prova contra Postgres real está em `tests/repo/CoordinationAlertStore.repo.test.ts`).
 */
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn() }, reportError: (...a: unknown[]) => mockReportError(...a) }));

import { CoordinationAlertUseCase } from '../CoordinationAlertUseCase';
import type {
  AlertRecipient, AlertToDeliver, AlertTransaction, AttendancePresenceAlertReader, CoordinationAlertChannel, CoordinationAlertKind,
  CoordinationAlertStore, DeliveryChannelCode, DeliveryOutcome, DeliveryStatus, OpenPresenceRecord, RefusedWithoutEntryRecord, ShiftFacts,
} from '../ports/CoordinationAlertPorts';
import { PresenceAlertRecipients } from '../../infrastructure/PresenceAlertRecipients';
import { InAppCoordinationAlertChannel } from '../../infrastructure/InAppCoordinationAlertChannel';
import { EmailCoordinationAlertChannel } from '../../infrastructure/EmailCoordinationAlertChannel';

const OCC = '11111111-1111-4111-8111-111111111111';
const SLOT = '22222222-2222-4222-8222-222222222222';
const WORKER = '33333333-3333-4333-8333-333333333333';
const SERVICE = '44444444-4444-4444-8444-444444444444';
const PATIENT = '55555555-5555-4555-8555-555555555555';
const ENDS_AT = '2026-11-25T19:00:00Z'; // 16:00 local (AR)
const CFG = { presenceOpenAfterMin: 240, refusedCheckInAfterMin: 60, lookbackDays: 3 };
const at = (iso: string) => new Date(iso);
const plusMin = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000);

const shift = (over: Partial<ShiftFacts> = {}): ShiftFacts => ({
  occurrenceId: OCC, slotId: SLOT, onDate: '2026-11-25', workerId: WORKER, serviceId: SERVICE, patientId: PATIENT, country: 'AR',
  startsAt: '2026-11-25T11:00:00Z', endsAt: ENDS_AT, startTime: '08:00', endTime: '16:00', isTest: false, ...over,
});

class FakeStore implements CoordinationAlertStore {
  alerts = new Map<string, { id: string; kind: CoordinationAlertKind; occurrenceId: string }>();
  deliveries: Array<{ alertId: string; recipientUid: string; channel: DeliveryChannelCode; status: DeliveryStatus; errorCode?: string }> = [];
  async inTransaction<T>(work: (tx: AlertTransaction) => Promise<T>): Promise<T> {
    const snapshot = { alerts: new Map(this.alerts), deliveries: [...this.deliveries] };
    try {
      return await work({
        handle: { fakeClient: true },
        insertAlertIfAbsent: async (kind, occurrenceId) => {
          const key = `${kind}|${occurrenceId}`; // UNIQUE (kind, occurrence_id)
          if (this.alerts.has(key)) return null;
          const id = `alert-${this.alerts.size + 1}`;
          this.alerts.set(key, { id, kind, occurrenceId });
          return id;
        },
        recordDelivery: async (row) => { this.deliveries.push({ ...row }); },
      });
    } catch (e) {
      this.alerts = snapshot.alerts; this.deliveries = snapshot.deliveries; // rollback
      throw e;
    }
  }
  async claimDelivery(alertId: string, uid: string, channel: DeliveryChannelCode): Promise<boolean> {
    const d = this.deliveries.find((x) => x.alertId === alertId && x.recipientUid === uid && x.channel === channel);
    if (!d || d.status !== 'PENDING') return false;
    d.status = 'SENDING';
    return true;
  }
  async markDelivery(alertId: string, uid: string, channel: DeliveryChannelCode, o: DeliveryOutcome): Promise<void> {
    const d = this.deliveries.find((x) => x.alertId === alertId && x.recipientUid === uid && x.channel === channel)!;
    d.status = o.status; d.errorCode = o.errorCode;
  }
}

function channel(code: DeliveryChannelCode, outcome: (a: AlertToDeliver, r: AlertRecipient) => DeliveryOutcome | Promise<DeliveryOutcome>) {
  const calls: Array<{ alert: AlertToDeliver; recipient: AlertRecipient; tx: unknown }> = [];
  const ch: CoordinationAlertChannel = { channel: code, deliver: async (alert, recipient, tx) => { calls.push({ alert, recipient, tx }); return outcome(alert, recipient); } };
  return { ch, calls };
}

function build(opts: { open?: OpenPresenceRecord[]; refused?: RefusedWithoutEntryRecord[]; shifts?: ShiftFacts[]; recipients?: AlertRecipient[]; email?: (a: AlertToDeliver, r: AlertRecipient) => DeliveryOutcome } = {}) {
  const store = new FakeStore();
  const attendance: AttendancePresenceAlertReader = {
    openPresence: jest.fn(async () => opts.open ?? []),
    refusedWithoutEntry: jest.fn(async () => opts.refused ?? []),
  };
  const directory = { resolve: jest.fn(async () => new Map((opts.shifts ?? [shift()]).map((s) => [s.occurrenceId, s]))) };
  const recipients = { resolve: jest.fn(async () => opts.recipients ?? [{ uid: 'coord-1', email: 'c1@example.test', countries: ['AR'] }]) };
  let seq = 0;
  const inApp = channel('IN_APP', () => ({ status: 'SENT', notificationEventId: `evt-${++seq}` }));
  const email = channel('EMAIL', opts.email ?? (() => ({ status: 'SENT' })));
  const uc = new CoordinationAlertUseCase(attendance, directory, recipients, store, inApp.ch, email.ch, CFG);
  return { uc, store, attendance, directory, recipients, inApp, email };
}
const open = (over: Partial<OpenPresenceRecord> = {}): OpenPresenceRecord => ({ occurrenceId: OCC, workerId: WORKER, slotId: SLOT, onDate: '2026-11-25', ...over });
const refusedAt = (iso: string): RefusedWithoutEntryRecord => ({ occurrenceId: OCC, workerId: WORKER, firstRefusedAt: iso });

describe('CoordinationAlertUseCase', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('PRESENCE_OPEN_4H', () => {
    it('3 h 59 depois do fim previsto → 0 alertas', async () => {
      const t = build({ open: [open()] });
      const r = await t.uc.execute({ now: plusMin(ENDS_AT, 239) });
      expect([r.alerted, t.store.alerts.size, t.inApp.calls.length]).toEqual([0, 0, 0]);
    });

    it('4 h depois do fim previsto → 1 alerta PRESENCE_OPEN_4H, in-app na transação (tx do alerta) e e-mail depois', async () => {
      const t = build({ open: [open()] });
      const r = await t.uc.execute({ now: plusMin(ENDS_AT, 240) });
      expect([r.alerted, r.alertedPresenceOpen, r.inAppDelivered, r.emailsSent, r.failures]).toEqual([1, 1, 1, 1, 0]);
      expect([...t.store.alerts.values()].map((a) => a.kind)).toEqual(['PRESENCE_OPEN_4H']);
      expect(t.inApp.calls[0].tx).toEqual({ fakeClient: true }); // a MESMA transação do alerta
      expect(t.email.calls[0].tx).toBeUndefined(); // e-mail fora da transação
      expect(t.store.deliveries.map((d) => [d.channel, d.status])).toEqual([['IN_APP', 'SENT'], ['EMAIL', 'SENT']]);
    });

    it('2ª execução → continua 1 alerta e nenhuma 2ª entrega (UNIQUE por turno)', async () => {
      const t = build({ open: [open()] });
      const now = plusMin(ENDS_AT, 250);
      await t.uc.execute({ now });
      const again = await t.uc.execute({ now: plusMin(ENDS_AT, 265) });
      expect([again.alerted, again.alreadyAlerted]).toEqual([0, 1]);
      expect(t.store.alerts.size).toBe(1);
      expect(t.inApp.calls).toHaveLength(1);
      expect(t.email.calls).toHaveLength(1);
    });

    it('is_test (worker ou paciente) → 0 alertas, contado', async () => {
      const t = build({ open: [open()], shifts: [shift({ isTest: true })] });
      const r = await t.uc.execute({ now: plusMin(ENDS_AT, 600) });
      expect([r.alerted, r.skippedTest, t.store.alerts.size]).toEqual([0, 1, 0]);
    });

    it('ocorrência fora do itinerário → não alerta (vai para a fila), contada como unresolved', async () => {
      const t = build({ open: [open()], shifts: [] });
      const r = await t.uc.execute({ now: plusMin(ENDS_AT, 600) });
      expect([r.alerted, r.unresolved]).toEqual([0, 1]);
    });
  });

  describe('CHECK_IN_REFUSED_NO_ENTRY (D812)', () => {
    const refusedFirst = '2026-11-25T11:05:00Z';

    it('recusa sem entrada há 60 min → 1 alerta CHECK_IN_REFUSED_NO_ENTRY; com 59 min → 0', async () => {
      const t = build({ refused: [refusedAt(refusedFirst)] });
      expect((await t.uc.execute({ now: plusMin(refusedFirst, 59) })).alerted).toBe(0);
      const r = await t.uc.execute({ now: plusMin(refusedFirst, 60) });
      expect([r.alerted, r.alertedRefusedNoEntry]).toEqual([1, 1]);
      expect([...t.store.alerts.values()].map((a) => a.kind)).toEqual(['CHECK_IN_REFUSED_NO_ENTRY']);
    });

    it('recusa + check-in aceito 10 min depois (a ocorrência aparece OPEN) → 0 alertas de recusa', async () => {
      const t = build({ refused: [refusedAt(refusedFirst)], open: [open()] });
      const r = await t.uc.execute({ now: plusMin(refusedFirst, 70) }); // fim previsto ainda longe: nenhuma regra dispara
      expect([r.alerted, t.store.alerts.size]).toEqual([0, 0]);
    });

    it('recusa de ocorrência fora do itinerário → não alerta', async () => {
      const t = build({ refused: [refusedAt(refusedFirst)], shifts: [] });
      expect((await t.uc.execute({ now: plusMin(refusedFirst, 120) })).alerted).toBe(0);
    });
  });

  describe('entrega', () => {
    it('e-mail falha → a notificação in-app FICA, a entrega vira FAILED com código curto e o alerta existe', async () => {
      const t = build({ open: [open()], email: () => ({ status: 'FAILED', errorCode: 'EMAIL_ERROR' }) });
      const r = await t.uc.execute({ now: plusMin(ENDS_AT, 240) });
      expect([r.alerted, r.inAppDelivered, r.emailsFailed, r.failures]).toEqual([1, 1, 1, 0]);
      expect(t.store.deliveries.map((d) => [d.channel, d.status, d.errorCode])).toEqual([['IN_APP', 'SENT', undefined], ['EMAIL', 'FAILED', 'EMAIL_ERROR']]);
    });

    it('zero destinatários → failures = 1, reportError, e NADA gravado (a próxima execução tenta de novo)', async () => {
      const t = build({ open: [open()], recipients: [] });
      const r = await t.uc.execute({ now: plusMin(ENDS_AT, 240) });
      expect([r.failures, r.alerted, t.store.alerts.size]).toEqual([1, 0, 0]);
      expect(mockReportError).toHaveBeenCalledTimes(1);
    });

    it('destinatário de outro país não recebe (mesmo escopo de país do "Sin cubrir")', async () => {
      const t = build({ open: [open()], recipients: [{ uid: 'br', email: 'b@example.test', countries: ['BR'] }] });
      const r = await t.uc.execute({ now: plusMin(ENDS_AT, 240) });
      expect([r.failures, r.alerted]).toEqual([1, 0]);
    });

    it('falha na transação (in-app) → o alerta é desfeito (rollback), conta failure e a próxima execução refaz', async () => {
      const t = build({ open: [open()] });
      (t.inApp.ch as { deliver: unknown }).deliver = jest.fn().mockRejectedValueOnce(new Error('db')).mockResolvedValue({ status: 'SENT', notificationEventId: 'e' });
      const now = plusMin(ENDS_AT, 240);
      const first = await t.uc.execute({ now });
      expect([first.failures, t.store.alerts.size]).toEqual([1, 0]);
      expect((await t.uc.execute({ now })).alerted).toBe(1);
    });

    it('attendance fora do ar → a exceção SOBE (o controller responde 500 e o Scheduler re-tenta)', async () => {
      const t = build();
      (t.attendance.openPresence as jest.Mock).mockRejectedValueOnce(new Error('presence_unavailable:http_503'));
      await expect(t.uc.execute({ now: new Date() })).rejects.toThrow('presence_unavailable');
    });

    it('a lista de candidatos e as chamadas não carregam nome: o alerta entregue só tem ids, horários e país', async () => {
      const t = build({ open: [open()] });
      await t.uc.execute({ now: plusMin(ENDS_AT, 240) });
      expect(Object.keys(t.inApp.calls[0].alert.shift).sort()).toEqual(
        ['country', 'endTime', 'endsAt', 'isTest', 'occurrenceId', 'onDate', 'patientId', 'serviceId', 'slotId', 'startTime', 'startsAt', 'workerId'],
      );
    });
  });
});

describe('PresenceAlertRecipients (a célula presence_alert:receive)', () => {
  type StaffRow = { uid: string; email: string | null; cells: string[] | null; master: boolean | null };
  const pool = (staff: StaffRow[]) =>
    ({ query: jest.fn(async (sql: string, params: unknown[]) => (/FROM users u/.test(sql) ? { rows: staff } : { rows: [{ countries: ['AR'] }] })) }) as never;

  it('só patient_itinerary:update (a célula do "Sin cubrir") → NÃO recebe; presence_alert:receive e Acesso Master recebem', async () => {
    const r = await new PresenceAlertRecipients(
      pool([
        { uid: 'so-itinerario', email: 'i@example.test', cells: ['patient_itinerary:update'], master: false },
        { uid: 'com-celula', email: 'c@example.test', cells: ['presence_alert:receive'], master: false },
        { uid: 'master', email: 'm@example.test', cells: [], master: true },
        { uid: 'nada', email: 'n@example.test', cells: null, master: null },
      ]),
    ).resolve();
    expect(r.map((x) => x.uid)).toEqual(['com-celula', 'master']);
  });
});

describe('canais (adapters) — nenhum envio real', () => {
  const alert = (kind: CoordinationAlertKind): AlertToDeliver => ({ alertId: 'a1', kind, shift: shift() });
  const recipient: AlertRecipient = { uid: 'u1', email: 'u1@example.test', countries: ['AR'] };

  it('in-app: publica pela transação do alerta, payload só-ids e patient_id na coluna; sem tx lança', async () => {
    const publishCoordinationAlert = jest.fn(async () => 'evt-1');
    const ch = new InAppCoordinationAlertChannel({ publishCoordinationAlert } as never);
    const tx = { client: true };
    expect(await ch.deliver(alert('PRESENCE_OPEN_4H'), recipient, tx)).toEqual({ status: 'SENT', notificationEventId: 'evt-1' });
    expect(publishCoordinationAlert).toHaveBeenCalledWith(tx, {
      typeCode: 'PRESENCE_OPEN_4H', recipientUid: 'u1', patientId: PATIENT,
      payload: { occurrence_id: OCC, slot_id: SLOT, on_date: '2026-11-25', worker_id: WORKER, service_id: SERVICE, start_time: expect.any(String), end_time: expect.any(String) },
    });
    await expect(ch.deliver(alert('PRESENCE_OPEN_4H'), recipient)).rejects.toThrow('transação do alerta');
  });

  it('e-mail: só tipo, data e hora (fim no PRESENCE_OPEN_4H, início na recusa); sem endereço → NO_ADDRESS; canal indisponível → SKIPPED_*; erro → FAILED sem mensagem', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const ch = new EmailCoordinationAlertChannel({ sendCoordinationAlert: send } as never);
    expect(await ch.deliver(alert('PRESENCE_OPEN_4H'), recipient)).toEqual({ status: 'SENT' });
    expect(send).toHaveBeenLastCalledWith('u1@example.test', { kind: 'PRESENCE_OPEN_4H', onDate: '2026-11-25', time: '16:00' });
    await ch.deliver(alert('CHECK_IN_REFUSED_NO_ENTRY'), recipient);
    expect(send).toHaveBeenLastCalledWith('u1@example.test', { kind: 'CHECK_IN_REFUSED_NO_ENTRY', onDate: '2026-11-25', time: '08:00' });
    expect(await ch.deliver(alert('PRESENCE_OPEN_4H'), { ...recipient, email: null })).toEqual({ status: 'NO_ADDRESS' });

    const { EmailChannelUnavailableError } = jest.requireActual('@modules/identity/infrastructure/EmailService');
    send.mockRejectedValueOnce(new EmailChannelUnavailableError('ambiente de teste'));
    expect(await ch.deliver(alert('PRESENCE_OPEN_4H'), recipient)).toEqual({ status: 'SKIPPED_TEST' });
    send.mockRejectedValueOnce(Object.assign(new Error('to: segredo@x.com rejeitado'), { code: 403 }));
    const failed = await ch.deliver(alert('PRESENCE_OPEN_4H'), recipient);
    expect(failed).toEqual({ status: 'FAILED', errorCode: '403' });
    expect(JSON.stringify(failed)).not.toContain('segredo');
  });
});
