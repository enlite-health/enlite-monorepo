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

export interface PatientAddressCreateInput {
  address_formatted: string;
  address_raw?: string;
  address_type: string;
}

export interface PatientAddressRow {
  id: string;
  patient_id: string;
  address_formatted: string;
  address_raw: string | null;
  address_type: string;
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
