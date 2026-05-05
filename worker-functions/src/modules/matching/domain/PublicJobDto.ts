export interface PublicJobRow {
  id: string;
  case_number: number;
  vacancy_number: number;
  title: string;
  status: string;
  description: string | null;
  schedule_days_hours: string | null;
  worker_profile_sought: string | null;
  service: string | null;
  pathologies: string | null;
  state: string | null;
  city: string | null;
  detail_link: string;
  // ── New fields (public endpoint expansion) ──────────────────────────────
  worker_type: string[] | null;      // jp.required_professions (PG array)
  worker_sex: string | null;         // jp.required_sex
  job_zone: string | null;           // jp.inferred_zone
  neighborhood: string | null;       // COALESCE(pa.neighborhood, p.zone_neighborhood) — fallback p/ legado ClickUp
  state_city: string | null;         // CONCAT_WS(state, city) — empty string → null in mapper
}

export interface PublicJobDto {
  id: string;
  case_number: number;
  vacancy_number: number;
  title: string;
  status: string;
  description: string;   // sanitized — empty if generic
  schedule_days_hours: string | null;
  worker_profile_sought: string | null;
  service: string | null;
  pathologies: string | null;
  state: string | null;
  city: string | null;
  detail_link: string;
  // ── New fields (public endpoint expansion) ──────────────────────────────
  worker_type: string[] | null;
  worker_sex: string | null;
  job_zone: string | null;
  neighborhood: string | null;
  state_city: string | null;
}
