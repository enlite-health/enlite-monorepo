/**
 * AdminInsuranceApiService — obras sociais, contratos/termos, contatos e o vínculo serviço → contrato (spec 058 Parte A).
 * Arquivo próprio pelo mesmo motivo dos irmãos (`AdminApiService` bate no teto de 400 linhas). Rotas: `adminInsuranceRoutes.ts`
 * do back (montadas em /api/admin).
 *
 * O corpo de resposta é VALIDADO por zod (`domain/entities/Insurance*.ts`): drift de contrato quebra aqui, alto, e não vira
 * `undefined` na tela. Erro HTTP vira `InsuranceApiError` com `status`, `code` (o do mapa de erros do back: `REQUIRES_NEW_SERVICE`,
 * `RANGE_OVERLAP`, `INVALID_<constraint>`...) e `details` — quem traduz para a pessoa é `insuranceErrorMessageKey`.
 */
import type { ZodType } from 'zod';
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import {
  insuranceContractItemSchema,
  insuranceContractListSchema,
  type CreateInsuranceContractBody,
  type InsuranceContractItem,
  type InsuranceTermBody,
  type PatchInsuranceContractBody,
  type SupersedeInsuranceTermBody,
} from '@domain/entities/InsuranceContract';
import {
  createdInsuranceProviderSchema,
  insuranceProviderContactListSchema,
  insuranceProviderContactSchema,
  insuranceProviderDetailSchema,
  insuranceProviderListSchema,
  insuranceProviderPatientListSchema,
  insuranceProvidersForServiceSchema,
  type CreateInsuranceProviderBody,
  type CreatedInsuranceProvider,
  type InsuranceContactBody,
  type InsuranceProviderContact,
  type InsuranceProviderDetail,
  type InsuranceProviderListItem,
  type InsuranceProviderPatient,
  type InsuranceProvidersForService,
  type PatchInsuranceContactBody,
  type PatchInsuranceProviderBody,
} from '@domain/entities/InsuranceProviderDetail';
import type {
  CreateContractLinkBody,
  EndContractLinkBody,
  PatientContractedServiceDetail,
  SupersedeContractLinkBody,
} from '@domain/entities/PatientContractedService';

export class InsuranceApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, body?: { code?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'InsuranceApiError';
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

/** Query string só com o que veio preenchido (nada de `?search=undefined`). */
function queryString(params: Record<string, string | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

class AdminInsuranceApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL = (import.meta as any).env?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  private async request<T>(method: string, path: string, schema: ZodType<T> | null, body?: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new InsuranceApiError(`Erro ao conectar ao servidor (HTTP ${response.status})`, response.status);
    }
    const json: ApiResponse<unknown> = await response.json();
    if (!json.success) {
      throw new InsuranceApiError(json.error || `HTTP ${response.status}`, response.status, json);
    }
    return schema ? schema.parse(json.data) : (json.data as T);
  }

  // ── Obras sociais ──────────────────────────────────────────────────────────

  /** GET /api/admin/insurance-providers — lista da página (busca por nome). */
  async listProviders(opts: { search?: string; includeInactive?: boolean } = {}): Promise<InsuranceProviderListItem[]> {
    const { items } = await this.request('GET', `/api/admin/insurance-providers${queryString(opts)}`, insuranceProviderListSchema);
    return items;
  }

  /** POST /api/admin/catalogs/insurance-providers — cria só com o nome (o código sai dele). */
  createProvider(body: CreateInsuranceProviderBody): Promise<CreatedInsuranceProvider> {
    return this.request('POST', '/api/admin/catalogs/insurance-providers', createdInsuranceProviderSchema, body);
  }

  /** GET /api/admin/insurance-providers/:code — Dados gerais. */
  getProvider(code: string): Promise<InsuranceProviderDetail> {
    return this.request('GET', `/api/admin/insurance-providers/${encodeURIComponent(code)}`, insuranceProviderDetailSchema);
  }

  /** PATCH /api/admin/insurance-providers/:code — ausente = não toca; `null` limpa só os anuláveis. */
  patchProvider(code: string, body: PatchInsuranceProviderBody): Promise<InsuranceProviderDetail> {
    return this.request('PATCH', `/api/admin/insurance-providers/${encodeURIComponent(code)}`, insuranceProviderDetailSchema, body);
  }

  /**
   * GET /api/admin/insurance-providers/for-service?country= — a cascata do serviço: só as ATIVAS com contrato oferecido no país
   * (mais a `selected`, mesmo inativa). `asOf` = o "hoje" do país, que o formulário usa como início sugerido do vínculo.
   */
  listProvidersForService(country: string, selected?: string): Promise<InsuranceProvidersForService> {
    return this.request('GET', `/api/admin/insurance-providers/for-service${queryString({ country, selected })}`, insuranceProvidersForServiceSchema);
  }

  /** GET /api/admin/insurance-providers/:code/patients — §L, somente leitura. */
  async listProviderPatients(code: string, country?: string): Promise<InsuranceProviderPatient[]> {
    const { items } = await this.request('GET', `/api/admin/insurance-providers/${encodeURIComponent(code)}/patients${queryString({ country })}`, insuranceProviderPatientListSchema);
    return items;
  }

  // ── Empregados (contatos) ──────────────────────────────────────────────────

  async listContacts(code: string, includeRetired = false): Promise<InsuranceProviderContact[]> {
    const { items } = await this.request('GET', `/api/admin/insurance-providers/${encodeURIComponent(code)}/contacts${queryString({ includeRetired: includeRetired || undefined })}`, insuranceProviderContactListSchema);
    return items;
  }

  createContact(code: string, body: InsuranceContactBody): Promise<InsuranceProviderContact> {
    return this.request('POST', `/api/admin/insurance-providers/${encodeURIComponent(code)}/contacts`, insuranceProviderContactSchema, body);
  }

  patchContact(code: string, contactId: string, body: PatchInsuranceContactBody): Promise<InsuranceProviderContact> {
    return this.request('PATCH', `/api/admin/insurance-providers/${encodeURIComponent(code)}/contacts/${contactId}`, insuranceProviderContactSchema, body);
  }

  /** POST …/contacts/:id/retire — nunca apaga; o contato some da lista. */
  retireContact(code: string, contactId: string): Promise<InsuranceProviderContact> {
    return this.request('POST', `/api/admin/insurance-providers/${encodeURIComponent(code)}/contacts/${contactId}/retire`, insuranceProviderContactSchema, {});
  }

  // ── Contratos e termos ─────────────────────────────────────────────────────

  /**
   * GET …/:code/contracts — `offered: true` devolve só os contratos com termo OFERECIDO (o que a cascata do serviço lista).
   * `country` recorta (o back também recorta pelo escopo do ator).
   */
  async listContracts(code: string, opts: { offered?: boolean; country?: string } = {}): Promise<InsuranceContractItem[]> {
    const { items } = await this.request('GET', `/api/admin/insurance-providers/${encodeURIComponent(code)}/contracts${queryString({ offered: opts.offered ? true : undefined, country: opts.country })}`, insuranceContractListSchema);
    return items;
  }

  createContract(code: string, body: CreateInsuranceContractBody): Promise<InsuranceContractItem> {
    return this.request('POST', `/api/admin/insurance-providers/${encodeURIComponent(code)}/contracts`, insuranceContractItemSchema, body);
  }

  patchContract(contractId: string, body: PatchInsuranceContractBody): Promise<InsuranceContractItem> {
    return this.request('PATCH', `/api/admin/insurance-contracts/${contractId}`, insuranceContractItemSchema, body);
  }

  addTerm(contractId: string, body: InsuranceTermBody): Promise<InsuranceContractItem> {
    return this.request('POST', `/api/admin/insurance-contracts/${contractId}/terms`, insuranceContractItemSchema, body);
  }

  supersedeTerm(contractId: string, termId: string, body: SupersedeInsuranceTermBody): Promise<InsuranceContractItem> {
    return this.request('POST', `/api/admin/insurance-contracts/${contractId}/terms/${termId}/supersede`, insuranceContractItemSchema, body);
  }

  // ── Vínculo serviço contratado → contrato (a resposta é o SERVIÇO projetado para o ator) ──

  private linkPath(patientId: string, serviceId: string): string {
    return `/api/admin/patients/${patientId}/contracted-services/${serviceId}/contract-link`;
  }

  /** POST …/contract-link — 1º vínculo (201). */
  createContractLink(patientId: string, serviceId: string, body: CreateContractLinkBody): Promise<PatientContractedServiceDetail> {
    return this.request('POST', this.linkPath(patientId, serviceId), null, body);
  }

  /** POST …/contract-link/end — encerra o vínculo vivo (`validTo` inclusivo). */
  endContractLink(patientId: string, serviceId: string, body: EndContractLinkBody): Promise<PatientContractedServiceDetail> {
    return this.request('POST', `${this.linkPath(patientId, serviceId)}/end`, null, body);
  }

  /** POST …/contract-link/supersede — troca (`SWITCHED`, mesma obra social) ou corrige (`CORRECTION`). */
  supersedeContractLink(patientId: string, serviceId: string, body: SupersedeContractLinkBody): Promise<PatientContractedServiceDetail> {
    return this.request('POST', `${this.linkPath(patientId, serviceId)}/supersede`, null, body);
  }
}

export const AdminInsuranceApiService = new AdminInsuranceApiServiceClass();
