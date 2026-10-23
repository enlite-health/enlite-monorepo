import { Pool } from 'pg';
import { localParts } from '@modules/matching/domain/interviewSlotResolver';
import { COUNTRY_TIMEZONE_MAP } from '@shared/locale/CountryTimezone';
import { operationDateInZone } from '@shared/locale/operationDate';

export interface ItineraryDailyRunMissing {
  country: string;
  operationDate: string;
}

export interface ItineraryDailyRunHealth {
  /** Países cuja rotina do dia (data local) não terminou depois do prazo. Vazio = tudo certo. */
  missing: ItineraryDailyRunMissing[];
}

/** Hora local a partir da qual a rotina do dia já devia ter terminado (06:00 AR + folga de 2 h). */
export const ITINERARY_DAILY_RUN_DEADLINE_HOUR = 8;

/**
 * Diagnóstico read-only da rotina diária do itinerário (spec 069 F4, P11) — predicado de ESTADO, molde `TherapeuticContactReminderHealthService`:
 * "país sem `itinerary_daily_run` TERMINADO para o dia de operação (data local) depois das 08:00 locais?". Continua verdadeiro enquanto o
 * job do Scheduler não existir/rodar e só fica falso quando a rotina termina — por isso o WARN é reemitido a cada ciclo do cron
 * `events/health` (que já existe e NÃO depende do job novo). Zero escrita. Uma query, sem PII: só país e data.
 */
export class ItineraryDailyRunHealthService {
  constructor(
    private readonly pool: Pool,
    private readonly timezones: Readonly<Record<string, string>> = COUNTRY_TIMEZONE_MAP,
  ) {}

  async getHealth(now: Date = new Date()): Promise<ItineraryDailyRunHealth> {
    const due = Object.entries(this.timezones)
      .filter(([, tz]) => localParts(now, tz).hour >= ITINERARY_DAILY_RUN_DEADLINE_HOUR)
      .map(([country, tz]) => ({ country, operationDate: operationDateInZone(tz, now) }));
    if (due.length === 0) return { missing: [] };

    const { rows } = await this.pool.query<{ country: string; operation_date: string }>(
      `SELECT country, to_char(operation_date, 'YYYY-MM-DD') AS operation_date
         FROM itinerary_daily_run
        WHERE finished_at IS NOT NULL AND operation_date = ANY($1::date[])`,
      [due.map((d) => d.operationDate)],
    );
    const finished = new Set(rows.map((r) => `${r.country}|${r.operation_date}`));
    return { missing: due.filter((d) => !finished.has(`${d.country}|${d.operationDate}`)) };
  }
}
