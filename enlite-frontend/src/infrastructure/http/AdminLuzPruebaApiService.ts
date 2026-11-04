/**
 * AdminLuzPruebaApiService — `POST /api/admin/luz-prueba/turn` (spec 086, contract §9.2).
 * It is the PLATFORM's route (same base and Firebase token as the other `/api/admin/*`), never the assistants-service's.
 * Success body has NO envelope; an error is `{ codigo, limite? }` → `LuzPruebaError{codigo,status,limite}`.
 * The message text is never logged here.
 */
import { FirebaseAuthService } from "@infrastructure/services/FirebaseAuthService";
import {
  LuzPruebaError,
  type LuzPruebaErrorCode,
  type LuzPruebaTurnRequest,
  type LuzPruebaTurnResponse,
} from "@domain/entities/LuzPrueba";

const BODY_CODES: readonly LuzPruebaErrorCode[] = [
  "REQUISICAO_INVALIDA",
  "TETO_DIARIO",
  "TRIAGE_INDISPONIVEL",
  "CONTADOR_FALHOU",
];

const CODE_BY_STATUS: Record<number, LuzPruebaErrorCode> = {
  400: "REQUISICAO_INVALIDA",
  401: "UNAUTHENTICATED",
  403: "NO_ACCESS",
  429: "TETO_DIARIO",
  500: "CONTADOR_FALHOU",
  502: "TRIAGE_INDISPONIVEL",
};

class AdminLuzPruebaApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_WORKER_FUNCTIONS_URL ??
      "http://localhost:8080";
  }

  async turn(req: LuzPruebaTurnRequest): Promise<LuzPruebaTurnResponse> {
    const token = await this.authService.getIdToken();
    const response = await fetch(`${this.baseURL}/api/admin/luz-prueba/turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(req),
    });
    const json = (await response.json().catch(() => ({}))) as {
      codigo?: string;
      limite?: number;
    } & Partial<LuzPruebaTurnResponse>;
    if (!response.ok) {
      const fromBody = BODY_CODES.find((c) => c === json.codigo);
      const codigo = fromBody ?? CODE_BY_STATUS[response.status] ?? "UNKNOWN";
      throw new LuzPruebaError(codigo, response.status, typeof json.limite === "number" ? json.limite : undefined);
    }
    return json as LuzPruebaTurnResponse;
  }
}

export const AdminLuzPruebaApiService = new AdminLuzPruebaApiServiceClass();
