/**
 * A API do painel de acessos — família `admin.permissions` do backend.
 *
 * Leitura sob `permission_management:read`; escrita sob
 * `permission_management:write`, e cada escrita desce no backend para uma
 * função `SECURITY DEFINER` (lex C4). Este cliente só carrega o dado; a
 * decisão de mostrar botão ou não é do `useCellAccess`, nunca daqui.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError, type ApiErrorResponse, type ApiResponse, type ApiSuccessResponse } from './ApiError';

export interface PermissionCell {
  resource: string;
  action: string;
  category: string;
  description?: string | null;
  ownerService: string;
  deprecatedAt?: string | null;
}

export interface CatalogCategory {
  category: string;
  cells: PermissionCell[];
}

export interface PermissionGroupDetail {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  cells: string[];
  countries: string[];
  memberCount: number;
}

export interface GroupMember {
  userId: string;
  email: string | null;
  role: string | null;
  status: string | null;
  assignedBy: string | null;
  assignedAt: string;
}

export interface CountryFeature {
  country: string;
  featureKey: string;
  enabled: boolean;
  config: unknown;
  source: 'default' | 'override';
  reason: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface PermissionAuditRow {
  id: string;
  userId: string;
  resource: string;
  action: string;
  resourceId: string | null;
  decision: string;
  createdAt: string;
  country: string | null;
}

export interface AuditFilters {
  userId?: string;
  resource?: string;
  since?: string;
  until?: string;
  limit?: number;
}

/** Códigos ESTÁVEIS que o backend publica no 409 — a frase de `error` pode mudar. */
export type PanelConflictCode = 'duplicate_name' | 'system_group' | 'last_manager';

class AdminPermissionsApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.authService.getIdToken();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json()) as ApiResponse<T> | T;
    // As leituras devolvem o corpo NU (`{groups: [...]}`); as escritas e os
    // erros vêm no envelope `{success, ...}`. Só o envelope com `success:false`
    // é erro — o resto é dado.
    if (typeof json === 'object' && json !== null && 'success' in json) {
      const env = json as ApiResponse<T>;
      if (!env.success) throw new ApiError(env as ApiErrorResponse, response.status);
      return (env as ApiSuccessResponse<T>).data;
    }
    if (!response.ok) throw new ApiError({ success: false, error: `HTTP ${response.status}` }, response.status);
    return json as T;
  }

  // ── Leitura ────────────────────────────────────────────────────────────────

  async getCatalog(includeDeprecated = false): Promise<CatalogCategory[]> {
    const q = includeDeprecated ? '?includeDeprecated=true' : '';
    return (await this.request<{ categories: CatalogCategory[] }>('GET', `/api/admin/permissions/catalog${q}`)).categories;
  }

  async listGroups(includeArchived = false): Promise<PermissionGroupDetail[]> {
    const q = includeArchived ? '?includeArchived=true' : '';
    return (await this.request<{ groups: PermissionGroupDetail[] }>('GET', `/api/admin/permission-groups${q}`)).groups;
  }

  async getGroup(id: string): Promise<PermissionGroupDetail> {
    return this.request<PermissionGroupDetail>('GET', `/api/admin/permission-groups/${id}`);
  }

  async listMembers(id: string): Promise<GroupMember[]> {
    return (await this.request<{ members: GroupMember[] }>('GET', `/api/admin/permission-groups/${id}/members`)).members;
  }

  async listCountryFeatures(country?: string): Promise<CountryFeature[]> {
    const q = country ? `?country=${encodeURIComponent(country)}` : '';
    return (await this.request<{ features: CountryFeature[] }>('GET', `/api/admin/country-features${q}`)).features;
  }

  async queryAudit(filters: AuditFilters = {}): Promise<PermissionAuditRow[]> {
    // `userId` saiu da query string do GET (parecer jurídico, C6: uid não pode
    // cair no log de request do Cloud Run) — com filtro por pessoa, o corpo vai
    // no POST; sem ele, o GET de sempre. Menos ramificação do que sempre usar
    // POST: a rota GET, mais cacheável, continua sendo o caminho comum.
    if (filters.userId) {
      return (
        await this.request<{ entries: PermissionAuditRow[] }>('POST', '/api/admin/permission-audit/query', filters)
      ).entries;
    }
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== '') params.set(k, String(v));
    }
    const q = params.toString() ? `?${params}` : '';
    return (await this.request<{ entries: PermissionAuditRow[] }>('GET', `/api/admin/permission-audit${q}`)).entries;
  }

  // ── Escrita ────────────────────────────────────────────────────────────────

  async createGroup(input: { name: string; description?: string | null }): Promise<{ groupId: string }> {
    return this.request('POST', '/api/admin/permission-groups', input);
  }

  async updateGroup(id: string, patch: { name?: string; description?: string | null }): Promise<void> {
    await this.request('PATCH', `/api/admin/permission-groups/${id}`, patch);
  }

  async archiveGroup(id: string): Promise<{ affectedMembers: number }> {
    return this.request('DELETE', `/api/admin/permission-groups/${id}`);
  }

  async setGroupPermissions(id: string, cellKeys: string[], reason?: string | null): Promise<{ cells: number }> {
    return this.request('PUT', `/api/admin/permission-groups/${id}/permissions`, { cellKeys, reason: reason ?? null });
  }

  async grantCountry(id: string, country: string, reason: string): Promise<{ scopeId: string }> {
    return this.request('POST', `/api/admin/permission-groups/${id}/countries`, { country, reason });
  }

  async revokeCountry(id: string, country: string): Promise<{ revoked: number }> {
    return this.request('DELETE', `/api/admin/permission-groups/${id}/countries/${country}`);
  }

  async addMember(id: string, userId: string): Promise<{ membershipId: string }> {
    return this.request('POST', `/api/admin/permission-groups/${id}/members`, { userId });
  }

  async removeMember(id: string, userId: string): Promise<{ removed: number }> {
    // userId vai no CORPO, não no path — uid de funcionário não pode cair no
    // log de request do Cloud Run (parecer jurídico, C6).
    return this.request('DELETE', `/api/admin/permission-groups/${id}/members`, { userId });
  }

  async setCountryFeature(
    country: string,
    featureKey: string,
    input: { enabled: boolean; config?: unknown; reason: string },
  ): Promise<void> {
    await this.request('PUT', `/api/admin/country-features/${country}/${encodeURIComponent(featureKey)}`, input);
  }
}

export const AdminPermissionsApiService = new AdminPermissionsApiServiceClass();
