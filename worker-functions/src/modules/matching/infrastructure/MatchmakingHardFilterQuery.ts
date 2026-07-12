import { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { normalizeSexValue } from '@shared/utils/normalizeSexValue';
import { DataRealm } from '@shared/domain/DataRealm';
import { JobPosting, WorkerCandidate, haversineKm } from './MatchmakingTypes';
import { MatchmakingSpecification, composeSpecifications } from '../domain/specifications/MatchmakingSpecification';
import { SameRealmSpecification } from '../domain/specifications/SameRealmSpecification';
import { SameZoneSpecification } from '../domain/specifications/SameZoneSpecification';
import { ProfessionSpecification } from '../domain/specifications/ProfessionSpecification';

export async function runHardFilter(
  db: Pool,
  kms: KMSEncryptionService,
  job: JobPosting,
  radiusKm: number | null,
  excludeWithActiveCases: boolean,
  includeIncompleteRegister: boolean,
): Promise<WorkerCandidate[]> {
  const eligibility: MatchmakingSpecification[] = [
    new ProfessionSpecification(job.requiredProfessions),
    new SameZoneSpecification(radiusKm, job.serviceLat, job.serviceLng),
    new SameRealmSpecification(job.realm),
  ];
  const composedEligibility = composeSpecifications(eligibility, 1);

  const excludeActiveCasesIndex = composedEligibility.params.length + 2;
  const statusIndex = excludeActiveCasesIndex + 1;

  const result = await db.query(
    `SELECT
       w.id                                     AS worker_id,
       w.phone,
       w.occupation,
       w.status                                 AS worker_status,
       w.is_test,
       COALESCE(w.diagnostic_preferences, '{}') AS diagnostic_preferences,
       w.sex_encrypted,
       w.first_name_encrypted,
       w.last_name_encrypted,
       wsa.work_zone,
       wsa.address_line                         AS worker_address,
       wsa.interest_zone,
       wsa.latitude                             AS worker_lat,
       wsa.longitude                            AS worker_lng,
       (
         SELECT COALESCE(json_agg(json_build_object(
           'case_number', jp2.case_number,
           'schedule_text', jp2.schedule_days_hours
         )), '[]'::json)
         FROM encuadres ea
         JOIN job_postings jp2 ON jp2.id = ea.job_posting_id
         WHERE ea.worker_id = w.id
           AND ea.resultado = 'SELECCIONADO'
           AND jp2.is_covered = false
       ) AS active_cases,
       EXISTS (
         SELECT 1 FROM worker_job_applications wja
         WHERE wja.worker_id = w.id AND wja.job_posting_id = $1
       ) AS already_applied,
       (
         SELECT COALESCE(json_object_agg(rej.cat, rej.cnt), '{}'::json)
         FROM (
           SELECT rejection_reason_category AS cat, COUNT(*)::integer AS cnt
           FROM encuadres e_rej
           WHERE e_rej.worker_id = w.id
             AND e_rej.rejection_reason_category IS NOT NULL
           GROUP BY rejection_reason_category
         ) rej
       ) AS rejection_history,
       w.avg_quality_rating
     FROM workers w
     LEFT JOIN blacklist bl ON bl.worker_id = w.id
     LEFT JOIN worker_service_areas wsa ON wsa.worker_id = w.id AND wsa.deleted_at IS NULL
     WHERE w.merged_into_id IS NULL
       AND w.status = ANY($${statusIndex}::text[])
       AND w.deleted_at IS NULL
       AND bl.id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM messaging_opt_out moo
         WHERE moo.worker_id = w.id AND moo.opted_in_at IS NULL
       )
       AND ${composedEligibility.sql}
       AND wsa.location IS NOT NULL
       AND NOT (wsa.latitude = 0 AND wsa.longitude = 0)
       AND (
         NOT $${excludeActiveCasesIndex}::BOOLEAN
         OR NOT EXISTS (
           SELECT 1 FROM encuadres ea2
           JOIN job_postings jp3 ON jp3.id = ea2.job_posting_id
           WHERE ea2.worker_id = w.id
             AND ea2.resultado = 'SELECCIONADO'
             AND jp3.is_covered = false
         )
       )
     GROUP BY w.id, wsa.work_zone, wsa.address_line, wsa.interest_zone, wsa.latitude, wsa.longitude`,
    [
      job.id,
      ...composedEligibility.params,
      excludeWithActiveCases,
      includeIncompleteRegister
        ? ['REGISTERED', 'INCOMPLETE_REGISTER']
        : ['REGISTERED'],
    ],
  );

  const candidates: WorkerCandidate[] = result.rows.map(row => ({
    workerId: row.worker_id as string,
    phone: row.phone as string,
    occupation: row.occupation as string | null,
    workerStatus: row.worker_status as string | null,
    diagnosticPreferences: (row.diagnostic_preferences as string[]) ?? [],
    sexEncrypted: row.sex_encrypted as string | null,
    firstNameEncrypted: row.first_name_encrypted as string | null,
    lastNameEncrypted: row.last_name_encrypted as string | null,
    workZone: row.work_zone as string | null,
    workerAddress: row.worker_address as string | null,
    interestZone: row.interest_zone as string | null,
    activeCases: (row.active_cases as WorkerCandidate['activeCases']) ?? [],
    workerLat: row.worker_lat ? parseFloat(row.worker_lat as string) : null,
    workerLng: row.worker_lng ? parseFloat(row.worker_lng as string) : null,
    alreadyApplied: row.already_applied as boolean,
    rejectionHistory: (row.rejection_history as Record<string, number>) ?? {},
    avgQualityRating: row.avg_quality_rating ? parseFloat(row.avg_quality_rating as string) : null,
    realm: DataRealm.fromIsTest(row.is_test as boolean),
  }));

  const requiredSexCode = normalizeSexCode(job.requiredSex);

  const filteredCandidates: WorkerCandidate[] = [];
  for (const candidate of candidates) {
    // Sex match (conservador): vaga BOTH/null aceita qualquer; vaga M/F
    // exige worker com sex cadastrado E batendo. Worker sem sex_encrypted
    // (null) é EXCLUÍDO quando a vaga restringe.
    if (requiredSexCode) {
      if (!candidate.sexEncrypted) continue;
      const workerSex = await kms.decrypt(candidate.sexEncrypted);
      const workerSexCode = normalizeSexCode(workerSex);
      if (workerSexCode !== requiredSexCode) continue;
    }
    // Distance: só exclui se TODOS os 4 (vaga lat+lng, worker lat+lng)
    // estão presentes E a distância passa do raio.
    if (
      radiusKm !== null &&
      job.serviceLat !== null && job.serviceLng !== null &&
      candidate.workerLat !== null && candidate.workerLng !== null
    ) {
      const distance = haversineKm(job.serviceLat, job.serviceLng, candidate.workerLat, candidate.workerLng);
      if (distance > radiusKm) continue;
    }
    filteredCandidates.push(candidate);
  }

  return filteredCandidates;
}

/**
 * Normaliza um valor de sexo para o canônico curto 'M' | 'F' | null usado no
 * matching (required_sex da vaga é single-letter). Delega ao SSOT
 * `normalizeSexValue` (shared/utils).
 */
function normalizeSexCode(value: string | null | undefined): 'M' | 'F' | null {
  const canonical = normalizeSexValue(value);
  if (canonical === 'MALE') return 'M';
  if (canonical === 'FEMALE') return 'F';
  return null;
}
