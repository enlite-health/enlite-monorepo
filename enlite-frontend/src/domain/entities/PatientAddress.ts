/**
 * Domain entities for Patient Address matching and field clash resolution
 * Used in the vacancy creation wizard (Phase 7)
 */

export interface AddressMatchCandidate {
  patient_address_id: string;
  addressFormatted: string;
  addressRaw?: string | null;
  confidence: number;
  matchType: 'EXACT' | 'FUZZY' | 'PROXIMITY';
}

export interface PatientFieldClash {
  field: string;
  pdfValue: string | null;
  patientValue: string | null;
  action: 'IDENTICAL' | 'CLASH';
}

export interface ParsedVacancyResult {
  vacancy: Record<string, any>;
  prescreening: { questions: any[]; faq: any[] };
  description: {
    titulo_propuesta: string;
    descripcion_propuesta: string;
    perfil_profesional: string;
  };
}

export interface ParseVacancyFullResult {
  parsed: ParsedVacancyResult;
  addressMatches: AddressMatchCandidate[];
  fieldClashes: PatientFieldClash[];
  patientId: string | null;
}

/**
 * Lista fechada por parentesco (spec 019, D310 item c; migration 434 — `patient_addresses_type_check`).
 * `otro` exige `address_type_other` (≤40) na MESMA requisição. Sem `.default(...)` — ausência = `NULL`
 * = "sin especificar" (nunca inferido do `address_type` legado — spec 019 "Proibido").
 * MESMA lista do zod do backend (`AdminPatientAddressesController.ts`, `PATIENT_ADDRESS_TYPES`).
 */
export const PATIENT_ADDRESS_TYPES = [
  'domicilio_propio', 'casa_madre', 'casa_padre', 'casa_abuela',
  'casa_abuelo', 'escuela', 'trabajo', 'otro',
] as const;
export type PatientAddressType = (typeof PATIENT_ADDRESS_TYPES)[number];

export interface PatientAddressCreateInput {
  address_formatted: string;
  address_raw?: string;
  // Spec 019 (B4): `address_type` sai da criação — a lista fechada só entra pelo PATCH
  // (AdminPatientAddressesController). Endereço nasce com tipo NULL.
  /** Regra de nascimento (spec 019): sem principal ativo, nasce principal mesmo sem pedir. */
  is_default?: boolean;
  /** Spec 012, US-B2 — logística por endereço (mig 316). Zona = `neighborhood` (lex C2.7). */
  neighborhood?: string;
  logistics_corridor?: string;
  /** Texto livre sobre o domicílio — mascarado no Clarity, teto 2000 no servidor. */
  access_notes?: string;
}

/**
 * Body de PATCH /api/admin/patients/:id/addresses/:addressId — logística + PRINCIPAL + TIPO por
 * endereço (spec 012, US-B2; spec 019, D310 item c). `null` limpa o campo, exceto `is_default`
 * (booleano — `true` marca principal com troca atômica no servidor; `false`/ausente não desmarca).
 */
export interface PatientAddressLogisticsPayload {
  neighborhood?: string | null;
  logistics_corridor?: string | null;
  access_notes?: string | null;
  is_default?: boolean;
  address_type?: PatientAddressType | null;
  address_type_other?: string | null;
}

export interface PatientAddressRow {
  id: string;
  patient_id: string;
  address_formatted: string;
  address_raw: string | null;
  // C3 (spec 019): `address_type` NÃO existe neste tipo. O parentesco do domicílio é dado da
  // FICHA do paciente (`PatientAddressDetail.addressType`, endpoint diferente) — este tipo
  // espelha o wizard de criação de vaga, que nunca deve exibi-lo (CaseSelectStep exibia cru).
  display_order: number;
  source: string;
  /** Address complement (Depto, Piso, andar). Migration 157. Null until populated via UI. */
  complement: string | null;
  /** Latitude/Longitude (migration 153). Null in legacy ClickUp imports — UI may
   *  geocode the address on the fly to recover coords for display. Backend
   *  returns Postgres `numeric` as string, normalized to number in the API client. */
  lat: number | null;
  lng: number | null;
}

export interface PendingAddressReviewItem {
  id: string;
  case_number: number;
  vacancy_number: number;
  title: string;
  status: string;
  legacy_address_hint: string | null;
  patient_id: string | null;
  patient_name: string;
  audit_match_type: 'EXACT' | 'FUZZY' | 'NONE' | null;
  audit_confidence_score: number | null;
  audit_attempted_match: string | null;
}

/**
 * Lightweight address list item returned by GET /api/admin/patients/:patientId/addresses
 * Used in Phase 8 pending address review resolution flow.
 */
export interface PatientAddressListItem {
  id: string;
  address_formatted: string;
  address_raw: string | null;
  address_type: string;
  display_order: number;
}
