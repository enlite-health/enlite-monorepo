import type { SavedCandidate } from '../../../../../types/match';

export const BUCKET_THRESHOLDS = [5, 10, 20, 50] as const;
export const MATCH_RADIUS_KM = 50;

export interface VacancyForMatch {
  required_sex?: string | null;
  required_professions?: string[] | null;
  patient_zone?: string | null;
  /** FK do patient_addresses específico desta vaga — uma vaga aponta pra UM endereço do paciente */
  patient_address_id?: string | null;
  /** Endereço formatado do patient_addresses linkado em patient_address_id */
  patient_address_formatted?: string | null;
  /** Endereço cru do patient_addresses linkado em patient_address_id */
  patient_address_raw?: string | null;
  meet_link_1?: string | null;
  meet_link_2?: string | null;
  meet_link_3?: string | null;
}

export interface DistanceBucket {
  label: string;
  candidates: SavedCandidate[];
}

export function bucketize(candidates: SavedCandidate[]): DistanceBucket[] {
  const sorted = [...candidates].sort(
    (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
  );

  const distanceBuckets: DistanceBucket[] = BUCKET_THRESHOLDS.map((maxKm, idx) => ({
    label:
      idx === 0
        ? `≤ ${maxKm} km`
        : `> ${BUCKET_THRESHOLDS[idx - 1]} km · ≤ ${maxKm} km`,
    candidates: [],
  }));

  // 5º bucket para candidatos sem distância (worker sem geocoding ou vaga
  // sem patient_address.lat/lng). São válidos pro funnel mesmo sem dist —
  // não devem sumir do modal só porque o ST_Distance retornou null.
  const noLocationBucket: DistanceBucket = {
    label: 'Sin ubicación',
    candidates: [],
  };

  for (const c of sorted) {
    const km = c.distanceKm;
    if (km == null) {
      noLocationBucket.candidates.push(c);
      continue;
    }
    for (let i = 0; i < BUCKET_THRESHOLDS.length; i++) {
      const min = i === 0 ? -Infinity : BUCKET_THRESHOLDS[i - 1];
      const max = BUCKET_THRESHOLDS[i];
      if (km > min && km <= max) {
        distanceBuckets[i].candidates.push(c);
        break;
      }
    }
  }

  return [...distanceBuckets, noLocationBucket];
}

export function hasAnyMeetLink(vacancy: VacancyForMatch | undefined): boolean {
  return Boolean(
    vacancy?.meet_link_1?.trim() ||
      vacancy?.meet_link_2?.trim() ||
      vacancy?.meet_link_3?.trim(),
  );
}

/** Endereço de display da vaga.
 *
 *  Resolve sempre o endereço *específico* da vaga (via patient_address_id →
 *  patient_addresses), não um endereço qualquer do paciente. Se a vaga não
 *  tiver patient_address_id (ainda não associado), faz fallback pro
 *  patient_zone (texto livre do paciente).
 */
export function buildAddressLabel(vacancy: VacancyForMatch | undefined): string {
  return (
    vacancy?.patient_address_formatted?.trim() ||
    vacancy?.patient_address_raw?.trim() ||
    vacancy?.patient_zone?.trim() ||
    '—'
  );
}
