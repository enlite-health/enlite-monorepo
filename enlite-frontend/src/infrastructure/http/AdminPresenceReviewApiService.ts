/**
 * A API da fila de revisão de presença da coordenação (emenda 077 §6) — `/api/admin/presence/*`.
 *
 * Ambas as rotas exigem a célula `presence_exception:review`; mostrar a tela ou não é da página, nunca daqui. O WF resolve nome do prestador e nº do caso
 * SÓ na leitura; o ESTADO (pendente/decidido) é do attendance — a tela não o recalcula, relê. Envelope `{success:true,data}` ou `{success:false,code}`.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError } from './ApiError';

export const REVIEW_KINDS = ['EXCEPTION_PENDING', 'EXIT_DECLARED', 'CLOCK_UNVERIFIED', 'ENTRY_REFUSED_NO_ENTRY'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** Lista fechada de 5 (§3.5): o painel mostra o texto, o attendance grava o código. */
export const RESOLUTION_CODES = ['INDOOR_CONFIRMED', 'ADDRESS_TO_FIX', 'PATIENT_ELSEWHERE_CONFIRMED', 'NOT_AT_PATIENT', 'NO_EVIDENCE'] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];
export type PresenceDecision = 'APPROVED' | 'REFUSED';

export interface PresenceReviewItem {
  kind: ReviewKind;
  /** `event_id` (EXCEPTION_PENDING, CLOCK_UNVERIFIED), `declaration_id` (EXIT_DECLARED) ou `occurrence_id` (ENTRY_REFUSED_NO_ENTRY). */
  id: string;
  occurredAt: string;
  onDate: string | null;
  startTime: string | null;
  endTime: string | null;
  workerName: string | null;
  caseNumber: number | null;
  /** Motivo escolhido pela cuidadora (exceção de lugar) ou da 1ª recusa (entrada rechazada); `null` = o servidor detectou / não se aplica. */
  reason: string | null;
  exceptionKind: 'GEO_DECLARED' | 'GEO_SERVER_DISAGREES' | null;
  /** Metros inteiros, já arredondados pelo attendance. */
  distanceM: number | null;
  accuracyM: number | null;
}

export interface PresenceReviewPage {
  country: string;
  countries: string[];
  items: PresenceReviewItem[];
  nextCursor: string | null;
}

export class AdminPresenceReviewApiService {
  private static readonly authService = new FirebaseAuthService();

  private static baseURL(): string {
    return (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  private static async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await AdminPresenceReviewApiService.authService.getIdToken();
    const response = await fetch(`${AdminPresenceReviewApiService.baseURL()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json().catch(() => ({}))) as { success?: boolean; data?: T; code?: string; error?: string };
    if (!response.ok || json.success === false) {
      throw new ApiError({ success: false, error: json.error ?? json.code ?? `HTTP ${response.status}`, code: json.code }, response.status);
    }
    return json.data as T;
  }

  static getQueue(filter: { country?: string; kind?: ReviewKind; cursor?: string } = {}): Promise<PresenceReviewPage> {
    const params = new URLSearchParams();
    if (filter.country) params.set('country', filter.country);
    if (filter.kind) params.set('kind', filter.kind);
    if (filter.cursor) params.set('cursor', filter.cursor);
    const q = params.toString() ? `?${params}` : '';
    return AdminPresenceReviewApiService.request<PresenceReviewPage>('GET', `/api/admin/presence/review-queue${q}`);
  }

  static decide(eventId: string, decision: PresenceDecision, resolutionCode: ResolutionCode): Promise<{ eventId: string; decision: PresenceDecision; resolutionCode: string }> {
    return AdminPresenceReviewApiService.request('POST', `/api/admin/presence/exceptions/${encodeURIComponent(eventId)}/decision`, { decision, resolution_code: resolutionCode });
  }
}
