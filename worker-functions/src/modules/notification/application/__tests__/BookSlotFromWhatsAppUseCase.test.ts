import { BookSlotFromWhatsAppUseCase } from '../BookSlotFromWhatsAppUseCase';

describe('BookSlotFromWhatsAppUseCase', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let mockPubsub: { publish: jest.Mock };
  let mockCloudTasks: { schedule: jest.Mock };
  let mockCalendar: { addGuestToMeeting: jest.Mock };
  let useCase: BookSlotFromWhatsAppUseCase;

  const WORKER = { id: 'w-1', email: 'worker@test.com' };
  const APPLICATION = { id: 'app-1', job_posting_id: 'jp-1' };
  const VACANCY = {
    meet_link_1: 'https://meet.google.com/abc-defg-hij',
    meet_datetime_1: '2027-04-10T14:00:00.000Z',
    meet_link_2: 'https://meet.google.com/klm-nopq-rst',
    meet_datetime_2: '2027-04-11T10:00:00.000Z',
    meet_link_3: null,
    meet_datetime_3: null,
  };

  beforeEach(() => {
    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
    mockPubsub = { publish: jest.fn().mockResolvedValue('msg-1') };
    mockCloudTasks = { schedule: jest.fn().mockResolvedValue('task-123') };
    mockCalendar = { addGuestToMeeting: jest.fn().mockResolvedValue({ success: true }) };

    useCase = new BookSlotFromWhatsAppUseCase(
      mockDb as any,
      mockPubsub as any,
      mockCloudTasks as any,
      mockCalendar as any,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // Guard de pré-condição do BookInterviewSlotUseCase (miolo extraído)
  const QUALIFIED_PENDING = { application_funnel_stage: 'QUALIFIED', interview_response: 'pending' };

  /** Happy path com OriginalRepliedMessageSid (correlação exata via outbox) */
  function setupHappyPathWithSid() {
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })                              // find worker
      .mockResolvedValueOnce({ rows: [{ job_posting_id: 'jp-1' }] })          // outbox lookup by twilio_sid
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })                   // guard: WJA state
      .mockResolvedValueOnce({ rows: [VACANCY] })                             // find vacancy
      .mockResolvedValueOnce({ rows: [] })                                    // update WJA
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })                 // insert outbox
    ;
  }

  /** Happy path sem SID (fallback para busca por interview_response) */
  function setupHappyPathFallback() {
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })                              // find worker
      .mockResolvedValueOnce({ rows: [{ job_posting_id: 'jp-1' }] })          // fallback WJA pending
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })                   // guard: WJA state
      .mockResolvedValueOnce({ rows: [VACANCY] })                             // find vacancy
      .mockResolvedValueOnce({ rows: [] })                                    // update WJA
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })                 // insert outbox
    ;
  }

  // ─── Happy path (com OriginalRepliedMessageSid) ─────────────────

  it('identifica worker pelo phone normalizado', async () => {
    setupHappyPathWithSid();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(result.isSuccess).toBe(true);
    expect(mockQuery.mock.calls[0][1]).toEqual(['+5491112345678']);
  });

  it('busca job_posting_id via twilio_sid na outbox', async () => {
    setupHappyPathWithSid();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(result.isSuccess).toBe(true);
    // Segunda query: lookup na outbox por twilio_sid
    expect(mockQuery.mock.calls[1][0]).toContain('twilio_sid');
    expect(mockQuery.mock.calls[1][1]).toEqual(['SM-abc123']);
  });

  it('mapeia slot_1 ao meet_link_1 da vaga', async () => {
    setupHappyPathWithSid();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(result.isSuccess).toBe(true);
    const updateCall = mockQuery.mock.calls[4];
    expect(updateCall[1][0]).toBe(VACANCY.meet_link_1);
    expect(updateCall[1][1]).toBe(VACANCY.meet_datetime_1);
  });

  it('mapeia slot_2 ao meet_link_2 da vaga', async () => {
    setupHappyPathWithSid();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_2', 'SM-abc123');

    expect(result.isSuccess).toBe(true);
    const updateCall = mockQuery.mock.calls[4];
    expect(updateCall[1][0]).toBe(VACANCY.meet_link_2);
  });

  it('adiciona worker ao Google Calendar e loga sucesso', async () => {
    setupHappyPathWithSid();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(mockCalendar.addGuestToMeeting).toHaveBeenCalledWith(
      VACANCY.meet_link_1,
      WORKER.email,
      true,
      VACANCY.meet_datetime_1,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Calendar invite sent to worker@test.com'),
    );
    consoleSpy.mockRestore();
  });

  it('loga erro quando Google Calendar falha', async () => {
    setupHappyPathWithSid();
    mockCalendar.addGuestToMeeting.mockResolvedValue({ success: false, reason: 'event_not_found' });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(result.isSuccess).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to add worker@test.com to calendar: event_not_found'),
    );
    consoleSpy.mockRestore();
  });

  it('enfileira confirmação WhatsApp e publica no Pub/Sub', async () => {
    setupHappyPathWithSid();

    await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    // INSERT outbox
    const insertCall = mockQuery.mock.calls[5];
    expect(insertCall[0]).toContain('qualified_worker_response');
    expect(insertCall[1][0]).toBe('w-1');

    // Pub/Sub
    expect(mockPubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-1' });
  });

  it('agenda 2 Cloud Tasks (24h + 5min antes)', async () => {
    setupHappyPathWithSid();

    await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(mockCloudTasks.schedule).toHaveBeenCalledTimes(2);

    // 24h antes
    const call24h = mockCloudTasks.schedule.mock.calls[0][0];
    expect(call24h.queue).toBe('interview-reminders');
    expect(call24h.url).toBe('/api/internal/reminders/qualified');
    expect(call24h.body).toEqual({ workerId: 'w-1', jobPostingId: 'jp-1' });

    const scheduled24h = new Date(call24h.scheduleTime);
    const interviewTime = new Date(VACANCY.meet_datetime_1!).getTime();
    expect(scheduled24h.getTime()).toBe(interviewTime - 24 * 60 * 60 * 1000);

    // 5min antes
    const call5min = mockCloudTasks.schedule.mock.calls[1][0];
    expect(call5min.url).toBe('/api/internal/reminders/5min');

    const scheduled5min = new Date(call5min.scheduleTime);
    expect(scheduled5min.getTime()).toBe(interviewTime - 5 * 60 * 1000);
  });

  // ─── Fallback (sem OriginalRepliedMessageSid) ──────────────────

  it('usa fallback para WJA pendente se OriginalRepliedMessageSid ausente', async () => {
    setupHappyPathFallback();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1');

    expect(result.isSuccess).toBe(true);
    // Fallback query busca interview_response='pending' AND interview_meet_link IS NULL
    expect(mockQuery.mock.calls[1][0]).toContain('interview_response');
    expect(mockQuery.mock.calls[1][0]).toContain('interview_meet_link IS NULL');
  });

  it('usa fallback se twilio_sid não encontrado na outbox', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })                              // find worker
      .mockResolvedValueOnce({ rows: [] })                                    // outbox lookup: NOT FOUND
      .mockResolvedValueOnce({ rows: [{ job_posting_id: 'jp-1' }] })          // fallback WJA
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })                   // guard: WJA state
      .mockResolvedValueOnce({ rows: [VACANCY] })                             // find vacancy
      .mockResolvedValueOnce({ rows: [] })                                    // update WJA
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });                // insert outbox

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-unknown');

    expect(result.isSuccess).toBe(true);
    // Primeira tentativa: outbox por SID (miss)
    expect(mockQuery.mock.calls[1][1]).toEqual(['SM-unknown']);
    // Fallback: WJA pending
    expect(mockQuery.mock.calls[2][0]).toContain('interview_response');
  });

  // ─── Edge cases ────────────────────────────────────────────────

  it('retorna fail se worker not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute('whatsapp:+5491100000000', 'slot_1');

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('Worker not found');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('retorna fail se não há interview pendente (nem via SID nem via fallback)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })     // find worker
      .mockResolvedValueOnce({ rows: [] });           // fallback WJA: nenhuma pendente

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1');

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('No pending interview');
  });

  it('retorna fail para slot inválido (slot_4)', async () => {
    setupHappyPathFallback();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_4');

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('Invalid slot index');
  });

  it('slot escolhido sem link (slot_3) cai no primeiro slot futuro configurado e AGENDA', async () => {
    // O convite repete o último horário válido nos botões vazios (variável
    // vazia é rejeitada pela Meta) — logo o botão 3 pode chegar mesmo sem
    // meet_link_3. O worker viu um horário real: agenda no primeiro futuro.
    setupHappyPathWithSid();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_3', 'SM-abc123');

    expect(result.isSuccess).toBe(true);
    const updateCall = mockQuery.mock.calls[4];
    expect(updateCall[0]).toContain('interview_meet_link');
    expect(updateCall[1][0]).toBe(VACANCY.meet_link_1);
    expect(updateCall[1][1]).toBe(VACANCY.meet_datetime_1);
  });

  it('retorna fail se NENHUM slot é agendável (todos passados/sem link)', async () => {
    const staleVacancy = {
      meet_link_1: 'https://meet.google.com/abc-defg-hij',
      meet_datetime_1: '2026-04-10T14:00:00.000Z', // passado
      meet_link_2: null,
      meet_datetime_2: null,
      meet_link_3: null,
      meet_datetime_3: null,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })
      .mockResolvedValueOnce({ rows: [{ job_posting_id: 'jp-1' }] })
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })                   // guard: WJA state
      .mockResolvedValueOnce({ rows: [staleVacancy] });

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('Invalid slot');
  });

  it('retorna fail se job_posting not found', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })
      .mockResolvedValueOnce({ rows: [{ job_posting_id: 'jp-1' }] })
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })                   // guard: WJA state
      .mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('Job posting not found');
  });

  // ─── Variáveis do qualified_worker_response ─────────────────

  it('response contém apenas date, time e job_posting_id (sem name nem meet_link)', async () => {
    setupHappyPathWithSid();

    await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    const insertCall = mockQuery.mock.calls[5];
    const vars = JSON.parse(insertCall[1][1]);
    expect(vars.date).toBeDefined();
    expect(vars.time).toBeDefined();
    expect(vars.job_posting_id).toBe('jp-1');
    // Não deve conter name nem meet_link (removidos do template)
    expect(vars.name).toBeUndefined();
    expect(vars.meet_link).toBeUndefined();
  });

  it('response variables formatam date e time corretamente via formatDateUTC/formatTimeUTC', async () => {
    setupHappyPathWithSid();

    await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    const insertCall = mockQuery.mock.calls[5];
    const vars = JSON.parse(insertCall[1][1]);
    // meet_datetime_1 = '2027-04-10T14:00:00.000Z'
    expect(vars.date).toBe('10/04');
    expect(vars.time).toBe('14:00');
  });

  // ─── WJA update fields ────────────────────────────────────────

  it('atualiza WJA com interview_response=confirmed e funnel_stage=CONFIRMED', async () => {
    setupHappyPathWithSid();

    await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    const updateCall = mockQuery.mock.calls[4];
    expect(updateCall[0]).toContain("interview_response        = 'confirmed'");
    expect(updateCall[0]).toContain("application_funnel_stage  = 'CONFIRMED'");
    expect(updateCall[1][0]).toBe(VACANCY.meet_link_1);
    expect(updateCall[1][1]).toBe(VACANCY.meet_datetime_1);
    expect(updateCall[1][2]).toBe('w-1');
    expect(updateCall[1][3]).toBe('jp-1');
  });

  // ─── Mais edge cases de slot ──────────────────────────────────

  it('retorna fail para slot_0 (fora do range 1-3)', async () => {
    setupHappyPathFallback();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_0');

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('Invalid slot index');
  });

  it('retorna fail para payload não-numérico (slot_abc)', async () => {
    setupHappyPathFallback();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_abc');

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('Invalid slot index');
  });

  it('normaliza phone sem prefixo whatsapp:', async () => {
    setupHappyPathFallback();

    await useCase.execute('+5491112345678', 'slot_1');

    expect(mockQuery.mock.calls[0][1]).toEqual(['+5491112345678']);
  });

  it('não chama addGuestToMeeting se worker não tem email e loga warning', async () => {
    const workerNoEmail = { id: 'w-1', email: null };
    mockQuery
      .mockResolvedValueOnce({ rows: [workerNoEmail] })
      .mockResolvedValueOnce({ rows: [{ job_posting_id: 'jp-1' }] })
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })                   // guard: WJA state
      .mockResolvedValueOnce({ rows: [VACANCY] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(result.isSuccess).toBe(true);
    expect(mockCalendar.addGuestToMeeting).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('has no email — skipped calendar invite'),
    );
    consoleSpy.mockRestore();
  });

  // ─── Guard de pré-condição (miolo extraído — BookInterviewSlotUseCase) ──

  it('toque repetido (interview_response=confirmed) → ok idempotente, sem UPDATE nem outbox', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })                              // find worker
      .mockResolvedValueOnce({ rows: [{ job_posting_id: 'jp-1' }] })          // outbox lookup by twilio_sid
      .mockResolvedValueOnce({ rows: [{ application_funnel_stage: 'CONFIRMED', interview_response: 'confirmed' }] });

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(result.isSuccess).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(3);          // parou no guard
    expect(mockCalendar.addGuestToMeeting).not.toHaveBeenCalled();
    expect(mockCloudTasks.schedule).not.toHaveBeenCalled();
  });

  it('candidatura fora de estado (INVITED) → fail No pending interview', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })
      .mockResolvedValueOnce({ rows: [{ job_posting_id: 'jp-1' }] })
      .mockResolvedValueOnce({ rows: [{ application_funnel_stage: 'INVITED', interview_response: 'pending' }] });

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('No pending interview');
    expect(mockCalendar.addGuestToMeeting).not.toHaveBeenCalled();
  });

  it('candidatura inexistente para o par worker×vaga → fail No pending interview', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WORKER] })
      .mockResolvedValueOnce({ rows: [{ job_posting_id: 'jp-1' }] })
      .mockResolvedValueOnce({ rows: [] });               // guard: sem WJA

    const result = await useCase.execute('whatsapp:+5491112345678', 'slot_1', 'SM-abc123');

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('No pending interview');
  });
});
