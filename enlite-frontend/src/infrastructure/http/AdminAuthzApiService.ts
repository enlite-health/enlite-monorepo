/**
 * `GET /v1/me/authz` — o contrato agregado do próprio ator.
 *
 * Fora de `AdminApiService` por dois motivos: (a) o arquivo já passa do teto de
 * 400 linhas; (b) a rota vive em `/v1`, não em `/api/admin` — é contrato
 * versionado (D115 §7), e o dia em que o BFF for extraído só esta classe muda.
 *
 * F3 (spec 026) acrescenta as rotas de simulação de grupo, mesmo `/v1/me/*`:
 * `GET /v1/me/simulation/groups`, `POST /v1/me/simulation`, `DELETE /v1/me/simulation`.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { AuthzContract, GroupSimulation } from '@domain/entities/Authz';

/**
 * Erro de uma ação de simulação (start/list) com o `code` do backend
 * preservado (`not_master_member`, `group_not_simulable`) — a UI mapeia o
 * `code` para a chave i18n certa (`access.simulation.groupNotSimulable`) em
 * vez de reparsear a mensagem.
 */
export class AuthzActionError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'AuthzActionError';
  }
}

class AdminAuthzApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async getMyAuthz(): Promise<AuthzContract> {
    const response = await fetch(`${this.baseURL}/v1/me/authz`, {
      headers: await this.authHeaders(),
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

  /** `GET /v1/me/simulation/groups` → grupos vivos sem o Master. 403 `not_master_member`. */
  async listSimulatableGroups(): Promise<Array<{ id: string; name: string }>> {
    const response = await fetch(`${this.baseURL}/v1/me/simulation/groups`, {
      headers: await this.authHeaders(),
    });
    if (!response.ok) throw await this.toActionError(response);
    return (await response.json()) as Array<{ id: string; name: string }>;
  }

  /** `POST /v1/me/simulation` → 201 com o snapshot da simulação. 403 `not_master_member` / 422 `group_not_simulable`. */
  async startSimulation(groupId: string): Promise<GroupSimulation> {
    const response = await fetch(`${this.baseURL}/v1/me/simulation`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ groupId }),
    });
    if (!response.ok) throw await this.toActionError(response);
    return (await response.json()) as GroupSimulation;
  }

  /** `DELETE /v1/me/simulation` → sempre 204, sem corpo — nunca chamar `.json()` no 204. */
  async endSimulation(): Promise<void> {
    const response = await fetch(`${this.baseURL}/v1/me/simulation`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    if (!response.ok) throw await this.toActionError(response);
  }

  private async toActionError(response: Response): Promise<AuthzActionError> {
    const body = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
    const code = body.code || body.error || `HTTP ${response.status}`;
    return new AuthzActionError(code, body.error ?? code);
  }
}

export const AdminAuthzApiService = new AdminAuthzApiServiceClass();
