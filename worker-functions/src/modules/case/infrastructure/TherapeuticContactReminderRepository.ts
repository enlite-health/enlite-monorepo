import type { Pool, PoolClient } from 'pg';
import { countryToTimezone } from '@shared/locale/CountryTimezone';
import { REMINDER_DAY_OFFSETS } from '../domain/TherapeuticContactStatus';

/**
 * Ciclo de lembretes do PT (migration 502) — a OUTBOX que o Scheduler diário varre. A escrita acontece na
 * MESMA transação que cria a versão (ou anula uma); o paciente já está travado (`FOR UPDATE`) por quem chama,
 * então a abertura não corre consigo mesma. O invariante "no máximo um ciclo aberto por paciente" é do banco
 * (índice único parcial `uq_ptcrc_um_aberto_por_paciente`), não só deste código.
 */
export class TherapeuticContactReminderRepository {
  async hasOpenCycle(cli: PoolClient, patientId: string): Promise<boolean> {
    const { rows } = await cli.query(
      'SELECT 1 FROM patient_tp_contact_reminder_cycles WHERE patient_id = $1 AND closed_at IS NULL',
      [patientId],
    );
    return rows.length > 0;
  }

  /**
   * Abre o ciclo e os 3 lembretes (dias 2/5/12). `due_at` = 00:00 local do dia (data local de agora + N) no
   * fuso do país — "dia N" é dia civil, não 24h exatas. Devolve `false` se já havia ciclo aberto (nada gravado).
   */
  async openCycleIfNone(
    cli: PoolClient,
    input: { patientId: string; anchorVersionId: string; openedByUid: string; country: string },
  ): Promise<boolean> {
    if (await this.hasOpenCycle(cli, input.patientId)) return false;
    const tz = countryToTimezone(input.country);
    const { rows } = await cli.query<{ id: string }>(
      `INSERT INTO patient_tp_contact_reminder_cycles (patient_id, anchor_version_id, opened_by_uid)
       VALUES ($1, $2, $3) RETURNING id`,
      [input.patientId, input.anchorVersionId, input.openedByUid],
    );
    for (const offset of REMINDER_DAY_OFFSETS) {
      await cli.query(
        `INSERT INTO patient_tp_contact_reminders (cycle_id, day_offset, due_at)
         VALUES ($1, $2::int, (((now() AT TIME ZONE $3)::date + $2::int)::timestamp AT TIME ZONE $3))`,
        [rows[0].id, offset, tz],
      );
    }
    return true;
  }

  /**
   * Trava (SKIP LOCKED) o PRÓXIMO ciclo aberto com lembrete vencido e ainda não desfechado. `excluded` = ciclos que
   * já falharam NESTA corrida (evita laço infinito: o rollback deixa o ciclo "ainda vencido").
   */
  async claimNextDueCycle(cli: PoolClient, excluded: readonly string[]): Promise<{ id: string; patientId: string } | null> {
    const { rows } = await cli.query<{ id: string; patient_id: string }>(
      `SELECT c.id, c.patient_id
         FROM patient_tp_contact_reminder_cycles c
        WHERE c.closed_at IS NULL
          AND c.id <> ALL($1::uuid[])
          AND EXISTS (SELECT 1 FROM patient_tp_contact_reminders r
                       WHERE r.cycle_id = c.id AND r.sent_at IS NULL AND r.cancelled_at IS NULL AND r.due_at <= now())
        ORDER BY c.anchored_at
        LIMIT 1
        FOR UPDATE OF c SKIP LOCKED`,
      [excluded],
    );
    return rows[0] ? { id: rows[0].id, patientId: rows[0].patient_id } : null;
  }

  /** A MESMA trava do paciente do `TherapeuticProjectRepository.createVersion` (ordem: ciclo -> paciente). */
  async lockPatient(cli: PoolClient, patientId: string): Promise<void> {
    await cli.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
  }

  /** Lembretes vencidos e abertos do ciclo, do menor para o maior dia. */
  async dueReminders(cli: PoolClient, cycleId: string): Promise<Array<{ id: string; dayOffset: number }>> {
    const { rows } = await cli.query<{ id: string; day_offset: number }>(
      `SELECT id, day_offset FROM patient_tp_contact_reminders
        WHERE cycle_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL AND due_at <= now()
        ORDER BY day_offset`,
      [cycleId],
    );
    return rows.map((r) => ({ id: r.id, dayOffset: r.day_offset }));
  }

  async cancelReminders(cli: PoolClient, reminderIds: readonly string[], reason: 'RESOLVED' | 'SUPERSEDED' | 'NO_CURRENT_VERSION'): Promise<number> {
    if (reminderIds.length === 0) return 0;
    const { rowCount } = await cli.query(
      `UPDATE patient_tp_contact_reminders SET cancelled_at = now(), cancel_reason = $2
        WHERE id = ANY($1::uuid[]) AND sent_at IS NULL AND cancelled_at IS NULL`,
      [reminderIds, reason],
    );
    return rowCount ?? 0;
  }

  /** Cancela TODOS os lembretes ainda abertos do ciclo (vencidos ou não). */
  async cancelOpenRemindersOfCycle(cli: PoolClient, cycleId: string, reason: 'RESOLVED' | 'NO_CURRENT_VERSION'): Promise<number> {
    const { rowCount } = await cli.query(
      `UPDATE patient_tp_contact_reminders SET cancelled_at = now(), cancel_reason = $2
        WHERE cycle_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`,
      [cycleId, reason],
    );
    return rowCount ?? 0;
  }

  /** Carimba o envio — na MESMA transação que gravou o evento do sino (idempotência). */
  async markSent(cli: PoolClient, reminderId: string, notificationEventId: string | null): Promise<void> {
    await cli.query(
      `UPDATE patient_tp_contact_reminders
          SET sent_at = now(), notification_event_id = $2,
              skipped_reason = CASE WHEN $2::uuid IS NULL THEN 'NO_ACTIVE_RECIPIENT' END
        WHERE id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`,
      [reminderId, notificationEventId],
    );
  }

  async closeCycle(cli: PoolClient, cycleId: string, reason: 'RESOLVED' | 'COMPLETED' | 'NO_CURRENT_VERSION'): Promise<void> {
    await cli.query(`UPDATE patient_tp_contact_reminder_cycles SET closed_at = now(), close_reason = $2 WHERE id = $1 AND closed_at IS NULL`, [cycleId, reason]);
  }

  /** Ciclos ainda com lembrete vencido (depois do laço) — o que sobrou além do `limit`. */
  async countDueCycles(cli: PoolClient | Pool): Promise<number> {
    const { rows } = await cli.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_tp_contact_reminder_cycles c
        WHERE c.closed_at IS NULL
          AND EXISTS (SELECT 1 FROM patient_tp_contact_reminders r
                       WHERE r.cycle_id = c.id AND r.sent_at IS NULL AND r.cancelled_at IS NULL AND r.due_at <= now())`,
    );
    return rows[0]?.n ?? 0;
  }
}
