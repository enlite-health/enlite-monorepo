/* eslint-disable no-console */

import * as crypto from 'crypto';
import {
  CLICKUP_API_BASE,
  PATIENT_LIST_ID,
  type ClickUpWebhookPayload,
  type ClickUpTaskPartial,
} from './types';

// ── HMAC ──────────────────────────────────────────────────────────────────────

export function signPayload(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// ── Payload builder ───────────────────────────────────────────────────────────

export function buildPayload(
  taskId: string,
  opts?: { listId?: string },
): { payload: ClickUpWebhookPayload; rawBody: string } {
  const payload: ClickUpWebhookPayload = {
    event:         'taskUpdated',
    webhook_id:    `smoke-test-${Date.now()}`,
    task_id:       taskId,
    list_id:       opts?.listId ?? PATIENT_LIST_ID,
    history_items: [],
  };
  const rawBody = JSON.stringify(payload);
  return { payload, rawBody };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

export async function postWebhook(
  endpoint: string,
  payload: ClickUpWebhookPayload,
  signature: string,
): Promise<{ status: number; body: unknown }> {
  const rawBody = JSON.stringify(payload);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature':  signature,
    },
    body: rawBody,
  });

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { status: res.status, body };
}

export async function fetchClickUpTask(
  taskId: string,
  token: string,
): Promise<ClickUpTaskPartial> {
  const res = await fetch(`${CLICKUP_API_BASE}/task/${taskId}`, {
    headers: { Authorization: token },
  });
  if (!res.ok) {
    throw new Error(`ClickUp GET /task/${taskId} → HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ClickUpTaskPartial;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function timer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}
