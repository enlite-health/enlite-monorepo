/**
 * MatchmakingHardFilterPath — pipeline sem score (Fase 2+3 desabilitadas).
 *
 * Path tomado quando `MatchOptions.useScoring=false` (default atual). Ordena
 * candidatos por distância ASC, decifra apenas o nome (não o sex) e marca
 * `match_score = NULL` na persistência.
 *
 * Extraído de MatchmakingService para respeitar o limite de 400 linhas.
 */

import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  JobPosting,
  WorkerCandidate,
  ScoredCandidate,
  MatchResult,
  haversineKm,
  registrationWarning,
} from './MatchmakingTypes';

export interface HardFilterPathDeps {
  kms: KMSEncryptionService;
  saveMatchResults: (jobPostingId: string, candidates: ScoredCandidate[]) => Promise<void>;
}

export async function runHardFilterOnlyPath(
  deps: HardFilterPathDeps,
  jobPostingId: string,
  job: JobPosting,
  candidates: WorkerCandidate[],
  radiusKm: number,
  topN: number,
): Promise<MatchResult> {
  const withDistance = candidates.map((w) => {
    const distanceKm =
      job.serviceLat !== null && job.serviceLng !== null &&
      w.workerLat !== null && w.workerLng !== null
        ? haversineKm(job.serviceLat, job.serviceLng, w.workerLat, w.workerLng)
        : null;
    return { worker: w, distanceKm };
  });

  // Sort ASC; null distances go to the end (workers sem coords).
  withDistance.sort((a, b) => {
    if (a.distanceKm === null && b.distanceKm === null) return 0;
    if (a.distanceKm === null) return 1;
    if (b.distanceKm === null) return -1;
    return a.distanceKm - b.distanceKm;
  });

  const top = withDistance.slice(0, topN);

  const finalCandidates: ScoredCandidate[] = await Promise.all(
    top.map(async ({ worker, distanceKm }) => {
      const [firstName, lastName] = await Promise.all([
        deps.kms.decrypt(worker.firstNameEncrypted),
        deps.kms.decrypt(worker.lastNameEncrypted),
      ]);
      const nameParts = firstName === lastName
        ? [firstName].filter(Boolean)
        : [firstName, lastName].filter(Boolean);
      return {
        workerId: worker.workerId,
        workerName: nameParts.join(' ') || 'Sin nombre',
        workerPhone: worker.phone,
        occupation: worker.occupation,
        workZone: worker.workZone ?? worker.workerAddress,
        distanceKm: distanceKm !== null ? Math.round(distanceKm * 10) / 10 : null,
        activeCasesCount: worker.activeCases.length,
        workerStatus: worker.workerStatus,
        registrationWarning: registrationWarning(worker.workerStatus),
        structuredScore: 0,
        llmScore: null,
        finalScore: 0,
        llmReasoning: null,
        llmRedFlags: [],
        llmStrengths: [],
        alreadyApplied: worker.alreadyApplied,
      };
    }),
  );

  await deps.saveMatchResults(jobPostingId, finalCandidates);

  return {
    jobPostingId,
    radiusKm,
    matchSummary: {
      hardFilteredCount: candidates.length,
      llmScoredCount: 0,
    },
    candidates: finalCandidates,
  };
}
