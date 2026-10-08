import type { PoolClient } from 'pg';
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
}
