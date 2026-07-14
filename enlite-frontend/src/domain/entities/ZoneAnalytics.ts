/**
 * Contrato do bloco "Analytics por Zona" do Dashboard para Gestão à Vista
 * (ClickUp 86ajb4qnw). Espelha zoneAnalyticsSchema do worker-functions
 * (GET /analytics/dashboard/zone-analytics).
 */
export interface ZoneAnalyticsZone {
  zone: string;
  patients: number;
  workersMale: number;
  workersFemale: number;
  demand: number;
  availability: number;
}

export interface ZoneAnalyticsData {
  /** Ordenado por demand desc (contrato do backend). */
  zones: ZoneAnalyticsZone[];
  /** patients + workersMale + workersFemale da linha "Não informado". */
  unresolvedCount: number;
}

/**
 * O query-param opcional ?profession= aceita o MESMO enum canônico de
 * workers.profession (@modules/worker/domain/enums/Profession no backend,
 * migration 064) — reusa `WORKER_PROFESSIONS`/`WorkerProfession` de
 * `@domain/entities/Worker`, não redeclarar uma lista paralela aqui.
 */
