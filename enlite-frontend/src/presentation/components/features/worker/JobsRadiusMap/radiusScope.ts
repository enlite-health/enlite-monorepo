import { JOB_RADII_KM, type WorkerJobByRadius, type JobRadiusKm } from '@domain/entities/WorkerJobByRadius';
import { normKey } from '../JobsEmbeddedSection/jobFilters';

/** Módulo PURO (096): o slider filtra no cliente por `distance_km <= r` (DD-3). */
export const DEFAULT_RADIUS_KM: JobRadiusKm = 10;

export const itemsWithin = (items: WorkerJobByRadius[], radiusKm: number): WorkerJobByRadius[] =>
  items.filter((i) => i.distance_km <= radiusKm);

export const nextRadius = (radiusKm: number): JobRadiusKm | null => JOB_RADII_KM.find((r) => r > radiusKm) ?? null;

export interface RegionCount {
  /** Chave canônica (barrio → cidade → `''` para "Sin barrio"). */
  key: string;
  /** Grafia mais frequente no feed; `''` quando é o grupo sem barrio (a tela traduz). */
  label: string;
  count: number;
}

/**
 * Agrupa por barrio (DD-4): chave = `normKey(neighborhood)`; sem barrio cai em `city`; sem os dois vira o grupo ''
 * ("Sin barrio"), que a tela MOSTRA. Sem mínimo por grupo; o grupo "" vai por último. A soma das contagens é sempre o total de `items`.
 */
export function groupByRegion(items: WorkerJobByRadius[]): RegionCount[] {
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const item of items) {
    const raw = (item.neighborhood ?? '').trim() || (item.city ?? '').trim();
    const key = normKey(raw);
    const g = groups.get(key) ?? { count: 0, spellings: new Map<string, number>() };
    g.count += 1;
    if (raw) g.spellings.set(raw, (g.spellings.get(raw) ?? 0) + 1);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label: [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '',
      count: g.count,
    }))
    .sort((a, b) => Number(a.key === '') - Number(b.key === '') || b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Fallback "sem vaga perto" (096): `items` (100 km) vazio e `nearest` preenchido ⇒ as vagas mais próximas, já por distância,
 * sem teto de raio; senão `null` (comportamento de sempre). Fonte única para o card do mapa, a lista e a home.
 */
export const nearestFallback = (data: { items: WorkerJobByRadius[]; nearest?: WorkerJobByRadius[] }): WorkerJobByRadius[] | null =>
  data.items.length === 0 && data.nearest && data.nearest.length > 0 ? data.nearest : null;
