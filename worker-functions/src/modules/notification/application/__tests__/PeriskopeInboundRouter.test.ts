import { PeriskopeInboundRouter } from '../PeriskopeInboundRouter';
import { Result } from '@shared/utils/Result';

describe('PeriskopeInboundRouter', () => {
  let mockDbQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let mockBookSlot: { execute: jest.Mock };
  let mockHandleReminder: { execute: jest.Mock };
  let router: PeriskopeInboundRouter;

  const WORKER_ROW = { rows: [{ id: 'worker-1' }] };

  beforeEach(() => {
    mockDbQuery = jest.fn();
    mockDb = { query: mockDbQuery };
    mockBookSlot = { execute: jest.fn().mockResolvedValue(Result.ok()) };
    mockHandleReminder = { execute: jest.fn().mockResolvedValue(Result.ok()) };
    router = new PeriskopeInboundRouter(mockDb as any, mockBookSlot as any, mockHandleReminder as any);
  });

  afterEach(() => jest.clearAllMocks());

  it('retorna false se worker não encontrado pelo telefone', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await router.routeNumberedReply('+5491112345678', '1');

    expect(result).toBe(false);
    expect(mockBookSlot.execute).not.toHaveBeenCalled();
    expect(mockHandleReminder.execute).not.toHaveBeenCalled();
  });

  it('retorna false se não há mensagem correlacionável recente na outbox', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({ rows: [] });

    const result = await router.routeNumberedReply('+5491112345678', '1');

    expect(result).toBe(false);
  });

  it('busca outbox filtrando template com botões, status=sent e janela de 7 dias', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({ rows: [] });

    await router.routeNumberedReply('+5491112345678', '1');

    const [sql, params] = mockDbQuery.mock.calls[1];
    expect(sql).toContain('mt.buttons IS NOT NULL');
    expect(sql).toContain("mo.status = 'sent'");
    expect(sql.toLowerCase()).toContain('interval');
    expect(params).toEqual(['worker-1', 7]);
  });

  it('retorna false para texto não-numérico (segue fluxo atual: awaiting_reason/ignorar)', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'qualified_worker_request',
          twilio_sid: 'sid-1',
          buttons: [{ label: '9-10h', payload: 'slot_1' }],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', 'hola');

    expect(result).toBe(false);
    expect(mockBookSlot.execute).not.toHaveBeenCalled();
  });

  it('retorna false para número fora do range (ex: "10" com só 1 opção)', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'qualified_worker_request',
          twilio_sid: 'sid-1',
          buttons: [{ label: '9-10h', payload: 'slot_1' }],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', '10');

    expect(result).toBe(false);
  });

  it('roteia slot_N para BookSlotFromWhatsAppUseCase com o twilio_sid correlacionado', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'qualified_worker_request',
          twilio_sid: 'sid-abc',
          buttons: [
            { label: '9-10h', payload: 'slot_1' },
            { label: '10-11h', payload: 'slot_2' },
          ],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', '2');

    expect(result).toBe(true);
    expect(mockBookSlot.execute).toHaveBeenCalledWith('+5491112345678', 'slot_2', 'sid-abc');
  });

  it('tolera espaços e ponto final no número digitado (" 2. ")', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'qualified_worker_request',
          twilio_sid: 'sid-abc',
          buttons: [{ label: 'a', payload: 'slot_1' }, { label: 'b', payload: 'slot_2' }],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', ' 2. ');

    expect(result).toBe(true);
    expect(mockBookSlot.execute).toHaveBeenCalledWith('+5491112345678', 'slot_2', 'sid-abc');
  });

  it('roteia confirm_yes/confirm_no para HandleReminderResponseUseCase', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'qualified_reminder_confirm',
          twilio_sid: 'sid-2',
          buttons: [
            { label: 'Sí', payload: 'confirm_yes' },
            { label: 'No', payload: 'confirm_no' },
          ],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', '1');

    expect(result).toBe(true);
    expect(mockHandleReminder.execute).toHaveBeenCalledWith('+5491112345678', 'confirm_yes', 'sid-2');
  });

  it('roteia reschedule_yes/reschedule_no para HandleReminderResponseUseCase', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'qualified_reminder_reschedule',
          twilio_sid: 'sid-3',
          buttons: [
            { label: 'Sí', payload: 'reschedule_yes' },
            { label: 'No', payload: 'reschedule_no' },
          ],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', '2');

    expect(result).toBe(true);
    expect(mockHandleReminder.execute).toHaveBeenCalledWith('+5491112345678', 'reschedule_no', 'sid-3');
  });

  it('retorna false se o slug correlacionado não é reconhecido (payload/slug mismatch)', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'some_other_slug',
          twilio_sid: 'sid-4',
          buttons: [{ label: 'x', payload: 'weird_payload' }],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', '1');

    expect(result).toBe(false);
    expect(mockBookSlot.execute).not.toHaveBeenCalled();
    expect(mockHandleReminder.execute).not.toHaveBeenCalled();
  });

  it('retorna true mesmo se o use case falhar (mensagem numerada já foi consumida — não cai no fallback)', async () => {
    mockBookSlot.execute.mockResolvedValue(Result.fail('No pending interview'));
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'qualified_worker_request',
          twilio_sid: 'sid-5',
          buttons: [{ label: 'a', payload: 'slot_1' }],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', '1');

    expect(result).toBe(true);
  });

  it('roteia legacy invite slug (LEGACY_INVITE_SLUG) da mesma forma que o invite atual', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'qualified_worker',
          twilio_sid: 'sid-6',
          buttons: [{ label: 'a', payload: 'slot_1' }],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', '1');

    expect(result).toBe(true);
    expect(mockBookSlot.execute).toHaveBeenCalledWith('+5491112345678', 'slot_1', 'sid-6');
  });
});
