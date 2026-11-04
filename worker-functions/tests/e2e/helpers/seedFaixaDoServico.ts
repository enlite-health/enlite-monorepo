/**
 * Semente de horário de serviço (spec 056): o horário do serviço = faixas VIGENTES em
 * `patient_itinerary_slot` (mig. 527). Gravar `patient_contracted_services.schedule` por SQL não conta mais.
 */
export interface FaixaSemente {
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
}

interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

export async function semearFaixas(
  db: Queryable,
  serviceId: string,
  faixas: readonly FaixaSemente[],
  tag: string,
): Promise<void> {
  for (const f of faixas) {
    await db.query(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
       VALUES ($1, $2, $3, $4, '[2026-01-01,)', $5, $5)`,
      [serviceId, f.dayOfWeek, f.startTime, f.durationMinutes, tag],
    );
  }
}
