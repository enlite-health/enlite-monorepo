import { ENV } from '@infrastructure/config/env';

/**
 * LeadsApiService — public (unauthenticated) client for the B2C patient intake.
 * Calls POST /api/public/v1/leads. No Bearer token: the endpoint is public and
 * rate-limited server-side (Task 1, decisão D4).
 */

export type LeadServiceType = 'cuidadores' | 'acompanantes_terapeuticos' | 'psicologos';
export type LeadRequesterType = 'patient' | 'responsible';
export type AdmissionCountry = 'AR' | 'BR';

export interface CreateLeadInput {
  serviceType: LeadServiceType;
  requesterType: LeadRequesterType;
  email: string;
  phone: string;
  name?: string;
  country: AdmissionCountry;
  /** Explicit consent to be contacted (WhatsApp/email). Required by the form. */
  consent: boolean;
}

export interface CreateLeadResult {
  id: string;
}

/** A bookable admission interview slot. `label` is already formatted in the country tz. */
export interface AdmissionSlot {
  startISO: string;
  label: string;
}

export interface GetAdmissionSlotsResult {
  slots: AdmissionSlot[];
}

export interface BookAdmissionInput {
  patientId: string;
  slotStartISO: string;
  country: AdmissionCountry;
}

export interface BookAdmissionResult {
  hostDisplayName: string;
  slotStartISO: string;
  meetLink: string;
}

/**
 * Typed error from the admission endpoints. `code` carries the server error
 * code (e.g. 'SLOT_TAKEN' on 409) so callers can branch without string-matching
 * a localized message.
 */
export class AdmissionApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'AdmissionApiError';
    this.code = code;
    this.status = status;
  }
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

class LeadsApiServiceClass {
  private readonly baseURL: string;

  constructor() {
    this.baseURL = ENV.API_WORKER_FUNCTIONS_URL;
  }

  async createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
    const response = await fetch(`${this.baseURL}/api/public/v1/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    let json: ApiEnvelope<CreateLeadResult>;
    try {
      json = (await response.json()) as ApiEnvelope<CreateLeadResult>;
    } catch {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.ok || !json.success || !json.data) {
      throw new Error(json.error || `HTTP ${response.status}`);
    }

    return json.data;
  }

  /**
   * GET /api/public/v1/admission/slots?country=AR|BR — public, no auth.
   * Returns the available interview slots (labels formatted server-side in the
   * country tz). Accepts both the enveloped ({ data: { slots } }) and the bare
   * ({ slots }) shapes so it is resilient to the endpoint's response wrapper.
   */
  async getAdmissionSlots(country: AdmissionCountry): Promise<AdmissionSlot[]> {
    const response = await fetch(
      `${this.baseURL}/api/public/v1/admission/slots?country=${encodeURIComponent(country)}`,
    );

    let json: ApiEnvelope<GetAdmissionSlotsResult> & Partial<GetAdmissionSlotsResult>;
    try {
      json = (await response.json()) as ApiEnvelope<GetAdmissionSlotsResult> &
        Partial<GetAdmissionSlotsResult>;
    } catch {
      throw new AdmissionApiError(`HTTP ${response.status}`, String(response.status), response.status);
    }

    if (!response.ok || json.success === false) {
      throw new AdmissionApiError(
        json.error || `HTTP ${response.status}`,
        json.error || String(response.status),
        response.status,
      );
    }

    const payload = json.data ?? json;
    return payload.slots ?? [];
  }

  /**
   * POST /api/public/v1/admission/book — public, no auth. Books the chosen slot
   * for the created lead. On 409 the thrown AdmissionApiError has code
   * 'SLOT_TAKEN' so the UI can re-fetch and ask the user to pick again.
   */
  async bookAdmission(input: BookAdmissionInput): Promise<BookAdmissionResult> {
    const response = await fetch(`${this.baseURL}/api/public/v1/admission/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    let json: ApiEnvelope<BookAdmissionResult> & Partial<BookAdmissionResult>;
    try {
      json = (await response.json()) as ApiEnvelope<BookAdmissionResult> &
        Partial<BookAdmissionResult>;
    } catch {
      const code = response.status === 409 ? 'SLOT_TAKEN' : String(response.status);
      throw new AdmissionApiError(`HTTP ${response.status}`, code, response.status);
    }

    if (!response.ok || json.success === false) {
      const code = json.error || (response.status === 409 ? 'SLOT_TAKEN' : String(response.status));
      throw new AdmissionApiError(json.error || `HTTP ${response.status}`, code, response.status);
    }

    const payload = json.data ?? json;
    return {
      hostDisplayName: payload.hostDisplayName ?? '',
      slotStartISO: payload.slotStartISO ?? input.slotStartISO,
      meetLink: payload.meetLink ?? '',
    };
  }
}

export const LeadsApiService = new LeadsApiServiceClass();
