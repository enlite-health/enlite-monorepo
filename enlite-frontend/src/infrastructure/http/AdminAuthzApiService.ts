/**
 * `GET /v1/me/authz` — o contrato agregado do próprio ator.
 *
 * Fora de `AdminApiService` por dois motivos: (a) o arquivo já passa do teto de
 * 400 linhas; (b) a rota vive em `/v1`, não em `/api/admin` — é contrato
 * versionado (D115 §7), e o dia em que o BFF for extraído só esta classe muda.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { AuthzContract } from '@domain/entities/Authz';

class AdminAuthzApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  async getMyAuthz(): Promise<AuthzContract> {
    const token = await this.authService.getIdToken();
    const response = await fetch(`${this.baseURL}/v1/me/authz`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    // A rota devolve o contrato NU (sem envelope `{success,data}`) no 200, e o
    // envelope de erro nos demais. 500 aqui é "não sei" — nunca vira contrato
    // vazio, porque vazio na tela significa "sem grupo" (D114).
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    return (await response.json()) as AuthzContract;
  }
}

export const AdminAuthzApiService = new AdminAuthzApiServiceClass();
