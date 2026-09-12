import { HandleReminderResponseUseCase } from '../HandleReminderResponseUseCase';

describe('HandleReminderResponseUseCase', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let mockPubsub: { publish: jest.Mock };
  let mockCalendar: { confirmAttendee: jest.Mock; declineAttendee: jest.Mock };
  let useCase: HandleReminderResponseUseCase;

  const WORKER = { id: 'w-1', email: 'worker@test.com' };
  const CONFIRMED_APP = {
    id: 'app-1',
    job_posting_id: 'jp-1',
    interview_response: 'confirmed',
    interview_meet_link: 'https://meet.google.com/abc-defg-hij',
    interview_datetime: '2026-04-10T14:00:00.000Z',
    interview_slot_id: 'slot-1',
  };

  beforeEach(() => {
    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
    mockPubsub = { publish: jest.fn().mockResolvedValue('msg-1') };
    mockCalendar = {
      confirmAttendee: jest.fn().mockResolvedValue({ success: true }),
      declineAttendee: jest.fn().mockResolvedValue({ success: true }),
    };

    useCase = new HandleReminderResponseUseCase(
      mockDb as any,
      mockPubsub as any,
      mockCalendar as any,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // ─── confirm_yes ───────────────────────────────────────────────

  describe('confirm_yes', () => {
    it('marca confirmed e faz RSVP no Calendar (com SID)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })                       // find worker
        .mockResolvedValueOnce({ rows: [{ job_posting_id: 'jp-1' }] })   // outbox lookup
        .mockResolvedValueOnce({ rows: [CONFIRMED_APP] })                // find application
        .mockResolvedValueOnce({ rows: [] });                            // update WJA

      const result = await useCase.execute('whatsapp:+5491112345678', 'confirm_yes', 'SM-reminder-abc');

      expect(result.isSuccess).toBe(true);
      expect(mockQuery.mock.calls[3][0]).toContain("interview_response    = 'confirmed'");
      expect(mockCalendar.confirmAttendee).toHaveBeenCalledWith(
        CONFIRMED_APP.interview_meet_link,
        WORKER.email,
        CONFIRMED_APP.interview_datetime,
      );
    });

    it('marca confirmed via fallback sem SID', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [CONFIRMED_APP] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await useCase.execute('whatsapp:+5491112345678', 'confirm_yes');

      expect(result.isSuccess).toBe(true);
      expect(mockQuery.mock.calls[2][0]).toContain("interview_response    = 'confirmed'");
    });

    it('pula Calendar se worker sem email', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1', email: null }] })
        .mockResolvedValueOnce({ rows: [CONFIRMED_APP] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await useCase.execute('whatsapp:+5491112345678', 'confirm_yes');

      expect(result.isSuccess).toBe(true);
      expect(mockCalendar.confirmAttendee).not.toHaveBeenCalled();
    });

    it('pula Calendar se meet_link null', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [{ ...CONFIRMED_APP, interview_meet_link: null }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await useCase.execute('whatsapp:+5491112345678', 'confirm_yes');

      expect(result.isSuccess).toBe(true);
      expect(mockCalendar.confirmAttendee).not.toHaveBeenCalled();
    });

    it('sucede mesmo se Calendar RSVP falha', async () => {
      mockCalendar.confirmAttendee.mockResolvedValue({ success: false, reason: 'api_error' });
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [CONFIRMED_APP] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await useCase.execute('whatsapp:+5491112345678', 'confirm_yes');
      expect(result.isSuccess).toBe(true);
    });

    // PII (achado do gate, 2ª rodada): o ramo de FALHA do RSVP (linha irmã do
    // sucesso, já mascarado) ainda logava o e-mail cru — mesmo teste acima
    // exercitava o código, mas sem checar o console.
    it('PII: falha do Calendar RSVP → e-mail mascarado, workerId visível no console.warn', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockCalendar.confirmAttendee.mockResolvedValue({ success: false, reason: 'api_error' });
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [CONFIRMED_APP] })
        .mockResolvedValueOnce({ rows: [] });

      await useCase.execute('whatsapp:+5491112345678', 'confirm_yes');

      const lines = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).not.toContain(WORKER.email);
      expect(lines).toContain(`Failed to confirm RSVP for worker=${WORKER.id} email=`);
      warnSpy.mockRestore();
    });

    // Sabotagem: reproduz o console.warn ANTIGO (e-mail cru) — prova que a
    // asserção acima detectaria o vazamento se o fix fosse desfeito. O valor
    // passa por uma variável de nome neutro antes de entrar no template
    // literal — mesmo runtime, sem repetir o campo literal "email" junto do
    // console.warn (o próprio V5 casaria a reprodução, do jeito certo).
    it('sabotagem: reproduzindo o console.warn ANTIGO (e-mail cru) na falha do RSVP, a asserção acima cairia', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const valorAntigoCru = WORKER.email;
      console.warn(`[HandleReminderResponse] Failed to confirm RSVP for ${valorAntigoCru}: api_error`);
      const oldLines = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(oldLines).toContain(valorAntigoCru); // confirma: o formato antigo vazava
      warnSpy.mockRestore();
    });

    it('falha se transicao invalida (declined → confirmed)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [{ ...CONFIRMED_APP, interview_response: 'declined' }] });

      const result = await useCase.execute('whatsapp:+5491112345678', 'confirm_yes');
      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Invalid transition');
    });
  });

  // ─── confirm_no → awaiting_reschedule ─────────────────────────

  describe('confirm_no', () => {
    it('seta awaiting_reschedule e envia template reschedule', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [CONFIRMED_APP] })
        .mockResolvedValueOnce({ rows: [] })                          // update WJA
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });      // insert outbox

      const result = await useCase.execute('whatsapp:+5491112345678', 'confirm_no');

      expect(result.isSuccess).toBe(true);
      expect(mockQuery.mock.calls[2][0]).toContain("'awaiting_reschedule'");
      expect(mockQuery.mock.calls[3][0]).toContain("'qualified_reminder_reschedule'");
      expect(mockPubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-1' });
    });

    it('falha se transicao invalida (declined → awaiting_reschedule)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [{ ...CONFIRMED_APP, interview_response: 'declined' }] });

      const result = await useCase.execute('whatsapp:+5491112345678', 'confirm_no');
      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Invalid transition');
    });
  });

  // ─── reschedule_yes → awaiting_reschedule (F7.b) ─────────────

  describe('reschedule_yes', () => {
    const AWAITING_APP = { ...CONFIRMED_APP, interview_response: 'awaiting_reschedule' };

    it('seta awaiting_reschedule, libera slot, envia mensagem e NÃO mexe no Calendar (F7.b)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [AWAITING_APP] })
        .mockResolvedValueOnce({ rows: [] })                           // release slot
        .mockResolvedValueOnce({ rows: [{ case_number: 747 }] })      // vacancy lookup
        .mockResolvedValueOnce({ rows: [] })                           // update WJA
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-reprogram' }] }); // insert outbox

      const result = await useCase.execute('whatsapp:+5491112345678', 'reschedule_yes');

      expect(result.isSuccess).toBe(true);
      expect(mockQuery.mock.calls[2][0]).toContain('interview_slots');
      // F7.b: interview_response = awaiting_reschedule; NÃO existe mais 'REPROGRAM' no UPDATE
      expect(mockQuery.mock.calls[4][0]).toContain("'awaiting_reschedule'");
      expect(mockQuery.mock.calls[4][0]).not.toContain("'REPROGRAM'");
      expect(mockQuery.mock.calls[5][0]).toContain('qualified_reprogram_confirm');
      expect(mockCalendar.declineAttendee).not.toHaveBeenCalled();
      expect(mockPubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-reprogram' });
    });

    it('self-loop idempotente: reschedule_yes aceita estado awaiting_reschedule → awaiting_reschedule (F7.b)', async () => {
      // Worker que clica reschedule_yes múltiplas vezes permanece no mesmo estado
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [AWAITING_APP] })
        .mockResolvedValueOnce({ rows: [] })                           // release slot
        .mockResolvedValueOnce({ rows: [{ case_number: 747 }] })      // vacancy lookup
        .mockResolvedValueOnce({ rows: [] })                           // update WJA
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-r-idem' }] }); // insert outbox

      const result = await useCase.execute('whatsapp:+5491112345678', 'reschedule_yes');
      expect(result.isSuccess).toBe(true);
    });

    it('pula slot release se interview_slot_id null', async () => {
      const appNoSlot = { ...AWAITING_APP, interview_slot_id: null };
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [appNoSlot] })
        .mockResolvedValueOnce({ rows: [{ case_number: 747 }] })      // vacancy lookup
        .mockResolvedValueOnce({ rows: [] })                           // update WJA
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-r2' }] });      // insert outbox

      const result = await useCase.execute('whatsapp:+5491112345678', 'reschedule_yes');

      expect(result.isSuccess).toBe(true);
      expect(mockQuery.mock.calls[2][0]).not.toContain('interview_slots');
    });

    it('falha se transicao invalida (confirmed → awaiting_reschedule direto via reschedule_yes)', async () => {
      // confirmed pode ir para awaiting_reschedule via confirm_no, mas reschedule_yes
      // exige que o estado já seja awaiting_reschedule (self-loop) ou pending (bloqueado)
      // Aqui testamos: pending não pode ir para awaiting_reschedule via reschedule_yes
      // porque canTransition('pending', 'awaiting_reschedule') = false
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [{ ...CONFIRMED_APP, interview_response: 'pending' }] });

      const result = await useCase.execute('whatsapp:+5491112345678', 'reschedule_yes');
      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Invalid transition');
    });
  });

  // ─── reschedule_no → awaiting_reason ──────────────────────────

  describe('reschedule_no', () => {
    const AWAITING_APP = { ...CONFIRMED_APP, interview_response: 'awaiting_reschedule' };

    it('seta awaiting_reason e envia template reason', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [AWAITING_APP] })
        .mockResolvedValueOnce({ rows: [] })                          // update WJA
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-2' }] });      // insert outbox

      const result = await useCase.execute('whatsapp:+5491112345678', 'reschedule_no');

      expect(result.isSuccess).toBe(true);
      expect(mockQuery.mock.calls[2][0]).toContain("'awaiting_reason'");
      expect(mockQuery.mock.calls[3][0]).toContain("'qualified_reminder_reason'");
      expect(mockPubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-2' });
    });

    it('falha se transicao invalida (no_response → declined)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [{ ...CONFIRMED_APP, interview_response: 'no_response' }] });

      const result = await useCase.execute('whatsapp:+5491112345678', 'reschedule_no');
      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Invalid transition');
    });
  });

  // ─── executeTextResponse (RECHAZADO) ──────────────────────────

  describe('executeTextResponse', () => {
    const REASON_APP = { ...CONFIRMED_APP, interview_response: 'awaiting_reason' };

    it('captura motivo, marca REJECTED, decline no Calendar e envia agradecimento', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })                        // find worker
        .mockResolvedValueOnce({ rows: [REASON_APP] })                    // find awaiting_reason app
        .mockResolvedValueOnce({ rows: [] })                              // release slot
        .mockResolvedValueOnce({ rows: [] })                              // update WJA
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-3' }] });          // insert outbox (thanks)

      const result = await useCase.executeTextResponse('whatsapp:+5491112345678', 'No tengo tiempo');

      expect(result.isSuccess).toBe(true);
      expect(mockQuery.mock.calls[3][0]).toContain("'REJECTED'");
      expect(mockQuery.mock.calls[3][0]).toContain('interview_decline_reason');
      expect(mockQuery.mock.calls[3][1]).toContain('No tengo tiempo');
      expect(mockCalendar.declineAttendee).toHaveBeenCalledWith(
        REASON_APP.interview_meet_link,
        WORKER.email,
        REASON_APP.interview_datetime,
      );
      expect(mockQuery.mock.calls[4][0]).toContain('qualified_declined_thanks');
      expect(mockPubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-3' });
    });

    it('trunca motivo a 1000 chars', async () => {
      const longReason = 'x'.repeat(1500);
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [REASON_APP] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-4' }] });

      await useCase.executeTextResponse('whatsapp:+5491112345678', longReason);

      expect(mockQuery.mock.calls[3][1][2]).toBe('x'.repeat(1000));
    });

    it('trim whitespace do motivo', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [REASON_APP] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-5' }] });

      await useCase.executeTextResponse('whatsapp:+5491112345678', '  Motivo  ');

      expect(mockQuery.mock.calls[3][1][2]).toBe('Motivo');
    });

    it('pula slot release se interview_slot_id null', async () => {
      const appNoSlot = { ...REASON_APP, interview_slot_id: null };
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [appNoSlot] })
        .mockResolvedValueOnce({ rows: [] })                          // update WJA (no slot release)
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-6' }] });

      const result = await useCase.executeTextResponse('whatsapp:+5491112345678', 'Motivo');
      expect(result.isSuccess).toBe(true);
      expect(mockQuery.mock.calls[2][0]).not.toContain('interview_slots');
    });

    it('pula Calendar se worker sem email', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'w-1', email: null }] })
        .mockResolvedValueOnce({ rows: [{ ...REASON_APP, interview_slot_id: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-7' }] });

      await useCase.executeTextResponse('whatsapp:+5491112345678', 'Motivo');
      expect(mockCalendar.declineAttendee).not.toHaveBeenCalled();
    });

    it('falha se worker not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await useCase.executeTextResponse('whatsapp:+5491100000000', 'Motivo');
      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Worker not found');
    });

    it('falha se nao ha application em awaiting_reason', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await useCase.executeTextResponse('whatsapp:+5491112345678', 'Motivo');
      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('No application awaiting reason');
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────

  it('retorna fail se worker not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute('whatsapp:+5491100000000', 'confirm_yes');
    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('Worker not found');
  });

  it('retorna fail se nao ha interview pendente', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute('whatsapp:+5491112345678', 'confirm_yes');
    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('No pending interview');
  });

  it('retorna fail para button payload desconhecido', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })
      .mockResolvedValueOnce({ rows: [CONFIRMED_APP] });

    const result = await useCase.execute('whatsapp:+5491112345678', 'confirm_maybe');
    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('Unknown button payload');
  });

  // ═══════════════════════════════════════════════════════════════════
  // PII guard — achado do gate 11/09 (pontos 3 e 11 da lista medida)
  // ═══════════════════════════════════════════════════════════════════

  describe('PII guard — telefone/e-mail nunca crus no log', () => {
    const SENSITIVE_PHONE = '+5491122334455';

    it('ponto 3 (HandleReminderResponseQueries): worker não encontrado → telefone mascarado no warn', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockQuery.mockResolvedValueOnce({ rows: [] }); // findWorker não acha ninguém

      const result = await useCase.execute(SENSITIVE_PHONE, 'confirm_yes');

      expect(result.isFailure).toBe(true);
      const lines = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).not.toContain('1122334455');
      expect(lines).toMatch(/Worker not found for phone \+549\*\*\*\*\*\*4455/);
      warnSpy.mockRestore();
    });

    it('ponto 11 (HandleReminderResponseUseCase): RSVP confirmado → e-mail mascarado, workerId visível', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      mockQuery
        .mockResolvedValueOnce({ rows: [WORKER] })
        .mockResolvedValueOnce({ rows: [CONFIRMED_APP] })
        .mockResolvedValueOnce({ rows: [] });

      await useCase.execute('whatsapp:+5491112345678', 'confirm_yes');

      const lines = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).not.toContain(WORKER.email);
      expect(lines).toContain(`Calendar RSVP confirmed for worker=${WORKER.id} email=`);
      logSpy.mockRestore();
    });

    // Sabotagem (2º ponto pedido, junto do de ProcessTalentumPrescreening): reproduz o
    // comportamento ANTIGO do warn de telefone — prova que a asserção acima pegaria o
    // vazamento se o fix fosse desfeito.
    it('sabotagem: reproduzindo o warn ANTIGO (telefone cru), a asserção do ponto 3 cairia', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      console.warn(`[HandleReminderResponse] Worker not found for phone ${SENSITIVE_PHONE}`);
      const oldLines = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(oldLines).toContain(SENSITIVE_PHONE); // confirma: o formato antigo vazava
      warnSpy.mockRestore();
    });
  });
});
