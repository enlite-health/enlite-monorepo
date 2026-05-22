/**
 * clickupWebhookHelper.ts
 *
 * Helper para disparar payloads do webhook ClickUp em testes E2E de integração visual.
 *
 * Rota usada: POST /api/webhooks/clickup/patient
 * Auth: HMAC-SHA256 no header X-Signature (segredo: CLICKUP_WEBHOOK_SECRET)
 *
 * Decisão sobre dropdowns:
 *   O ClickUpFieldResolver precisa de field definitions da API ClickUp para resolver
 *   dropdowns (sexo, tipo de documento, dependência). Em ambiente de teste, o resolver
 *   é inicializado com maps vazios (NODE_ENV=test + CLICKUP_API_TOKEN fake → HTTP 401
 *   → fallback para resolver vazio). Portanto, todos os campos dropdown retornam null
 *   no mapeamento — isso é esperado e documentado. Apenas campos de texto direto são
 *   populados: firstName, lastName, phone, providerName, memberId, address, caseNumber.
 *
 * _injectedTask:
 *   Para evitar que o controller faça fetch real à API do ClickUp (task não existe),
 *   passamos o objeto task completo no campo _injectedTask do payload webhook. Quando
 *   NODE_ENV=test, o controller usa esse objeto diretamente ao invés de fazer GET
 *   https://api.clickup.com/api/v2/task/:id.
 */

import * as crypto from 'crypto';
import type { APIRequestContext } from '@playwright/test';

// ── Constants ─────────────────────────────────────────────────────────────────

export const BACKEND_URL = 'http://localhost:8080';
export const PATIENT_LIST_ID = '901304883903';

/** Segredo configurado no docker-compose.test.yml — CLICKUP_WEBHOOK_SECRET */
export const CLICKUP_WEBHOOK_SECRET = 'test-secret-clickup-e2e-only';

// ── Type definitions (duplicadas do worker-functions — não compartilhar entre repos) ──

export interface ClickUpTaskCustomField {
  id: string;
  name: string;
  type: string;
  value?: unknown;
}

export interface ClickUpTask {
  id: string;
  name: string;
  status: {
    status: string;
    color?: string;
    type?: string;
  };
  parent: string | null;
  custom_fields: ClickUpTaskCustomField[];
  list?: {
    id: string;
    name?: string;
  };
  url: string;
  date_created: string;
  date_updated: string;
}

export interface ClickUpWebhookPayload {
  event: string;
  webhook_id: string;
  task_id: string;
  list_id?: string;
  history_items?: unknown[];
  /** Test-only: skips fetchTask no controller (NODE_ENV=test). */
  _injectedTask?: ClickUpTask;
}

// ── Location field shape (ClickUp structured location) ───────────────────────

export interface ClickUpLocationValue {
  formatted_address: string;
  lat?: number;
  lng?: number;
}

// ── HMAC signing ─────────────────────────────────────────────────────────────

/**
 * Calcula o HMAC-SHA256 do body raw usando o segredo do webhook.
 * Retorna hex string para o header X-Signature.
 */
export function signClickUpPayload(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// ── Payload builder ───────────────────────────────────────────────────────────

export interface PatientWebhookFields {
  clickupTaskId: string;
  /** Ex: "Ana María" */
  firstName: string;
  /** Ex: "García" */
  lastName: string;
  /** Ex: "+541112345678" */
  phone?: string;
  /** Texto livre. Ex: "OSDE" */
  providerName?: string;
  /** Número de afiliado. Ex: "OS-987654" */
  memberId?: string;
  /** Location object para Domicilio 1 Principal Paciente */
  address?: ClickUpLocationValue;
  /** Texto para Zona o Barrio Paciente */
  neighborhood?: string;
  /** Location object para Provincia del Paciente */
  province?: ClickUpLocationValue;
  /** Texto para Ciudad / Localidad del Paciente */
  city?: string;
  /** Número do caso. Ex: "9999" */
  caseNumber?: string;
  /** ClickUp task status string. Default: "activo" */
  statusLabel?: string;
}

function makeCf(id: string, name: string, type: string, value: unknown): ClickUpTaskCustomField {
  return { id, name, type, value };
}

/**
 * Constrói o objeto ClickUpTask com os campos relevantes para o mapper.
 * Dropdowns (sexo, tipo de documento, dependência) são omitidos — resolver
 * retorna null para eles em modo test (sem field definitions).
 */
export function buildPatientTask(fields: PatientWebhookFields): ClickUpTask {
  const now = String(Date.now());
  const customFields: ClickUpTaskCustomField[] = [
    makeCf('cf-nombre',    'Nombre de Paciente',    'text',     fields.firstName),
    makeCf('cf-apellido',  'Apellido del Paciente', 'text',     fields.lastName),
    makeCf('cf-phone',     'Número de WhatsApp Paciente', 'text', fields.phone ?? null),
    makeCf('cf-cobertura', 'Cobertura Informada',   'text',     fields.providerName ?? null),
    makeCf('cf-afiliado',  'Número ID Afiliado Paciente', 'text', fields.memberId ?? null),
    makeCf('cf-caso',      'Caso Número',           'text',     fields.caseNumber ?? null),
    makeCf('cf-dom1',      'Domicilio 1 Principal Paciente', 'location', fields.address ?? null),
    makeCf('cf-provincia', 'Provincia del Paciente', 'location', fields.province ?? null),
    makeCf('cf-ciudad',    'Ciudad / Localidad del Paciente', 'location', null),
    makeCf('cf-barrio',    'Zona o Barrio Paciente', 'short_text', fields.neighborhood ?? null),
    // Campos de texto sem valor → null (não populados no teste)
    makeCf('cf-dom2',  'Domicilio 2 Principal Paciente', 'location', null),
    makeCf('cf-dom3',  'Domicilio 3 Principal Paciente', 'location', null),
    makeCf('cf-diag',  'Diagnóstico (si lo conoce)', 'text', null),
  ];

  return {
    id:            fields.clickupTaskId,
    name:          `${fields.lastName}, ${fields.firstName}`,
    status:        { status: fields.statusLabel ?? 'activo', color: '#00c800', type: 'custom' },
    parent:        null,
    custom_fields: customFields,
    list:          { id: PATIENT_LIST_ID, name: 'Estado de Pacientes' },
    url:           `https://app.clickup.com/t/${fields.clickupTaskId}`,
    date_created:  now,
    date_updated:  now,
  };
}

/**
 * Constrói o payload completo do webhook ClickUp patient incluindo _injectedTask.
 */
export function buildPatientWebhookPayload(
  fields: PatientWebhookFields,
  eventType: 'taskCreated' | 'taskUpdated' | 'taskStatusUpdated' = 'taskCreated',
): ClickUpWebhookPayload {
  const task = buildPatientTask(fields);
  return {
    event:         eventType,
    webhook_id:    `e2e-wh-${Date.now()}`,
    task_id:       fields.clickupTaskId,
    list_id:       PATIENT_LIST_ID,
    history_items: [],
    _injectedTask: task,
  };
}

// ── HTTP dispatcher ───────────────────────────────────────────────────────────

export interface ClickUpWebhookResponse {
  status: number;
  body: unknown;
}

/**
 * Dispara o webhook ClickUp patient no backend real via Playwright APIRequestContext.
 * Computa o HMAC sobre o body serializado e envia no header X-Signature.
 *
 * @returns status HTTP e body da resposta.
 */
export async function postClickUpPatientWebhook(
  request: APIRequestContext,
  payload: ClickUpWebhookPayload,
  secret: string = CLICKUP_WEBHOOK_SECRET,
): Promise<ClickUpWebhookResponse> {
  const bodyJson = JSON.stringify(payload);
  const signature = signClickUpPayload(bodyJson, secret);

  const res = await request.post(
    `${BACKEND_URL}/api/webhooks/clickup/patient`,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Signature':  signature,
      },
      data: payload,
    },
  );

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { status: res.status(), body };
}
