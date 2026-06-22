/**
 * AdminDedupApiService
 *
 * Sub-service for the Deduplication Center endpoints.
 * Follows the same pattern as AdminContactNotesApiService — own request<T>,
 * own FirebaseAuthService instance, never imported into AdminApiService.
 */

import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type {
  DedupGroupSummary,
  DedupGroupDetail,
  MergeRequest,
  MergeResult,
  DismissRequest,
  DismissResult,
  MergeHistoryItem,
  UndoResult,
  ImportedDedupGroup,
} from '@domain/entities/DedupGroup';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}
interface ApiErrorResponse {
  success: false;
  error: string;
}
type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

class AdminDedupApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    // Fallback 'http://localhost:8080' is defensive dead code in practice:
    // VITE_API_WORKER_FUNCTIONS_URL is always set in .env.* and vitest globals.
    // Same pattern accepted in AdminContactNotesApiService and others.
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

  /**
   * GET /api/admin/dedup/groups
   * Returns the list of duplicate phone groups.
   */
  async getGroups(): Promise<DedupGroupSummary[]> {
    return this.request<DedupGroupSummary[]>('GET', '/api/admin/dedup/groups');
  }

  /**
   * GET /api/admin/dedup/groups/:phoneNormalized
   * Returns field-level comparison and reparent preview for a specific group.
   */
  async getGroupDetail(phoneNormalized: string): Promise<DedupGroupDetail> {
    const encoded = encodeURIComponent(phoneNormalized);
    return this.request<DedupGroupDetail>(
      'GET',
      `/api/admin/dedup/groups/${encoded}`,
    );
  }

  /**
   * POST /api/admin/dedup/merge
   * Executes the merge: survivor absorbs all other accounts.
   */
  async merge(payload: MergeRequest): Promise<MergeResult> {
    return this.request<MergeResult>('POST', '/api/admin/dedup/merge', payload);
  }

  /**
   * POST /api/admin/dedup/dismiss
   * Dismisses a duplicate group (marks it as not a real duplicate).
   */
  async dismiss(payload: DismissRequest): Promise<DismissResult> {
    return this.request<DismissResult>('POST', '/api/admin/dedup/dismiss', payload);
  }

  /**
   * GET /api/admin/dedup/history
   * Returns the list of executed merges with undo eligibility.
   */
  async getHistory(): Promise<MergeHistoryItem[]> {
    return this.request<MergeHistoryItem[]>('GET', '/api/admin/dedup/history');
  }

  /**
   * POST /api/admin/dedup/merges/:auditId/undo
   * Undoes a previously executed merge, restoring the absorbed account.
   */
  async undoMerge(auditId: string): Promise<UndoResult> {
    const encoded = encodeURIComponent(auditId);
    return this.request<UndoResult>(
      'POST',
      `/api/admin/dedup/merges/${encoded}/undo`,
    );
  }

  /**
   * GET /api/admin/dedup/imported-groups?onlyWithReal=true|false
   * Returns groups of accounts detected as duplicates by NAME.
   * onlyWithReal=true (default) returns only the 142 real↔imported priority groups.
   * onlyWithReal=false also includes imported↔imported groups.
   */
  async getImportedGroups(onlyWithReal = true): Promise<ImportedDedupGroup[]> {
    const qs = `onlyWithReal=${onlyWithReal ? 'true' : 'false'}`;
    return this.request<ImportedDedupGroup[]>(
      'GET',
      `/api/admin/dedup/imported-groups?${qs}`,
    );
  }
}

export const AdminDedupApiService = new AdminDedupApiServiceClass();
