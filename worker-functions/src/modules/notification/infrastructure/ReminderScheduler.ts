import { Pool } from 'pg';
import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import { PubSubClient } from '@shared/events/PubSubClient';
import { TokenService } from './TokenService';
import { LegacyEncuadreReminderService } from './LegacyEncuadreReminderService';
import { MarkNoShowUseCase } from '../application/MarkNoShowUseCase';
import { formatDateInTimezone, formatTimeInTimezone } from '@shared/utils/dateFormatters';
import { logger } from '@shared/logging';

const REMINDER_QUEUE = 'interview-reminders';

/**
 * ReminderScheduler — agenda e processa lembretes de entrevista.
 *
 * Duas fontes de dados:
 *   - WJA (worker_job_applications, interview_datetime): todos os métodos públicos novos.
 *   - encuadres: delegado a LegacyEncuadreReminderService (somente fallback/legado).
 *
 * Métodos:
 *   - scheduleReminders(): agenda Cloud Tasks (24h + 5min antes)
 *   - processQualifiedReminder(): despacha 24h reminder (WJA → encuadre fallback)
 *   - processQualifiedInterviewReminder(): fluxo WJA 24h (Cloud Task)
 *   - process5MinReminder(): fluxo WJA 5min (Cloud Task)
 *   - processBatch(): safety net sweep (Cloud Scheduler)
 */
export class ReminderScheduler {
  private readonly legacy: LegacyEncuadreReminderService;
  private readonly noShowUseCase: MarkNoShowUseCase;

  constructor(
    private readonly db: Pool,
    private readonly cloudTasks: CloudTasksClient,
    private readonly pubsub?: PubSubClient,
    private readonly tokenService?: TokenService,
  ) {
    this.legacy = new LegacyEncuadreReminderService(db);
    this.noShowUseCase = new MarkNoShowUseCase(db);
  }

  /**
   * Agenda Cloud Tasks para 24h e 5min antes da entrevista.
   * Chamado no momento do booking (InterviewSchedulingService.bookSlot).
   * Retorna os nomes das tasks para eventual cancelamento.
   */
  async scheduleReminders(
    slotDatetime: string,
    workerId: string,
    jobPostingId: string,
  ): Promise<{ taskNames: string[] }> {
    const dt = new Date(slotDatetime);
    const taskNames: string[] = [];

    // 24h antes
    const reminder24h = new Date(dt.getTime() - 24 * 60 * 60 * 1000);
    const task24h = await this.cloudTasks.schedule({
      queue: REMINDER_QUEUE,
      url: '/api/internal/reminders/qualified',
      body: { workerId, jobPostingId },
      scheduleTime: reminder24h.toISOString(),
    });
    if (task24h) taskNames.push(task24h);

    // 5min antes
    const reminder5min = new Date(dt.getTime() - 5 * 60 * 1000);
    const task5min = await this.cloudTasks.schedule({
      queue: REMINDER_QUEUE,
      url: '/api/internal/reminders/5min',
      body: { workerId, jobPostingId },
      scheduleTime: reminder5min.toISOString(),
    });
    if (task5min) taskNames.push(task5min);

    return { taskNames };
  }

  /**
   * Cancela Cloud Tasks agendados (ex: slot cancelado pelo worker).
   */
  async cancelReminders(taskNames: string[]): Promise<void> {
    for (const name of taskNames) {
      await this.cloudTasks.deleteTask(name);
    }
  }

  /**
   * Processa um lembrete de 24h antes para um worker específico.
   * Chamado via Cloud Task → POST /api/internal/reminders/qualified
   *
   * Tenta primeiro o fluxo WJA (worker_job_applications).
   * Se não encontrar, cai no fluxo legado (encuadres) via LegacyEncuadreReminderService.
   */
  async processQualifiedReminder(workerId: string, jobPostingId: string): Promise<void> {
    const handled = await this.processQualifiedInterviewReminder(workerId, jobPostingId);
    if (handled) return;

    // Fallback: fluxo encuadres (legado)
    await this.legacy.processEncuadreReminder(workerId);
  }

  /**
   * Fluxo WJA (Step 8): envia reminder interativo (Sí/No) via worker_job_applications.
   *
   * Idempotência: pula se interview_reminder_sent_at já está preenchido
   *               ou se interview_response já não é 'pending'.
   *
   * Retorna true se processou ou pulou (WJA encontrada), false se não encontrou WJA.
   */
  async processQualifiedInterviewReminder(
    workerId: string,
    jobPostingId: string,
  ): Promise<boolean> {
    const appResult = await this.db.query(
      `SELECT wja.interview_response, wja.interview_reminder_sent_at,
              wja.interview_datetime, wja.interview_meet_link, jp.timezone
       FROM worker_job_applications wja
       LEFT JOIN job_postings jp ON jp.id = wja.job_posting_id
       WHERE wja.worker_id = $1 AND wja.job_posting_id = $2
       LIMIT 1`,
      [workerId, jobPostingId],
    );

    if (appResult.rows.length === 0) return false;

    const app = appResult.rows[0] as {
      interview_response: string;
      interview_reminder_sent_at: string | null;
      interview_datetime: string | null;
      interview_meet_link: string | null;
      timezone: string | null;
    };

    // Idempotência: já enviou reminder ou worker já declinou/cancelou/não respondeu
    if (app.interview_reminder_sent_at || app.interview_response !== 'confirmed') {
      return true;
    }

    if (!app.interview_datetime) return true;

    // Tokenizar nome e inserir na outbox
    let nameValue = workerId;
    if (this.tokenService) {
      nameValue = await this.tokenService.generate(workerId, 'worker_first_name');
    }

    // No FUSO da vaga (mig 180): o convite e a confirmação já saem assim — o
    // lembrete em UTC dizia "10:00" para o mesmo horário que o convite chamou de "07:00".
    const date = formatDateInTimezone(app.interview_datetime, app.timezone);
    const time = formatTimeInTimezone(app.interview_datetime, app.timezone);

    const outboxResult = await this.db.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
       VALUES ($1, 'qualified_reminder_confirm', $2::jsonb, 'pending', 0)
       RETURNING id`,
      [
        workerId,
        JSON.stringify({ name: nameValue, date, time, job_posting_id: jobPostingId }),
      ],
    );

    // Publicar no Pub/Sub para processamento imediato
    if (this.pubsub) {
      const outboxId = outboxResult.rows[0].id;
      await this.pubsub.publish('outbox-enqueued', { outboxId });
    }

    // Marcar como enviado
    await this.db.query(
      `UPDATE worker_job_applications
       SET interview_reminder_sent_at = NOW(), updated_at = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, jobPostingId],
    );

    return true;
  }

  /**
   * Lembrete 5min via WJA (Cloud Task).
   * Idempotente: pula se interview_reminder_5min_sent_at já preenchido.
   * Fallback para encuadres se WJA não encontrada (compatibilidade legada).
   */
  async process5MinReminder(workerId: string, jobPostingId: string): Promise<void> {
    const appResult = await this.db.query(
      `SELECT interview_response, interview_reminder_5min_sent_at,
              interview_datetime, interview_meet_link
       FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2
       LIMIT 1`,
      [workerId, jobPostingId],
    );

    if (appResult.rows.length === 0) {
      // Fallback legado: tenta encuadres
      await this.legacy.process5MinReminder(workerId, jobPostingId);
      return;
    }

    const app = appResult.rows[0] as {
      interview_response: string;
      interview_reminder_5min_sent_at: string | null;
      interview_datetime: string | null;
      interview_meet_link: string | null;
    };

    // Idempotência: já enviou ou entrevista não está ativa
    if (app.interview_reminder_5min_sent_at || app.interview_response !== 'confirmed') {
      return;
    }

    if (!app.interview_datetime) return;

    let nameValue = workerId;
    if (this.tokenService) {
      nameValue = await this.tokenService.generate(workerId, 'worker_first_name');
    }

    const outboxResult = await this.db.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
       VALUES ($1, 'qualified_reminder_5min', $2::jsonb, 'pending', 0)
       RETURNING id`,
      [
        workerId,
        JSON.stringify({
          name: nameValue,
          meet_link: app.interview_meet_link ?? '',
        }),
      ],
    );

    if (this.pubsub) {
      const outboxId = outboxResult.rows[0].id;
      await this.pubsub.publish('outbox-enqueued', { outboxId });
    }

    await this.db.query(
      `UPDATE worker_job_applications
       SET interview_reminder_5min_sent_at = NOW(), updated_at = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, jobPostingId],
    );
  }

  /**
   * Safety net sweep: processa lembretes pendentes + marca no-shows.
   * Chamado via Cloud Scheduler (a cada 5min) → POST /api/internal/reminders/sweep.
   */
  async processBatch(): Promise<{ dayCount: number; minCount: number; noShows: number }> {
    const dayCount = await this.sendDayBeforeRemindersWJA();
    const minCount = await this.send5MinRemindersWJA();
    const noShowResult = await this.noShowUseCase.execute();

    if (dayCount + minCount + noShowResult.marked > 0) {
      logger.info(
        { dayCount, minCount, noShows: noShowResult.marked, stageMovedToInDoubt: noShowResult.stageMovedToInDoubt },
        'ReminderScheduler.processBatch concluído',
      );
    }

    return { dayCount, minCount, noShows: noShowResult.marked };
  }

  private async sendDayBeforeRemindersWJA(): Promise<number> {
    const result = await this.db.query(
      `SELECT wja.worker_id, wja.job_posting_id, wja.interview_datetime, wja.interview_meet_link, jp.timezone
       FROM worker_job_applications wja
       LEFT JOIN job_postings jp ON jp.id = wja.job_posting_id
       WHERE wja.interview_response = 'confirmed'
         AND wja.interview_reminder_sent_at IS NULL
         AND wja.interview_datetime IS NOT NULL
         AND wja.interview_datetime - INTERVAL '24 hours' <= NOW()
         AND wja.interview_datetime > NOW()`,
    );

    for (const row of result.rows as Array<{
      worker_id: string;
      job_posting_id: string;
      interview_datetime: string;
      interview_meet_link: string | null;
      timezone: string | null;
    }>) {
      let nameValue = row.worker_id;
      if (this.tokenService) {
        nameValue = await this.tokenService.generate(row.worker_id, 'worker_first_name');
      }

      const outboxResult = await this.db.query(
        `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
         VALUES ($1, 'qualified_reminder_confirm', $2::jsonb, 'pending', 0)
         RETURNING id`,
        [
          row.worker_id,
          JSON.stringify({
            name: nameValue,
            date: formatDateInTimezone(row.interview_datetime, row.timezone),
            time: formatTimeInTimezone(row.interview_datetime, row.timezone),
            job_posting_id: row.job_posting_id,
          }),
        ],
      );

      if (this.pubsub) {
        await this.pubsub.publish('outbox-enqueued', { outboxId: outboxResult.rows[0].id });
      }

      await this.db.query(
        `UPDATE worker_job_applications
         SET interview_reminder_sent_at = NOW(), updated_at = NOW()
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [row.worker_id, row.job_posting_id],
      );
    }

    return result.rows.length;
  }

  private async send5MinRemindersWJA(): Promise<number> {
    const result = await this.db.query(
      `SELECT worker_id, job_posting_id, interview_datetime, interview_meet_link
       FROM worker_job_applications
       WHERE interview_response = 'confirmed'
         AND interview_reminder_5min_sent_at IS NULL
         AND interview_datetime IS NOT NULL
         AND interview_datetime - INTERVAL '5 minutes' <= NOW()
         AND interview_datetime > NOW()`,
    );

    for (const row of result.rows as Array<{
      worker_id: string;
      job_posting_id: string;
      interview_datetime: string;
      interview_meet_link: string | null;
    }>) {
      let nameValue = row.worker_id;
      if (this.tokenService) {
        nameValue = await this.tokenService.generate(row.worker_id, 'worker_first_name');
      }

      const outboxResult = await this.db.query(
        `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
         VALUES ($1, 'qualified_reminder_5min', $2::jsonb, 'pending', 0)
         RETURNING id`,
        [
          row.worker_id,
          JSON.stringify({
            name: nameValue,
            meet_link: row.interview_meet_link ?? '',
          }),
        ],
      );

      if (this.pubsub) {
        await this.pubsub.publish('outbox-enqueued', { outboxId: outboxResult.rows[0].id });
      }

      await this.db.query(
        `UPDATE worker_job_applications
         SET interview_reminder_5min_sent_at = NOW(), updated_at = NOW()
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [row.worker_id, row.job_posting_id],
      );
    }

    return result.rows.length;
  }
}
