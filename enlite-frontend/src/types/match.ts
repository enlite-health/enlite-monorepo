// Tipos do módulo de Match de Vacantes
// Espelha os shapes retornados pelo backend (VacanciesController + MatchmakingService)

export interface SavedCandidate {
  workerId: string;
  workerName: string;
  workerPhone: string;
  occupation: string | null;
  workZone: string | null;
  distanceKm: number | null;
  activeCasesCount: number;
  overallStatus: string | null;
  matchScore: number | null;
  internalNotes: string | null;    // llmReasoning salvo em worker_job_applications.internal_notes
  alreadyApplied: boolean;         // true = candidatou-se diretamente (não via match)
  messagedAt: string | null;       // ISO 8601 ou null se nunca notificado
}

export interface MatchResultsResponse {
  jobPostingId: string;
  lastMatchAt: string | null;
  totalCandidates: number;
  candidates: SavedCandidate[];
}
