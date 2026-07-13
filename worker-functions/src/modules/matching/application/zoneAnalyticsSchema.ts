import { z } from 'zod';
import { PROFESSIONS } from '@modules/worker/domain/enums/Profession';

/**
 * Contrato de saída do endpoint GET /analytics/dashboard/zone-analytics
 * ("Analytics por Zona" — bloco do Dashboard para Gestão à Vista, ClickUp 86ajb4qnw).
 *
 * Uma linha por PROVÍNCIA canônica resolvida (ver resolveZoneKey em
 * @shared/utils/zoneKey — decisão consciente de agregar por província, não
 * por bairro/localidade, dada a granularidade grossa de worker_service_areas):
 *   - patients / demand: derivados de job_postings via patient_addresses (FK
 *     patient_address_id, migration 149). NUNCA patients.zone_neighborhood
 *     (DEPRECATED, migration 083) nem job_postings.state/city (DEPRECATED,
 *     migration 149).
 *   - workersMale / workersFemale / availability: derivados de
 *     worker_service_areas + workers.sex_bidx (blind index, migration 218).
 *     Sexo NUNCA é decriptado em massa — comparação é por HMAC (Buffer).
 *
 * Zonas não resolvidas (state nulo, ou província resolvida é lixo — CPA
 * postal) caem no bucket explícito
 * "Não informado" — nunca somem silenciosamente. unresolvedCount é a soma de
 * patients + workersMale + workersFemale dessa linha, exposta à parte para
 * quem quiser um sinal de qualidade de dado sem precisar procurar a string
 * mágica dentro do array de zonas.
 */

const nonNegInt = z.number().int().nonnegative();

export const zoneAnalyticsZoneSchema = z.object({
  zone: z.string().min(1),
  patients: nonNegInt,
  workersMale: nonNegInt,
  workersFemale: nonNegInt,
  demand: nonNegInt,
  availability: nonNegInt,
});

export const zoneAnalyticsSchema = z.object({
  /** Ordenado por demand desc. */
  zones: z.array(zoneAnalyticsZoneSchema),
  /** patients + workersMale + workersFemale da linha "Não informado". */
  unresolvedCount: nonNegInt,
});

export type ZoneAnalyticsZone = z.infer<typeof zoneAnalyticsZoneSchema>;
export type ZoneAnalyticsData = z.infer<typeof zoneAnalyticsSchema>;

/**
 * Valores aceitos pelo query-param opcional ?profession=. Reusa o SSOT
 * canônico (@modules/worker/domain/enums/Profession, migration 064): workers.
 * profession, job_postings.required_professions e patients.service_type[]
 * usam o MESMO vocabulário — nunca hardcodar uma lista paralela aqui.
 */
export const zoneAnalyticsQuerySchema = z.object({
  profession: z.enum(PROFESSIONS as [string, ...string[]]).optional(),
});

export type ZoneAnalyticsQuery = z.infer<typeof zoneAnalyticsQuerySchema>;
