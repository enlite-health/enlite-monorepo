/* eslint-disable no-console */

import { Pool } from 'pg';

// ── Constants ─────────────────────────────────────────────────────────────────

export const PATIENT_LIST_ID         = '901304883903';
export const DEFAULT_TASK_ID         = '86ahbkqb6';
export const CLICKUP_API_BASE        = 'https://api.clickup.com/api/v2';
export const GCLOUD_PROJECT          = 'enlite-prd';
export const GCLOUD_REGION           = 'southamerica-west1';
export const GCLOUD_SERVICE          = 'worker-functions';
export const GCLOUD_SECRET           = 'clickup-webhook-secret';
export const POST_WAIT_MS            = 5_000;
export const LOCAL_ENDPOINT_DEFAULT  = 'http://localhost:8080/api/webhooks/clickup/patient';
export const DEFAULT_DB_URL          = 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
export const TAG                     = '[smoke-clickup-webhook]';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SmokeContext {
  endpoint: string;
  secret: string;
  clickupApiToken: string;
  pool: Pool;
}

export interface SmokeResult {
  test: string;
  pass: boolean;
  message: string;
  durationMs: number;
}

export interface ClickUpWebhookPayload {
  event: string;
  webhook_id: string;
  task_id: string;
  list_id?: string;
  history_items: unknown[];
}

export interface PatientRow {
  updated_at: Date;
}

export interface ClickUpTaskPartial {
  id: string;
  name?: string;
  list?: { id: string };
}

export interface ParsedArgs {
  target: 'local' | 'prod';
  taskId: string;
  help: boolean;
}
