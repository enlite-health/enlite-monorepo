/**
 * AdminTherapeuticProjectsApiService — versões do projeto terapêutico e os 3 catálogos (spec 017).
 * Arquivo próprio pelo mesmo motivo do serviço contratado: `AdminApiService` bate no teto de 400 linhas.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type {
  AddedCategoryLink,
  CascadeRequestBody,
  CascadeResponse,
  CatalogItemBody,
  CatalogListOptions,
  CategoryLinkList,
  CreateTherapeuticProjectBody,
  IcdCategory,
  RemovedActivityCategory,
  RemovedObjectiveCategory,
  TherapeuticCatalogItem,
  AdminCatalogKind,
  ServiceExitReasonOption,
  ShiftTemplate,
  ShiftTemplateItem,
  TherapeuticFieldClass,
  TherapeuticProjectVersion,
} from '@domain/entities/TherapeuticProject';
import type { TherapeuticCatalogGateway } from '@domain/repositories/TherapeuticCatalogGateway';

/** `contactReminderDates` (spec 048): dias locais (`YYYY-MM-DD`) dos lembretes que FALTAM no ciclo aberto; `null` = sem ciclo. */
export interface TherapeuticProjectList {
  versions: TherapeuticProjectVersion[];
  fieldClass: TherapeuticFieldClass;
  contactReminderDates?: string[] | null;
}

export class TherapeuticProjectApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, body?: { code?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'TherapeuticProjectApiError';
    this.status = status;
    this.code = body?.code;
    this.details = body?.details;
  }
}

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}
interface ApiErrorResponse {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}
type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

class AdminTherapeuticProjectsApiServiceClass implements TherapeuticCatalogGateway {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new TherapeuticProjectApiError(`Erro ao conectar ao servidor (HTTP ${response.status})`, response.status);
    }
    const json: ApiResponse<T> = await response.json();
    if (!json.success) {
      throw new TherapeuticProjectApiError(json.error || `HTTP ${response.status}`, response.status, json);
    }
    return json.data;
  }

  /**
   * GET /api/admin/patients/:id/therapeutic-projects — todas as versões, mais recente primeiro.
   * `fieldClass` (task 7.7) é o espelho de `THERAPEUTIC_FIELD_CLASS` do backend — o form lê daqui
   * para saber quais campos travam fora de `mode:'new'`; este client NÃO copia a lista.
   */
  async listVersions(patientId: string): Promise<TherapeuticProjectList> {
    return this.request<TherapeuticProjectList>(
      'GET',
      `/api/admin/patients/${patientId}/therapeutic-projects`,
    );
  }

  /**
   * GET /api/admin/patients/:id/therapeutic-projects/:vid — `purpose: 'export'` deixa a trilha
   * `export_pdf` (lex C13): o PDF busca a versão A CADA clique, nunca reusa o que a tela já tinha.
   */
  async getVersion(patientId: string, versionId: string, opts: { purpose?: 'export' } = {}): Promise<TherapeuticProjectVersion> {
    const qs = opts.purpose ? `?purpose=${opts.purpose}` : '';
    return this.request<TherapeuticProjectVersion>('GET', `/api/admin/patients/${patientId}/therapeutic-projects/${versionId}${qs}`);
  }

  /** POST /api/admin/patients/:id/therapeutic-projects — `mode: 'new'` (major+1.0) | `mode: 'edit'` (minor+1). */
  async createVersion(patientId: string, body: CreateTherapeuticProjectBody): Promise<TherapeuticProjectVersion> {
    return this.request<TherapeuticProjectVersion>('POST', `/api/admin/patients/${patientId}/therapeutic-projects`, body);
  }

  /** POST /api/admin/patients/:id/therapeutic-projects/:vid/annul (lex C5). */
  async annulVersion(patientId: string, versionId: string, reason: string): Promise<TherapeuticProjectVersion> {
    return this.request<TherapeuticProjectVersion>('POST', `/api/admin/patients/${patientId}/therapeutic-projects/${versionId}/annul`, { reason });
  }

  /** GET /api/admin/therapeutic-catalogs/<kind> */
  async listCatalog(kind: AdminCatalogKind, opts: CatalogListOptions = {}): Promise<TherapeuticCatalogItem[]> {
    const params = new URLSearchParams();
    if (opts.includeInactive) params.set('includeInactive', 'true');
    if (opts.categoryCode) params.set('categoryCode', opts.categoryCode);
    if (opts.objectiveId) params.set('objectiveId', opts.objectiveId);
    const query = params.toString();
    const qs = query ? `?${query}` : '';
    const { items } = await this.request<{ kind: AdminCatalogKind; items: TherapeuticCatalogItem[] }>('GET', `/api/admin/therapeutic-catalogs/${kind}${qs}`);
    return items;
  }

  /** GET /api/admin/therapeutic-catalogs/service-exit-reasons/options — só ativos; sob `patient_services:read`. */
  async listServiceExitReasonOptions(): Promise<ServiceExitReasonOption[]> {
    const { items } = await this.request<{ items: ServiceExitReasonOption[] }>('GET', '/api/admin/therapeutic-catalogs/service-exit-reasons/options');
    return items;
  }

  /** GET /api/admin/therapeutic-catalogs/service-shift-templates (spec 074). */
  async listShiftTemplates(opts: { includeInactive?: boolean } = {}): Promise<ShiftTemplate[]> {
    const qs = opts.includeInactive ? '?includeInactive=true' : '';
    const { items } = await this.request<{ kind: string; items: ShiftTemplate[] }>('GET', `/api/admin/therapeutic-catalogs/service-shift-templates${qs}`);
    return items;
  }

  /** GET …/service-shift-templates/options — só ativas, com os turnos; sob `patient_services:read`. */
  async listShiftTemplateOptions(): Promise<ShiftTemplate[]> {
    const { items } = await this.request<{ items: ShiftTemplate[] }>('GET', '/api/admin/therapeutic-catalogs/service-shift-templates/options');
    return items;
  }

  /** POST …/service-shift-templates */
  async createShiftTemplate(body: { label: string; items: ShiftTemplateItem[] }): Promise<ShiftTemplate> {
    return this.request<ShiftTemplate>('POST', '/api/admin/therapeutic-catalogs/service-shift-templates', body);
  }

  /** PATCH …/service-shift-templates/:itemId — `items` presente substitui os turnos; sem DELETE (soft delete por `active`). */
  async updateShiftTemplate(itemId: string, body: { label?: string; active?: boolean; items?: ShiftTemplateItem[] }): Promise<ShiftTemplate> {
    return this.request<ShiftTemplate>('PATCH', `/api/admin/therapeutic-catalogs/service-shift-templates/${itemId}`, body);
  }

  /** POST /api/admin/therapeutic-catalogs/<kind> — objetivo leva `serviceCode`, atividade leva `objectiveId`; sem `segmentId`. */
  async createCatalogItem(kind: AdminCatalogKind, body: CatalogItemBody): Promise<TherapeuticCatalogItem> {
    return this.request<TherapeuticCatalogItem>('POST', `/api/admin/therapeutic-catalogs/${kind}`, body);
  }

  /** PATCH /api/admin/therapeutic-catalogs/<kind>/:itemId — Merge Patch (DD-24: `null` limpa, chave ausente não toca); sem DELETE. */
  async updateCatalogItem(kind: AdminCatalogKind, itemId: string, body: CatalogItemBody): Promise<TherapeuticCatalogItem> {
    return this.request<TherapeuticCatalogItem>('PATCH', `/api/admin/therapeutic-catalogs/${kind}/${itemId}`, body);
  }

  /** POST /api/admin/therapeutic-catalogs/cascade — leitura que usa POST (corpo com até 20 URIs). */
  async cascade(body: CascadeRequestBody): Promise<CascadeResponse> {
    return this.request<CascadeResponse>('POST', '/api/admin/therapeutic-catalogs/cascade', body);
  }

  /** GET /api/admin/therapeutic-catalogs/icd-categories?q= */
  async searchIcdCategories(q: string): Promise<IcdCategory[]> {
    return this.request<IcdCategory[]>('GET', `/api/admin/therapeutic-catalogs/icd-categories?q=${encodeURIComponent(q)}`);
  }

  /** Vínculos objetivo/atividade ↔ categoria CID-11: mesma rota-base, dono escolhido pelo kind (tabela, sem if). */
  private categoriesPath(owner: 'specific-objectives' | 'activities', itemId: string, code?: string): string {
    const base = `/api/admin/therapeutic-catalogs/${owner}/${itemId}/categories`;
    return code === undefined ? base : `${base}/${encodeURIComponent(code)}`;
  }

  /** GET …/specific-objectives/:itemId/categories */
  async listObjectiveCategories(objectiveId: string): Promise<CategoryLinkList> {
    return this.request<CategoryLinkList>('GET', this.categoriesPath('specific-objectives', objectiveId));
  }

  /** POST …/specific-objectives/:itemId/categories `{ code }` */
  async addObjectiveCategory(objectiveId: string, code: string): Promise<AddedCategoryLink> {
    return this.request<AddedCategoryLink>('POST', this.categoriesPath('specific-objectives', objectiveId), { code });
  }

  /** DELETE …/specific-objectives/:itemId/categories/:code — leva junto os vínculos das atividades dele. */
  async removeObjectiveCategory(objectiveId: string, code: string): Promise<RemovedObjectiveCategory> {
    return this.request<RemovedObjectiveCategory>('DELETE', this.categoriesPath('specific-objectives', objectiveId, code));
  }

  /** GET …/activities/:itemId/categories */
  async listActivityCategories(activityId: string): Promise<CategoryLinkList> {
    return this.request<CategoryLinkList>('GET', this.categoriesPath('activities', activityId));
  }

  /** POST …/activities/:itemId/categories `{ code }` — fora das categorias do objetivo: 422 `icd_category_not_in_objective`. */
  async addActivityCategory(activityId: string, code: string): Promise<AddedCategoryLink> {
    return this.request<AddedCategoryLink>('POST', this.categoriesPath('activities', activityId), { code });
  }

  /** DELETE …/activities/:itemId/categories/:code */
  async removeActivityCategory(activityId: string, code: string): Promise<RemovedActivityCategory> {
    return this.request<RemovedActivityCategory>('DELETE', this.categoriesPath('activities', activityId, code));
  }
}

export const AdminTherapeuticProjectsApiService = new AdminTherapeuticProjectsApiServiceClass();
