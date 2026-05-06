/**
 * MatchmakingTypes
 *
 * Tipos internos e públicos compartilhados entre MatchmakingService,
 * MatchmakingHardFilter e MatchmakingLLMScorer.
 */

// ─── Tipos internos ───────────────────────────────────────────────────────────

export interface JobPosting {
  id: string;
  workerProfileSought: string | null;
  scheduleDaysHours: string | null;
  diagnosis: string | null;
  patientZone: string | null;
  serviceLat: number | null;
  serviceLng: number | null;
  requiredSex: string | null;
  requiredProfessions: string[] | null;
  pathologyTypes: string | null;
}

export interface ActiveCase {
  case_number: number | null;
  schedule_text: string | null;
}

export interface WorkerCandidate {
  workerId: string;
  phone: string;
  occupation: string | null;
  workerStatus: string | null;
  diagnosticPreferences: string[];
  sexEncrypted: string | null;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
  workZone: string | null;
  workerAddress: string | null;
  interestZone: string | null;
  workerLat: number | null;
  workerLng: number | null;
  activeCases: ActiveCase[];
  alreadyApplied: boolean;
  rejectionHistory: Record<string, number>;
  avgQualityRating: number | null;
}

export interface LLMMatchScore {
  score: number;
  reasoning: string;
  strengths: string[];
  red_flags: string[];
}

// ─── Tipos públicos ───────────────────────────────────────────────────────────

/**
 * Default radius (km) when caller doesn't specify one.
 * AT típico em Buenos Aires faz até ~30km de deslocamento — fora disso vira
 * problema operacional. Decisão de produto, NÃO de algoritmo.
 */
export const DEFAULT_RADIUS_KM = 30;

export interface MatchOptions {
  /** How many candidates to keep after the hard filter. Default 20. */
  topN?: number;
  /** Distance cap in kilometers. Default `DEFAULT_RADIUS_KM`. */
  radiusKm?: number;
  /** Skip workers already assigned to an active (uncovered) case. */
  excludeWithActiveCases?: boolean;
  /**
   * Run the structured scoring (Fase 2) and LLM scoring (Fase 3) after the
   * hard filter. Default `false` — operations doesn't have enough history
   * yet for the score signals (rejections, quality rating, diagnostic
   * preferences) to be reliable. Flip to `true` once the data matures.
   */
  useScoring?: boolean;
}

export interface ScoredCandidate {
  workerId: string;
  workerName: string;
  workerPhone: string;
  occupation: string | null;
  workZone: string | null;
  distanceKm: number | null;
  activeCasesCount: number;
  workerStatus: string | null;
  registrationWarning: string | null;
  structuredScore: number;
  llmScore: number | null;
  finalScore: number;
  llmReasoning: string | null;
  llmRedFlags: string[];
  llmStrengths: string[];
  alreadyApplied: boolean;
}

export interface MatchResult {
  jobPostingId: string;
  radiusKm: number | null;
  matchSummary: {
    hardFilteredCount: number;
    llmScoredCount: number;
  };
  candidates: ScoredCandidate[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function registrationWarning(workerStatus: string | null): string | null {
  switch (workerStatus) {
    case 'INCOMPLETE_REGISTER': return 'Cadastro incompleto — faltam dados ou documentos';
    case 'DISABLED':            return 'Worker desativado';
    case 'REGISTERED':          return null;
    default:                    return null;
  }
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
