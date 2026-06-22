import { Pool } from 'pg';

/**
 * LegacyEncuadreReminderService — lógica legada de lembretes baseada em encuadres.
 *
 * Extraído de ReminderScheduler para conformar limite 400 linhas e isolar
 * referências à tabela encuadres em um único arquivo explicitamente marcado como legado.
 *
 * NÃO adicionar lógica nova aqui. Caminho de deprecação: quando encuadres for removida,
 * deletar este arquivo e remover a chamada de fallback em processQualifiedReminder.
 */
export class LegacyEncuadreReminderService {
  constructor(private readonly db: Pool) {}

  /**
   * Lembrete 24h via encuadres (fallback legado).
   * Chamado de ReminderScheduler.processQualifiedReminder quando WJA não é encontrada.
   */
  async processEncuadreReminder(workerId: string): Promise<void> {
    const result = await this.db.query(
      `SELECT e.id as encuadre_id, e.worker_id,
              is2.slot_date, is2.slot_time, is2.meet_link
       FROM encuadres e
       JOIN interview_slots is2 ON is2.id = e.interview_slot_id
       WHERE e.worker_id = $1
         AND e.interview_slot_id IS NOT NULL
         AND e.reminder_day_sent_at IS NULL
         AND is2.status != 'CANCELLED'
       LIMIT 1`,
      [workerId],
    );

    if (result.rows.length === 0) return;

    const row = result.rows[0] as {
      encuadre_id: string;
      worker_id: string;
      slot_date: string;
      slot_time: string | null;
      meet_link: string | null;
    };
    const dateFormatted = new Date(row.slot_date).toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
    });

    await this.db.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
       VALUES ($1, 'encuadre_reminder_day_before', $2::jsonb, 'pending', 0)`,
      [
        row.worker_id,
        JSON.stringify({
          name: row.worker_id,
          date: dateFormatted,
          time: row.slot_time?.slice(0, 5) ?? '',
          meet_link: row.meet_link ?? '',
        }),
      ],
    );

    await this.db.query(
      `UPDATE encuadres SET reminder_day_sent_at = NOW() WHERE id = $1`,
      [row.encuadre_id],
    );
  }

  /**
   * Lembrete 5min via encuadres (Cloud Task legado).
   * Chamado de InternalController.process5MinReminder para workers com fluxo antigo.
   */
  async process5MinReminder(workerId: string, _jobPostingId: string): Promise<void> {
    const result = await this.db.query(
      `SELECT e.id as encuadre_id, e.worker_id,
              is2.slot_date, is2.slot_time, is2.meet_link
       FROM encuadres e
       JOIN interview_slots is2 ON is2.id = e.interview_slot_id
       WHERE e.worker_id = $1
         AND e.interview_slot_id IS NOT NULL
         AND e.reminder_5min_sent_at IS NULL
         AND is2.status != 'CANCELLED'
       LIMIT 1`,
      [workerId],
    );

    if (result.rows.length === 0) return;

    const row = result.rows[0] as {
      encuadre_id: string;
      worker_id: string;
      meet_link: string | null;
    };

    await this.db.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
       VALUES ($1, 'encuadre_reminder_5min', $2::jsonb, 'pending', 0)`,
      [
        row.worker_id,
        JSON.stringify({
          name: row.worker_id,
          meet_link: row.meet_link ?? '',
        }),
      ],
    );

    await this.db.query(
      `UPDATE encuadres SET reminder_5min_sent_at = NOW() WHERE id = $1`,
      [row.encuadre_id],
    );
  }
}
