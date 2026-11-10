/**
 * `GET /v1/me/areas` — descoberta única das áreas da pessoa logada.
 *
 * Fora de `AdminApiService` pelo mesmo motivo de `AdminAuthzApiService` (arquivo acima do teto de
 * linhas; rota versionada em `/v1`, não em `/api/admin`). A resposta é o corpo NU, sem envelope.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { MyAreasResponse } from '@domain/entities/MyAreas';

class AreasApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  async getMyAreas(): Promise<MyAreasResponse> {
    const token = await this.authService.getIdToken();
    const response = await fetch(`${this.baseURL}/v1/me/areas`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    // Erro nunca vira lista vazia: vazio significa "sem área" e levaria a pessoa a /no-access.
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    return (await response.json()) as MyAreasResponse;
  }
}

export const AreasApiService = new AreasApiServiceClass();
