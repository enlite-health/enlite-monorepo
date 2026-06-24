/**
 * IAnaCareApiClient — porta HTTP de baixo nível para a API AnaCare v2.
 *
 * Espelha o padrão de ITalentumApiClient.ts: interface pura de domínio +
 * DTOs co-localizados. Implementação em infrastructure/anacare/AnaCareClient.ts.
 *
 * Ref: docs/features/anacare/agencies-integration-api-v2.md
 */

// ─────────────────────────────────────────────────────────────────
// Catálogos (nurse-types / hiring-types)
// ─────────────────────────────────────────────────────────────────

export interface AnaCareNurseType {
  id: number;
  name: string;
}

export interface AnaCareHiringType {
  id: number;
  name: string;
}

// ─────────────────────────────────────────────────────────────────
// Recurso enfermera
// ─────────────────────────────────────────────────────────────────

/** Payload de criação/atualização de enfermera (campos em espanhol, API AnaCare v2) */
export interface AnaCareNursePayload {
  nombre: string;
  apellidos: string;
  /** "M" = femenino, "H" = masculino (INVERTIDO vs inglês) */
  genero: 'M' | 'H';
  email: string;
  telefono?: string;
  calle?: string;
  estado?: string;
  ciudad?: string;
  colonia?: string;
  codigo_postal?: string;
  fecha_nacimiento?: string; // YYYY-MM-DD
  cedula_ciudadania?: string;
  /** ID numérico ou nome exato do catálogo */
  tipo_enfermera?: number | string;
  /** ID numérico ou nome exato do catálogo */
  tipo_contratacion?: number | string;
}

/** Objeto enfermera retornado pela API */
export interface AnaCareNurse {
  id: number;
  nombre: string;
  apellidos: string;
  genero: 'M' | 'H';
  email: string;
  telefono?: string | null;
  calle?: string | null;
  estado?: string | null;
  ciudad?: string | null;
  colonia?: string | null;
  codigo_postal?: string | null;
  fecha_nacimiento?: string | null;
  cedula_ciudadania?: string | null;
  tipo_enfermera?: number | null;
  tipo_contratacion?: number | null;
}

/** Resposta paginada padrão da API AnaCare */
export interface AnaCarePagedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** Item do bulk PATCH */
export interface AnaCareNurseBulkItem extends Partial<AnaCareNursePayload> {
  id: number;
}

/** Payload do bulk PATCH */
export interface AnaCareNurseBulkPayload {
  items: AnaCareNurseBulkItem[];
}

// ─────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────

export interface IAnaCareApiClient {
  /** GET /api/v2/agencies/nurse-types/ — catálogo de tipos de enfermeira */
  listNurseTypes(): Promise<AnaCarePagedResponse<AnaCareNurseType>>;

  /** GET /api/v2/agencies/hiring-types/ — catálogo de tipos de contratação */
  listHiringTypes(): Promise<AnaCarePagedResponse<AnaCareHiringType>>;

  /** GET /api/v2/agencies/nurses/ — lista paginada de enfermeiras */
  listNurses(page?: number): Promise<AnaCarePagedResponse<AnaCareNurse>>;

  /** POST /api/v2/agencies/nurses/ — cria nova enfermeira; retorna o objeto criado */
  createNurse(payload: AnaCareNursePayload): Promise<AnaCareNurse>;

  /** GET /api/v2/agencies/nurses/<id>/ — busca enfermeira por ID externo */
  getNurse(id: number): Promise<AnaCareNurse>;

  /** PATCH /api/v2/agencies/nurses/<id>/ — atualização parcial */
  updateNurse(id: number, payload: Partial<AnaCareNursePayload>): Promise<AnaCareNurse>;

  /** PATCH /api/v2/agencies/nurses/bulk/ — atualização em lote (atômica) */
  bulkUpdateNurses(payload: AnaCareNurseBulkPayload): Promise<AnaCareNurse[]>;
}
