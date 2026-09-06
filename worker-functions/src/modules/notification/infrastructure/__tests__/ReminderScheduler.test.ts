/**
 * ReminderScheduler.test.ts
 *
 * Testa o scheduler de lembretes event-driven (Cloud Tasks + Cloud Scheduler).
 *
 * Cenários:
 * 1. scheduleReminders() agenda 2 Cloud Tasks com scheduleTime correto
 * 2. scheduleReminders() calcula 24h e 5min antes corretamente
 * 3. cancelReminders() deleta Cloud Tasks agendados
 * 4. processQualifiedReminder() usa fluxo WJA quando encontra WJA confirmed
 * 5. processQualifiedReminder() cai no fallback encuadre quando WJA não encontrada
 * 6. processQualifiedInterviewReminder() — idempotência (já enviou / declined)
 * 7. process5MinReminder() — envia via WJA e marca 5min_sent_at
 * 8. process5MinReminder() — idempotente (já enviou)
 * 9. process5MinReminder() — fallback legado quando WJA não encontrada
 * 10. processBatch() safety net — processa WJA 24h, 5min e no-shows
 * 11. API: não expõe start()/stop()
 */

import { ReminderScheduler } from '../ReminderScheduler';
import { poolMockWithConnect } from '@shared/database/poolMockSupport';

describe('ReminderScheduler', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let mockCloudTasks: { schedule: jest.Mock; deleteTask: jest.Mock };
  let scheduler: ReminderScheduler;

  beforeEach(() => {
    mockQuery = jest.fn();
    mockDb = poolMockWithConnect(mockQuery) as never;
    mockCloudTasks = {
      schedule: jest.fn().mockResolvedValue('task-name-123'),
      deleteTask: jest.fn().mockResolvedValue(undefined),
    };
    scheduler = new ReminderScheduler(mockDb as any, mockCloudTasks as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── scheduleReminders ───────────────────────────────────────────

  describe('scheduleReminders', () => {
    it('agenda 2 Cloud Tasks (24h e 5min antes)', async () => {
      const slotDatetime = '2026-04-10T14:00:00.000Z';

      const { taskNames } = await scheduler.scheduleReminders(slotDatetime, 'w-1', 'jp-1');

      expect(mockCloudTasks.schedule).toHaveBeenCalledTimes(2);
      expect(taskNames).toEqual(['task-name-123', 'task-name-123']);

      // 24h antes
      const call24h = mockCloudTasks.schedule.mock.calls[0][0];
      expect(call24h.queue).toBe('interview-reminders');
      expect(call24h.url).toBe('/api/internal/reminders/qualified');
      expect(call24h.body).toEqual({ workerId: 'w-1', jobPostingId: 'jp-1' });

      // 5min antes
      const call5min = mockCloudTasks.schedule.mock.calls[1][0];
      expect(call5min.url).toBe('/api/internal/reminders/5min');
      expect(call5min.body).toEqual({ workerId: 'w-1', jobPostingId: 'jp-1' });
    });

    it('calcula scheduleTime corretamente (24h e 5min antes)', async () => {
      const slotDatetime = '2026-04-10T14:00:00.000Z';
      const slotMs = new Date(slotDatetime).getTime();

      await scheduler.scheduleReminders(slotDatetime, 'w-1', 'jp-1');

      const scheduled24h = new Date(mockCloudTasks.schedule.mock.calls[0][0].scheduleTime);
      const scheduled5min = new Date(mockCloudTasks.schedule.mock.calls[1][0].scheduleTime);

      expect(scheduled24h.getTime()).toBe(slotMs - 24 * 60 * 60 * 1000);
      expect(scheduled5min.getTime()).toBe(slotMs - 5 * 60 * 1000);
    });

    it('retorna taskNames vazios se cloudTasks retorna null (mock mode)', async () => {
      mockCloudTasks.schedule.mockResolvedValue(null);

      const { taskNames } = await scheduler.scheduleReminders('2026-04-10T14:00:00.000Z', 'w-1', 'jp-1');

      expect(taskNames).toEqual([]);
    });
  });

  // ─── cancelReminders ─────────────────────────────────────────────

  describe('cancelReminders', () => {
    it('deleta todos os Cloud Tasks informados', async () => {
      await scheduler.cancelReminders(['task-a', 'task-b']);

      expect(mockCloudTasks.deleteTask).toHaveBeenCalledTimes(2);
      expect(mockCloudTasks.deleteTask).toHaveBeenCalledWith('task-a');
      expect(mockCloudTasks.deleteTask).toHaveBeenCalledWith('task-b');
    });

    it('não falha com lista vazia', async () => {
      await scheduler.cancelReminders([]);

      expect(mockCloudTasks.deleteTask).not.toHaveBeenCalled();
    });
  });

  // ─── processQualifiedReminder (dispatch: WJA → encuadre) ────────

  describe('processQualifiedReminder', () => {
    it('usa fluxo WJA quando encontra worker_job_application confirmed', async () => {
      const wjaRow = {
        interview_response: 'confirmed',
        interview_reminder_sent_at: null,
        interview_datetime: '2026-04-10T14:00:00.000Z',
        interview_meet_link: 'https://meet.google.com/abc',
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [wjaRow] })            // SELECT WJA
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })// INSERT outbox
        .mockResolvedValueOnce({ rows: [] });                  // UPDATE WJA

      await scheduler.processQualifiedReminder('w-1', 'jp-1');

      // Deve usar template qualified_reminder_confirm (não encuadre_reminder_day_before)
      const insertCall = mockQuery.mock.calls[1];
      expect(insertCall[0]).toContain('qualified_reminder_confirm');
    });

    it('cai no fallback encuadre quando WJA não encontrada', async () => {
      const encuadreRow = {
        encuadre_id: 'enc-001',
        worker_id: 'w-1',
        slot_date: '2026-04-10',
        slot_time: '14:00:00',
        meet_link: 'https://meet.google.com/abc',
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [] })             // SELECT WJA — vazio
        .mockResolvedValueOnce({ rows: [encuadreRow] })  // SELECT encuadre (legacy)
        .mockResolvedValueOnce({ rows: [] })              // INSERT outbox
        .mockResolvedValueOnce({ rows: [] });             // UPDATE encuadre

      await scheduler.processQualifiedReminder('w-1', 'jp-1');

      const insertCall = mockQuery.mock.calls[2];
      expect(insertCall[0]).toContain('encuadre_reminder_day_before');
    });

    it('retorna silenciosamente se nem WJA nem encuadre encontrados', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })   // SELECT WJA — vazio
        .mockResolvedValueOnce({ rows: [] });  // SELECT encuadre — vazio

      await scheduler.processQualifiedReminder('w-nonexistent', 'jp-1');

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  // ─── processQualifiedInterviewReminder (WJA flow) ──────────────

  describe('processQualifiedInterviewReminder', () => {
    let schedulerWithPubsub: ReminderScheduler;
    let mockPubsub: { publish: jest.Mock };
    let mockTokenService: { generate: jest.Mock };

    beforeEach(() => {
      mockPubsub = { publish: jest.fn().mockResolvedValue('msg-1') };
      mockTokenService = { generate: jest.fn().mockResolvedValue('tk_abc') };
      schedulerWithPubsub = new ReminderScheduler(
        mockDb as any,
        mockCloudTasks as any,
        mockPubsub as any,
        mockTokenService as any,
      );
    });

    it('envia reminder interativo e marca interview_reminder_sent_at', async () => {
      const wjaRow = {
        interview_response: 'confirmed',
        interview_reminder_sent_at: null,
        interview_datetime: '2026-04-10T14:00:00.000Z',
        interview_meet_link: 'https://meet.google.com/abc',
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [wjaRow] })            // SELECT WJA
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })// INSERT outbox
        .mockResolvedValueOnce({ rows: [] });                  // UPDATE WJA

      const handled = await schedulerWithPubsub.processQualifiedInterviewReminder('w-1', 'jp-1');

      expect(handled).toBe(true);

      // Token service chamado
      expect(mockTokenService.generate).toHaveBeenCalledWith('w-1', 'worker_first_name');

      // Outbox com template correto
      const insertCall = mockQuery.mock.calls[1];
      expect(insertCall[0]).toContain('qualified_reminder_confirm');
      const variables = JSON.parse(insertCall[1][1]);
      expect(variables.name).toBe('tk_abc');
      // sem timezone na linha → fuso default (Buenos Aires, UTC-3): 14:00Z é 11:00 — o MESMO
      // rótulo que o convite e a confirmação usam (A2 do gate 30/08)
      expect(variables.date).toBe('10/04');
      expect(variables.time).toBe('11:00');
      // o SELECT traz o fuso da vaga
      expect(mockQuery.mock.calls[0][0]).toContain('jp.timezone');

      // Pub/Sub publicado
      expect(mockPubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-1' });

      // Marcou reminder_sent_at
      const updateCall = mockQuery.mock.calls[2];
      expect(updateCall[0]).toContain('interview_reminder_sent_at');
      expect(updateCall[1]).toEqual(['w-1', 'jp-1']);
    });

    it('retorna true e pula se já enviou (idempotência)', async () => {
      const wjaRow = {
        interview_response: 'confirmed',
        interview_reminder_sent_at: '2026-04-09T10:00:00.000Z',
        interview_datetime: '2026-04-10T14:00:00.000Z',
      };

      mockQuery.mockResolvedValueOnce({ rows: [wjaRow] });

      const handled = await schedulerWithPubsub.processQualifiedInterviewReminder('w-1', 'jp-1');

      expect(handled).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(1); // Só o SELECT
    });

    it('retorna true e pula se worker já declinou (idempotência)', async () => {
      const wjaRow = {
        interview_response: 'declined',
        interview_reminder_sent_at: null,
        interview_datetime: '2026-04-10T14:00:00.000Z',
      };

      mockQuery.mockResolvedValueOnce({ rows: [wjaRow] });

      const handled = await schedulerWithPubsub.processQualifiedInterviewReminder('w-1', 'jp-1');

      expect(handled).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('retorna true e pula se interview_datetime é null', async () => {
      const wjaRow = {
        interview_response: 'confirmed',
        interview_reminder_sent_at: null,
        interview_datetime: null,
      };

      mockQuery.mockResolvedValueOnce({ rows: [wjaRow] });

      const handled = await schedulerWithPubsub.processQualifiedInterviewReminder('w-1', 'jp-1');

      expect(handled).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('retorna false se WJA não encontrada', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const handled = await schedulerWithPubsub.processQualifiedInterviewReminder('w-1', 'jp-1');

      expect(handled).toBe(false);
    });

    it.each([
      ['AR', 'America/Argentina/Buenos_Aires', '2026-04-10T01:30:00.000Z', '09/04', '22:30'],
      ['BR', 'America/Sao_Paulo', '2026-04-10T14:00:00.000Z', '10/04', '11:00'],
    ])('formata data/hora no FUSO da vaga (%s) — vira o dia quando o UTC já é o dia seguinte', async (_c, timezone, iso, date, time) => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ interview_response: 'confirmed', interview_reminder_sent_at: null, interview_datetime: iso, interview_meet_link: null, timezone }] })
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
        .mockResolvedValueOnce({ rows: [] });
      await schedulerWithPubsub.processQualifiedInterviewReminder('w-1', 'jp-1');
      const variables = JSON.parse(mockQuery.mock.calls[1][1][1]);
      expect(variables).toMatchObject({ date, time });
    });

    it('funciona sem pubsub/tokenService (backward compatibility)', async () => {
      const schedulerNoPubsub = new ReminderScheduler(mockDb as any, mockCloudTasks as any);
      const wjaRow = {
        interview_response: 'confirmed',
        interview_reminder_sent_at: null,
        interview_datetime: '2026-04-10T14:00:00.000Z',
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [wjaRow] })
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-2' }] })
        .mockResolvedValueOnce({ rows: [] });

      const handled = await schedulerNoPubsub.processQualifiedInterviewReminder('w-1', 'jp-1');

      expect(handled).toBe(true);
      // name usa workerId como fallback
      const insertCall = mockQuery.mock.calls[1];
      const variables = JSON.parse(insertCall[1][1]);
      expect(variables.name).toBe('w-1');
    });
  });

  // ─── process5MinReminder (WJA flow) ──────────────────────────────

  describe('process5MinReminder', () => {
    it('envia via WJA e marca interview_reminder_5min_sent_at', async () => {
      const wjaRow = {
        interview_response: 'confirmed',
        interview_reminder_5min_sent_at: null,
        interview_datetime: '2026-04-10T14:00:00.000Z',
        interview_meet_link: 'https://meet.google.com/xyz',
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [wjaRow] })            // SELECT WJA
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-5' }] })// INSERT outbox
        .mockResolvedValueOnce({ rows: [] });                  // UPDATE WJA

      await scheduler.process5MinReminder('w-2', 'jp-2');

      expect(mockQuery).toHaveBeenCalledTimes(3);

      const insertCall = mockQuery.mock.calls[1];
      expect(insertCall[0]).toContain('messaging_outbox');
      expect(insertCall[0]).toContain('qualified_reminder_5min');
      expect(insertCall[1][0]).toBe('w-2');

      const updateCall = mockQuery.mock.calls[2];
      expect(updateCall[0]).toContain('interview_reminder_5min_sent_at');
      expect(updateCall[1]).toEqual(['w-2', 'jp-2']);
    });

    it('retorna silenciosamente se já enviou (idempotência 5min)', async () => {
      const wjaRow = {
        interview_response: 'confirmed',
        interview_reminder_5min_sent_at: '2026-04-10T13:55:00.000Z',
        interview_datetime: '2026-04-10T14:00:00.000Z',
        interview_meet_link: null,
      };

      mockQuery.mockResolvedValueOnce({ rows: [wjaRow] });

      await scheduler.process5MinReminder('w-2', 'jp-2');

      expect(mockQuery).toHaveBeenCalledTimes(1); // Só o SELECT
    });

    it('fallback para encuadres quando WJA não encontrada', async () => {
      const encuadreRow = {
        encuadre_id: 'enc-002',
        worker_id: 'w-2',
        slot_date: '2026-04-10',
        slot_time: '14:00:00',
        meet_link: 'https://meet.google.com/xyz',
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [] })            // SELECT WJA — vazio
        .mockResolvedValueOnce({ rows: [encuadreRow] }) // SELECT encuadre (legacy)
        .mockResolvedValueOnce({ rows: [] })             // INSERT outbox
        .mockResolvedValueOnce({ rows: [] });            // UPDATE encuadre

      await scheduler.process5MinReminder('w-2', 'jp-2');

      const insertCall = mockQuery.mock.calls[2];
      expect(insertCall[0]).toContain('encuadre_reminder_5min');
    });

    it('não envia se interview_response não é confirmed', async () => {
      const wjaRow = {
        interview_response: 'pending',
        interview_reminder_5min_sent_at: null,
        interview_datetime: '2026-04-10T14:00:00.000Z',
        interview_meet_link: null,
      };

      mockQuery.mockResolvedValueOnce({ rows: [wjaRow] });

      await scheduler.process5MinReminder('w-2', 'jp-2');

      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  // ─── processBatch (safety net WJA) ───────────────────────────────

  describe('processBatch', () => {
    // O no-show automático é desligado por padrão (NO_SHOW_AUTO_ENABLED, D3 de
    // captura-data-entrevista). Os casos abaixo descrevem o comportamento HABILITADO;
    // o default está coberto em MarkNoShowUseCase.test.ts.
    const envOriginal = process.env.NO_SHOW_AUTO_ENABLED;
    beforeEach(() => {
      process.env.NO_SHOW_AUTO_ENABLED = 'true';
    });
    afterEach(() => {
      if (envOriginal === undefined) delete process.env.NO_SHOW_AUTO_ENABLED;
      else process.env.NO_SHOW_AUTO_ENABLED = envOriginal;
    });

    it('retorna { dayCount:0, minCount:0, noShows:0 } quando não há pendentes', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })  // sendDayBeforeRemindersWJA SELECT
        .mockResolvedValueOnce({ rows: [] })  // send5MinRemindersWJA SELECT
        .mockResolvedValueOnce({ rows: [] }); // MarkNoShowUseCase SELECT

      const result = await scheduler.processBatch();

      expect(result).toEqual({ dayCount: 0, minCount: 0, noShows: 0 });
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it('envia lembrete 24h via WJA e marca interview_reminder_sent_at', async () => {
      const wjaRow = {
        worker_id: 'worker-001',
        job_posting_id: 'jp-001',
        interview_datetime: '2026-04-10T14:00:00.000Z',
        interview_meet_link: 'https://meet.google.com/abc',
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [wjaRow] })            // sendDayBeforeRemindersWJA SELECT
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-d' }] })// INSERT outbox
        .mockResolvedValueOnce({ rows: [] })                   // UPDATE WJA
        .mockResolvedValueOnce({ rows: [] })                   // send5MinRemindersWJA SELECT
        .mockResolvedValueOnce({ rows: [] });                  // MarkNoShowUseCase SELECT

      const result = await scheduler.processBatch();

      expect(result.dayCount).toBe(1);
      expect(result.minCount).toBe(0);
      expect(result.noShows).toBe(0);

      const insertCall = mockQuery.mock.calls[1];
      expect(insertCall[0]).toContain('qualified_reminder_confirm');
      // varredura de segurança: mesmo fuso da vaga (linha sem timezone → default AR)
      expect(mockQuery.mock.calls[0][0]).toContain('jp.timezone');
      expect(JSON.parse(insertCall[1][1])).toMatchObject({ date: '10/04', time: '11:00' });

      const updateCall = mockQuery.mock.calls[2];
      expect(updateCall[0]).toContain('interview_reminder_sent_at');
    });

    it('lembrete 24h da varredura formata no fuso da vaga (São Paulo, linha com timezone)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1', interview_datetime: '2026-04-10T01:30:00.000Z', interview_meet_link: null, timezone: 'America/Sao_Paulo' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-d' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      await scheduler.processBatch();
      expect(JSON.parse(mockQuery.mock.calls[1][1][1])).toMatchObject({ date: '09/04', time: '22:30' });
    });

    it('envia lembrete 5min via WJA e marca interview_reminder_5min_sent_at', async () => {
      const wjaRow = {
        worker_id: 'worker-002',
        job_posting_id: 'jp-002',
        interview_datetime: '2026-04-10T14:00:00.000Z',
        interview_meet_link: null,
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [] })                   // sendDayBeforeRemindersWJA SELECT — empty
        .mockResolvedValueOnce({ rows: [wjaRow] })             // send5MinRemindersWJA SELECT
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-m' }] })// INSERT outbox
        .mockResolvedValueOnce({ rows: [] })                   // UPDATE WJA
        .mockResolvedValueOnce({ rows: [] });                  // MarkNoShowUseCase SELECT

      const result = await scheduler.processBatch();

      expect(result.dayCount).toBe(0);
      expect(result.minCount).toBe(1);

      const insertCall = mockQuery.mock.calls[2];
      expect(insertCall[0]).toContain('qualified_reminder_5min');
      const updateCall = mockQuery.mock.calls[3];
      expect(updateCall[0]).toContain('interview_reminder_5min_sent_at');
    });

    it('marca no-shows (interview_response pending + vencida)', async () => {
      const noShowRow = {
        worker_id: 'worker-ns',
        job_posting_id: 'jp-ns',
        application_funnel_stage: 'CONFIRMED',
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [] })           // sendDayBeforeRemindersWJA
        .mockResolvedValueOnce({ rows: [] })           // send5MinRemindersWJA
        .mockResolvedValueOnce({ rows: [noShowRow] }) // MarkNoShowUseCase SELECT
        .mockResolvedValueOnce({ rows: [] });          // MarkNoShowUseCase UPDATE

      const result = await scheduler.processBatch();

      expect(result.noShows).toBe(1);

      // UPDATE deve incluir IN_DOUBT (stage era CONFIRMED)
      const updateCall = mockQuery.mock.calls[3];
      expect(updateCall[0]).toContain("application_funnel_stage = 'IN_DOUBT'");
      expect(updateCall[0]).toContain("interview_response = 'no_response'");
    });

    it('não move stage quando funnel_stage não é CONFIRMED (idempotência parcial)', async () => {
      const noShowRow = {
        worker_id: 'worker-ns2',
        job_posting_id: 'jp-ns2',
        application_funnel_stage: 'QUALIFIED',
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [noShowRow] })
        .mockResolvedValueOnce({ rows: [] });

      await scheduler.processBatch();

      const updateCall = mockQuery.mock.calls[3];
      // Não deve conter IN_DOUBT quando stage é QUALIFIED
      expect(updateCall[0]).not.toContain("application_funnel_stage = 'IN_DOUBT'");
      expect(updateCall[0]).toContain("interview_response = 'no_response'");
    });
  });

  // ─── API surface ─────────────────────────────────────────────────

  describe('API surface', () => {
    it('não expõe start() nem stop()', () => {
      expect((scheduler as any).start).toBeUndefined();
      expect((scheduler as any).stop).toBeUndefined();
      expect((scheduler as any).timer).toBeUndefined();
    });
  });
});
