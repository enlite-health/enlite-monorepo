/**
 * MatchmakingStructuredScorer — Fase 2 do pipeline de match.
 *
 * Função pura (sem I/O, sem state) que calcula o score 0-100 para um par
 * (worker, vaga) baseado em occupation, geo, diagnósticos, rejection history
 * e quality rating. Disabled by default na nova versão (operations não tem
 * histórico maduro pros sinais de rejeição/qualidade).
 *
 * Extraída de `MatchmakingService.ts` para respeitar o limite de 400 linhas
 * do arquivo orquestrador.
 */

import { JobPosting, WorkerCandidate, haversineKm } from './MatchmakingTypes';

export function computeStructuredScore(
  worker: WorkerCandidate,
  job: JobPosting,
): { score: number; distanceKm: number | null } {
  let score = 0;

  // Occupation match (0-40 pts)
  if (job.requiredProfessions && job.requiredProfessions.length > 0) {
    if (worker.occupation && job.requiredProfessions.includes(worker.occupation)) score += 40;
  } else {
    score += 20;
  }

  // Proximidade geográfica (0-35 pts)
  let distanceKm: number | null = null;
  if (job.serviceLat && job.serviceLng && worker.workerLat && worker.workerLng) {
    distanceKm = haversineKm(job.serviceLat, job.serviceLng, worker.workerLat, worker.workerLng);
    if      (distanceKm <  5) score += 35;
    else if (distanceKm < 10) score += 28;
    else if (distanceKm < 20) score += 18;
    else if (distanceKm < 40) score += 8;
    else                      score += 2;
  } else if (job.patientZone && (worker.workZone || worker.interestZone)) {
    const zone = job.patientZone.toLowerCase();
    const wz   = (worker.workZone ?? '').toLowerCase();
    const iz   = (worker.interestZone ?? '').toLowerCase();
    if (wz && (zone.includes(wz) || wz.includes(zone))) score += 35;
    else if (iz && (zone.includes(iz) || iz.includes(zone))) score += 20;
    else score += 5;
  } else {
    score += 15;
  }

  // Diagnósticos / patologias (0-25 pts)
  const jobPathologies = (job.pathologyTypes ?? '')
    .split(/[,;/]/)
    .map(p => p.trim().toLowerCase())
    .filter(Boolean);
  if (jobPathologies.length > 0 && worker.diagnosticPreferences.length > 0) {
    const workerDx = worker.diagnosticPreferences.map(p => p.toLowerCase());
    const matches  = jobPathologies.filter(d => workerDx.some(p => p.includes(d) || d.includes(p)));
    score += Math.round((matches.length / jobPathologies.length) * 25);
  } else if (jobPathologies.length === 0) {
    score += 12;
  }

  // Penalty: rejection history
  const rejHist = worker.rejectionHistory;
  if (rejHist) {
    if ((rejHist['DISTANCE'] ?? 0) >= 2) score -= 10;
    if ((rejHist['SCHEDULE_INCOMPATIBLE'] ?? 0) >= 2) score -= 15;
    if ((rejHist['DEPENDENCY_MISMATCH'] ?? 0) >= 3) score -= 20;
    if ((rejHist['INSUFFICIENT_EXPERIENCE'] ?? 0) >= 3) score -= 15;
  }

  // Bonus/penalty: quality rating
  const qr = worker.avgQualityRating;
  if (qr !== null) {
    if (qr >= 4.5) score += 15;
    else if (qr >= 4.0) score += 10;
    else if (qr < 3.0) score -= 10;
  }

  return { score: Math.min(100, Math.max(0, score)), distanceKm };
}
