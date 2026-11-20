/**
 * WorkerJobByRadius — item de `GET /api/workers/me/jobs?radius_km=100&view=home` (spec 096).
 * O servidor devolve só barrio/cidade/província e a distância: nunca endereço nem lat/lng da vaga.
 */
export interface WorkerJobByRadius {
  id: string;
  case_number: number | null;
  vacancy_number: number;
  title: string;
  service: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  worker_type: string[];
  /** km com 1 casa, calculado no servidor. */
  distance_km: number;
  already_applied: boolean;
}

/** O que a home exige do cadastro para mostrar mapa e vagas (decisão 19/11). */
export type MissingProfileItem = 'address' | 'profession' | 'sex' | 'availability';

export interface WorkerJobsByRadius {
  items: WorkerJobByRadius[];
  /** Zona viva do PRÓPRIO prestador (3 casas). Só é lida: nenhuma tela manda lat/lng ao servidor. Ausente só sem endereço. */
  center?: { lat: number; lng: number };
  /** Quais filtros do perfil de match valeram. */
  applied: { schedule: boolean; profession: boolean; sex: boolean };
  /** O que falta no cadastro; `[]` = completo. Com item faltando, `items` vem vazio. */
  missing: MissingProfileItem[];
}

/** Paradas do controle de raio (D661), em km. */
export const JOB_RADII_KM = [5, 10, 15, 20, 50, 100] as const;
export type JobRadiusKm = (typeof JOB_RADII_KM)[number];
