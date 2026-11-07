// Tipos do módulo de Match de Vacantes
// Espelha o contrato de GET /api/admin/vacancies/:id/match-results (spec 089 §9.2)

export interface SavedCandidate {
  workerId: string;
  workerName: string;
  workerPhone: string | null;
  occupation: string | null;
  workZone: string | null;
  distanceKm: number | null;       // PostGIS, área viva mais próxima do serviço (DF-8)
  lat: number | null;              // da MESMA área (worker_service_areas.latitude)
  lng: number | null;              // da MESMA área (worker_service_areas.longitude)
  activeCasesCount: number;
  workerStatus: string | null;     // nome real do campo no backend (F7; antes o front chamava de overallStatus)
  documentStatus: string | null;   // worker_documents.documents_status ('pending'|'incomplete'|'submitted'|'under_review'|'approved'|'rejected') ou null
  source: 'system' | 'manual' | (string & {});
  funnelStage: string | null;      // application_funnel_stage
  replied: boolean;                // interview_response ∈ {confirmed, declined, no_response, awaiting_reschedule, awaiting_reason}
  matchScore: number | null;
  internalNotes: string | null;    // llmReasoning salvo em worker_job_applications.internal_notes
  alreadyApplied: boolean;         // true = candidatou-se diretamente (não via match)
  messagedAt: string | null;       // ISO 8601; != null = já recebeu o WhatsApp nesta vacante (DF-4)
}

/** Endereço do serviço da vacante; `lat`/`lng` null = sem endereço ou sem coordenada (nunca 0). */
export interface MatchService {
  lat: number | null;
  lng: number | null;
  addressLabel: string | null;
}

export interface MatchResultsResponse {
  jobPostingId: string;
  lastMatchAt: string | null;
  totalCandidates: number;         // pessoas distintas (não linhas)
  service: MatchService;
  invitedCount: number;            // messaged_at IS NOT NULL na vacante
  pendingInVacancyCount: number;   // INVITED, messaged_at NULL, source='manual', sem resposta (⚑4: contador do F0)
  operationDate: string;           // 'YYYY-MM-DD' do dia de operação do país da vacante
  candidates: SavedCandidate[];
}
