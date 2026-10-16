import { Pool } from 'pg';

export interface TherapeuticContactReminderHealth {
  /** Lembretes vencidos há mais de `overdueThresholdHours` e sem `sent_at`/`cancelled_at`. */
  overdue: number;
  /** Idade (horas, arredondada para cima) do vencido mais antigo. 0 quando não há nenhum. */
  oldestOverdueHours: number;
}

/**
 * Diagnóstico read-only do job de lembretes do PT (spec 048) — predicado de ESTADO, no molde do espelho Ana Care:
 * "existe lembrete vencido há mais de 1 dia que ninguém enviou nem cancelou?". Permanece verdadeiro enquanto o job do
 * Scheduler não estiver aplicado/rodando, e só fica falso quando a fila drena — por isso o WARN é reemitido a cada ciclo
 * do cron `events/health` (que já existe e NÃO depende do job novo).
 *
 * Zero escrita. Uma query, sem PII: só contagem e idade. Roda sob `app_system` (sem filtro de país a decidir).
 */
export class TherapeuticContactReminderHealthService {
  constructor(private readonly pool: Pool) {}

  async getHealth(overdueThresholdHours = 24): Promise<TherapeuticContactReminderHealth> {
    const { rows } = await this.pool.query<{ overdue: number; oldest_hours: number | null }>(
      `SELECT count(*)::int AS overdue,
              CEIL(EXTRACT(EPOCH FROM (now() - min(due_at))) / 3600)::int AS oldest_hours
         FROM patient_tp_contact_reminders
        WHERE sent_at IS NULL AND cancelled_at IS NULL
          AND due_at < now() - make_interval(hours => $1::int)`,
      [overdueThresholdHours],
    );
    return { overdue: rows[0]?.overdue ?? 0, oldestOverdueHours: rows[0]?.oldest_hours ?? 0 };
  }
}
