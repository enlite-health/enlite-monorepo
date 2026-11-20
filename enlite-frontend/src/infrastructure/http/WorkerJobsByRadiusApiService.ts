import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { WorkerJobsByRadius } from '@domain/entities/WorkerJobByRadius';

/** Falha tipada da rota: o `code` é o do servidor (FR-37: nenhum texto para tela). */
export class WorkerJobsByRadiusError extends Error {
  constructor(readonly code: 'NO_SERVICE_AREA' | 'ACCOUNT_INACTIVE' | 'HTTP_ERROR', readonly status: number) {
    super(code);
    this.name = 'WorkerJobsByRadiusError';
  }
}

/**
 * GET /api/workers/me/jobs?radius_km=100&view=home — UMA chamada (DD-3); o slider filtra no cliente.
 * Identidade só pelo token. 409 NO_SERVICE_AREA e 403 ACCOUNT_INACTIVE viram erro tipado.
 */
class WorkerJobsByRadiusApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string = (import.meta as { env?: { VITE_API_WORKER_FUNCTIONS_URL?: string } }).env?.VITE_API_WORKER_FUNCTIONS_URL
    || 'http://localhost:8080';

  async getHome(): Promise<WorkerJobsByRadius> {
    const token = await this.authService.getIdToken();
    const response = await fetch(`${this.baseURL}/api/workers/me/jobs?radius_km=100&view=home`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (response.ok) {
      const body = (await response.json()) as Partial<WorkerJobsByRadius> | null;
      // Corpo de outra forma (ex.: o stub genérico de `GET /api/workers/me*` dos e2e, `{success,data}`) NÃO é a resposta da rota:
      // vira erro e a lista pública segue, em vez de derrubar a home com `items` indefinido.
      if (!body || !Array.isArray(body.items) || !Array.isArray(body.missing) || !body.applied) throw new WorkerJobsByRadiusError('HTTP_ERROR', response.status);
      return body as WorkerJobsByRadius;
    }
    let code: unknown;
    try { code = ((await response.json()) as { code?: unknown }).code; } catch { code = undefined; }
    if (response.status === 409 && code === 'NO_SERVICE_AREA') throw new WorkerJobsByRadiusError('NO_SERVICE_AREA', 409);
    if (response.status === 403 && code === 'ACCOUNT_INACTIVE') throw new WorkerJobsByRadiusError('ACCOUNT_INACTIVE', 403);
    throw new WorkerJobsByRadiusError('HTTP_ERROR', response.status);
  }
}

export const WorkerJobsByRadiusApiService = new WorkerJobsByRadiusApiServiceClass();
