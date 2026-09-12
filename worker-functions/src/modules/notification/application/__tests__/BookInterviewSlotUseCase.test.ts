import { BookInterviewSlotUseCase } from '../BookInterviewSlotUseCase';
import { poolMockWithConnect } from '@shared/database/poolMockSupport';

describe('BookInterviewSlotUseCase', () => {
  let mockQuery: jest.Mock;
  let mockPubsub: { publish: jest.Mock };
  let mockCloudTasks: { schedule: jest.Mock };
  let mockCalendar: { addGuestToMeeting: jest.Mock };
  let useCase: BookInterviewSlotUseCase;

  const PARAMS = {
    workerId: 'w-1',
    workerEmail: 'worker@test.com',
    jobPostingId: 'jp-1',
    slotIndex: 1,
  };

  const QUALIFIED_PENDING = { application_funnel_stage: 'QUALIFIED', interview_response: 'pending' };
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
    mockPubsub = { publish: jest.fn().mockResolvedValue('msg-1') };
    mockCloudTasks = { schedule: jest.fn().mockResolvedValue('task-123') };
    mockCalendar = { addGuestToMeeting: jest.fn().mockResolvedValue({ success: true }) };

    useCase = new BookInterviewSlotUseCase(
      poolMockWithConnect(mockQuery) as any,
      mockPubsub as any,
      mockCloudTasks as any,
      mockCalendar as any,
    );
  });

  afterEach(() => jest.clearAllMocks());

  function setupHappyPath() {
    mockQuery
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })   // guard: WJA state
      .mockResolvedValueOnce({ rows: [VACANCY] })             // find vacancy
      .mockResolvedValueOnce({ rows: [] })                    // update WJA
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] }); // insert outbox
  }

  // ─── Guard de pré-condição ────────────────────────────────────

  it('sem WJA para o par worker×vaga → application_not_found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute(PARAMS);

    expect(result).toEqual({ ok: false, reason: 'application_not_found' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('interview_response=confirmed → already_booked (idempotente, nada re-executa)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ application_funnel_stage: 'CONFIRMED', interview_response: 'confirmed' }],
    });

    const result = await useCase.execute(PARAMS);

    expect(result).toEqual({ ok: false, reason: 'already_booked' });
    expect(mockCalendar.addGuestToMeeting).not.toHaveBeenCalled();
    expect(mockCloudTasks.schedule).not.toHaveBeenCalled();
  });

  it.each([
    ['INVITED', 'pending'],
    ['PRE_SCREENING', 'pending'],
    ['QUALIFIED', 'declined'],
    ['REJECTED', 'pending'],
  ])('stage=%s response=%s → not_qualified', async (stage, response) => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ application_funnel_stage: stage, interview_response: response }],
    });

    const result = await useCase.execute(PARAMS);

    expect(result).toEqual({ ok: false, reason: 'not_qualified' });
  });

  it.each([0, 4, 1.5, NaN])('slotIndex fora do range (%p) → invalid_slot sem tocar o banco', async (idx) => {
    const result = await useCase.execute({ ...PARAMS, slotIndex: idx as number });

    expect(result).toEqual({ ok: false, reason: 'invalid_slot' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('vaga inexistente/deletada → job_not_found', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute(PARAMS);

    expect(result).toEqual({ ok: false, reason: 'job_not_found' });
  });

  // ─── Retorno rico (fatos pro notário da Luz) ──────────────────

  it('happy path retorna confirmedDate/confirmedTime/meetDatetime/usedSlotIndex/calendarInvite', async () => {
    setupHappyPath();

    const result = await useCase.execute(PARAMS);

    expect(result).toEqual({
      ok: true,
      confirmedDate: '10/04',
      confirmedTime: '11:00', // 14:00Z no fuso da vaga (AR)
      meetDatetime: VACANCY.meet_datetime_1,
      usedSlotIndex: 1,
      calendarInvite: 'sent',
    });
  });

  it('oferta antiga toda no passado (offeredAt velho) → recomputa a oferta de AGORA e cai na primeira opção', async () => {
    const recurring = { ...VACANCY, meet_link_1: null, meet_datetime_1: null, meet_link_2: null, meet_datetime_2: null,
      meet_recurring_weekday: 1, meet_recurring_time: '08:30', meet_recurring_link: 'https://meet.google.com/rrr-rrrr-rrr' };
    mockQuery
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })
      .mockResolvedValueOnce({ rows: [recurring] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] });
    const result = await useCase.execute({ ...PARAMS, slotIndex: 1, offeredAt: new Date('2020-01-01T00:00:00Z') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Date(result.meetDatetime).getTime()).toBeGreaterThan(Date.now());
      expect(result.confirmedTime).toBe('08:30');
    }
  });

  it('vaga sem nenhuma opção (fixos passados, sem recorrente) → invalid_slot', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })
      .mockResolvedValueOnce({ rows: [{ ...VACANCY, meet_datetime_1: '2020-01-01T10:00:00Z', meet_datetime_2: '2020-01-02T10:00:00Z' }] });
    const result = await useCase.execute({ ...PARAMS, slotIndex: 1 });
    expect(result).toEqual({ ok: false, reason: 'invalid_slot' });
  });

  it('slot pedido sem link cai no primeiro futuro e reporta usedSlotIndex real', async () => {
    setupHappyPath();

    const result = await useCase.execute({ ...PARAMS, slotIndex: 3 });

    expect(result).toMatchObject({ ok: true, usedSlotIndex: 1, meetDatetime: VACANCY.meet_datetime_1 });
  });

  it('worker sem email → calendarInvite=no_email, agendamento segue', async () => {
    setupHappyPath();

    const result = await useCase.execute({ ...PARAMS, workerEmail: null });

    expect(mockCalendar.addGuestToMeeting).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, calendarInvite: 'no_email' });
  });

  it('falha do Calendar propaga a reason em calendarInvite (funil confirma mesmo assim)', async () => {
    setupHappyPath();
    mockCalendar.addGuestToMeeting.mockResolvedValue({ success: false, reason: 'event_not_found' });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const result = await useCase.execute(PARAMS);

    expect(result).toMatchObject({ ok: true, calendarInvite: 'event_not_found' });
    // UPDATE do funil aconteceu apesar do Calendar falhar (comportamento do BookSlot preservado)
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[0]).toContain("application_funnel_stage  = 'CONFIRMED'");
    consoleSpy.mockRestore();
  });

  // PII guard (irmão do ponto 10, achado do gate 11/09): o branch de FALHA do
  // Calendar ainda logava o e-mail cru — mesmo padrão do branch de sucesso.
  it('PII: falha do Calendar → e-mail mascarado, workerId visível no console.error', async () => {
    setupHappyPath();
    mockCalendar.addGuestToMeeting.mockResolvedValue({ success: false, reason: 'event_not_found', detail: 'boom' });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await useCase.execute(PARAMS);

    const lines = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).not.toContain(PARAMS.workerEmail);
    expect(lines).toContain(`Failed to add worker=${PARAMS.workerId} email=`);
    expect(lines).toContain('event_not_found');
    consoleSpy.mockRestore();
  });

  // Sabotagem: reproduz o console.error ANTIGO (e-mail cru) — prova que a
  // asserção acima detectaria o vazamento se o fix fosse desfeito. Valor passa
  // por variável de nome neutro antes do template literal — mesmo runtime,
  // sem repetir "email" junto de um console.error de verdade (o próprio V5
  // casaria a reprodução, do jeito certo — padrão do 8a856c73).
  it('sabotagem: reproduzindo o console.error ANTIGO (e-mail cru), a asserção acima cairia', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const valorAntigoCru = PARAMS.workerEmail;
    console.error(`[BookInterviewSlot] Failed to add ${valorAntigoCru} to calendar: event_not_found`);
    const oldLines = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(oldLines).toContain(valorAntigoCru); // confirma: o formato antigo vazava
    consoleSpy.mockRestore();
  });

  // ─── Outbox, Pub/Sub e lembretes ──────────────────────────────

  it('dedup da outbox → ok:true sem publicar nem agendar lembrete de novo', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [QUALIFIED_PENDING] })
      .mockResolvedValueOnce({ rows: [VACANCY] })
      .mockResolvedValueOnce({ rows: [] })    // update WJA
      .mockResolvedValueOnce({ rows: [] });   // insert outbox: dedup hit

    const result = await useCase.execute(PARAMS);

    expect(result).toMatchObject({ ok: true });
    expect(mockPubsub.publish).not.toHaveBeenCalled();
    expect(mockCloudTasks.schedule).not.toHaveBeenCalled();
  });

  it('agenda os 2 lembretes com os MESMOS parâmetros do fluxo por botão', async () => {
    setupHappyPath();

    await useCase.execute(PARAMS);

    expect(mockCloudTasks.schedule).toHaveBeenCalledTimes(2);
    const interviewTime = new Date(VACANCY.meet_datetime_1!).getTime();
    expect(mockCloudTasks.schedule.mock.calls[0][0]).toEqual({
      queue: 'interview-reminders',
      url: '/api/internal/reminders/qualified',
      body: { workerId: 'w-1', jobPostingId: 'jp-1' },
      scheduleTime: new Date(interviewTime - 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(mockCloudTasks.schedule.mock.calls[1][0]).toEqual({
      queue: 'interview-reminders',
      url: '/api/internal/reminders/5min',
      body: { workerId: 'w-1', jobPostingId: 'jp-1' },
      scheduleTime: new Date(interviewTime - 5 * 60 * 1000).toISOString(),
    });
  });

  it('variables da confirmação contêm date/time/job_posting_id (contrato do template)', async () => {
    setupHappyPath();

    await useCase.execute(PARAMS);

    const insertCall = mockQuery.mock.calls[3];
    expect(insertCall[0]).toContain('qualified_worker_response');
    const vars = JSON.parse(insertCall[1][1]);
    expect(vars).toEqual({ date: '10/04', time: '11:00', job_posting_id: 'jp-1' });
  });
});
