/**
 * AdminVacancyListApiService
 *
 * Handles vacancy listing and filter-options endpoints:
 *   - GET /api/admin/vacancies
 *   - GET /api/admin/vacancies/filter-options
 *
 * Extracted from AdminApiService to keep it under the 400-line limit.
 */

import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type {
  VacancyNote,
  CreateVacancyNotePayload,
} from '@domain/entities/VacancyNote';

export interface VacancyListFilters {
  search?: string;
  client?: string;
  status?: string;
  limit?: string;
  offset?: string;
  worker_type?: string;
  state?: string;
  city?: string;
  required_sex?: string;
  /** CSV of day-of-week integers 0–6 (0=domingo). */
  days?: string;
  time_from?: string;
  time_to?: string;
  /** Chave da allowlist do backend (spec 046 F3). */
  sort?: string;
  order?: string;
  /** Spec 084 F2: `'true'` mostra as vagas dadas de baja (só consulta). Ausente = escondidas. */
  include_baja?: string;
  /** Spec 084 F4: `'true'` = só as vagas na lista "pausar/retomar à mão no Talentum". */
  talentum_manual?: string;
}

export interface BajaRefusal {
  vacancyId: string;
  code: string;
  messages?: { es?: string; 'pt-BR'?: string };
}

/** O lote foi recusado INTEIRO (tudo-ou-nada): nenhuma vaga foi baixada. */
export class VacancyBajaRefusedError extends Error {
  constructor(readonly refused: BajaRefusal[]) {
    super('VACANCY_BAJA_REFUSED');
    this.name = 'VacancyBajaRefusedError';
  }
}

export interface VacancyFilterOptions {
  states: string[];
  cities: string[];
}

class AdminVacancyListApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as { env?: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? 'http://localhost:8080';
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.authService.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async listVacancies(
    filters?: VacancyListFilters,
  ): Promise<{ data: unknown[]; total: number }> {
    // Strip undefined / empty-string values to keep the URL clean.
    const clean: Record<string, string> = {};
    if (filters) {
      for (const [key, val] of Object.entries(filters)) {
        if (val !== undefined && val !== '') {
          clean[key] = val;
        }
      }
    }
    const params = new URLSearchParams(clean);
    const headers = await this.getAuthHeaders();
    const response = await fetch(
      `${this.baseURL}/api/admin/vacancies?${params}`,
      { method: 'GET', headers },
    );
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return { data: json.data, total: json.total };
  }

  /**
   * Spec 084 F1: dar baixa (DE_BAJA) em 1..200 vagas SEM serviço. Tudo-ou-nada: 409 `BAJA_REFUSED` vira
   * {@link VacancyBajaRefusedError} com cada recusa. NÃO existe o caminho inverso (R17).
   */
  async bajaVacancies(vacancyIds: string[]): Promise<{ baixadas: Array<{ vacancyId: string; statusBefore: string }> }> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(`${this.baseURL}/api/admin/vacancies/baja`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ vacancyIds }),
    });
    const json = await response.json();
    if (json.success) return json.data;
    if (response.status === 409 && json.code === 'BAJA_REFUSED') throw new VacancyBajaRefusedError(json.refused ?? []);
    throw new Error(json.error || `HTTP ${response.status}`);
  }

  async getVacancyFilterOptions(): Promise<VacancyFilterOptions> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(
      `${this.baseURL}/api/admin/vacancies/filter-options`,
      { method: 'GET', headers },
    );
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return json.data as VacancyFilterOptions;
  }

  async listVacancyNotes(vacancyId: string): Promise<VacancyNote[]> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(
      `${this.baseURL}/api/admin/vacancies/${vacancyId}/notes`,
      { method: 'GET', headers },
    );
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return json.data as VacancyNote[];
  }

  async createVacancyNote(
    vacancyId: string,
    payload: CreateVacancyNotePayload,
  ): Promise<VacancyNote> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(
      `${this.baseURL}/api/admin/vacancies/${vacancyId}/notes`,
      { method: 'POST', headers, body: JSON.stringify(payload) },
    );
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return json.data as VacancyNote;
  }
}

export const AdminVacancyListApiService = new AdminVacancyListApiServiceClass();
