import { ENV } from '@infrastructure/config/env';

/**
 * LeadsApiService — public (unauthenticated) client for the B2C patient intake.
 * Calls POST /api/public/v1/leads. No Bearer token: the endpoint is public and
 * rate-limited server-side (Task 1, decisão D4).
 */

export type LeadServiceType = 'cuidadores' | 'acompanantes_terapeuticos' | 'psicologos';
export type LeadRequesterType = 'patient' | 'responsible';

export interface CreateLeadInput {
  serviceType: LeadServiceType;
  requesterType: LeadRequesterType;
  email: string;
  phone: string;
  name?: string;
}

export interface CreateLeadResult {
  id: string;
}

interface ApiEnvelope {
  success: boolean;
  data?: CreateLeadResult;
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

    let json: ApiEnvelope;
    try {
      json = (await response.json()) as ApiEnvelope;
    } catch {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.ok || !json.success || !json.data) {
      throw new Error(json.error || `HTTP ${response.status}`);
    }

    return json.data;
  }
}

export const LeadsApiService = new LeadsApiServiceClass();
