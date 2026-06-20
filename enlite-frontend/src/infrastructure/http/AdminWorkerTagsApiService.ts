/**
 * AdminWorkerTagsApiService
 *
 * CRUD do catálogo de tags de workers + atribuição/remoção por worker.
 * Extraído do AdminApiService para respeitar o limite de 400 linhas —
 * callers continuam usando `AdminApiService` (delega transparentemente).
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { WorkerTag } from '@domain/entities/WorkerTag';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}
interface ApiErrorResponse {
  success: false;
  error: string;
}
type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

class AdminWorkerTagsApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json()) as ApiResponse<T>;
    if (!json.success) {
      throw new Error(
        (json as ApiErrorResponse).error || `HTTP ${response.status}`,
      );
    }
    return (json as ApiSuccessResponse<T>).data;
  }

  async listWorkerTags(): Promise<WorkerTag[]> {
    return this.request<WorkerTag[]>('GET', '/api/admin/worker-tags');
  }

  async createWorkerTag(data: {
    name: string;
    color: string;
    description?: string;
  }): Promise<WorkerTag> {
    return this.request<WorkerTag>('POST', '/api/admin/worker-tags', data);
  }

  async updateWorkerTag(
    id: string,
    data: { name?: string; color?: string; description?: string },
  ): Promise<WorkerTag> {
    return this.request<WorkerTag>('PATCH', `/api/admin/worker-tags/${id}`, data);
  }

  async deleteWorkerTag(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/api/admin/worker-tags/${id}`);
  }

  async assignTagToWorker(workerId: string, tagId: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/api/admin/workers/${workerId}/tags/${tagId}`,
    );
  }

  async removeTagFromWorker(workerId: string, tagId: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/api/admin/workers/${workerId}/tags/${tagId}`,
    );
  }
}

export const AdminWorkerTagsApiService = new AdminWorkerTagsApiServiceClass();
