/**
 * patient-clickup-sync-visual.helpers.ts
 *
 * Helpers co-locados com patient-clickup-sync-visual.integration.e2e.ts.
 * Extraídos para manter o arquivo de teste abaixo de 400 linhas.
 */

import { expect, type Page, type Route, type APIRequestContext } from '@playwright/test';
import {
  buildPatientWebhookPayload,
  postClickUpPatientWebhook,
  CLICKUP_WEBHOOK_SECRET,
  type PatientWebhookFields,
} from '../helpers/clickupWebhookHelper';
import { getPatientByClickUpTaskId } from '../helpers/db-patient-clickup-helper';

// ── Mock admin identity ───────────────────────────────────────────────────────

export const MOCK_ADMIN = {
  uid:   'e2e-clickup-sync-visual',
  email: 'admin.clickup.visual@e2e.test',
  role:  'admin',
};

export const MOCK_TOKEN =
  'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN), 'utf-8').toString('base64');

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN.uid,
      uid: MOCK_ADMIN.uid,
      email: MOCK_ADMIN.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

// ── Auth interceptors ─────────────────────────────────────────────────────────

export async function installInterceptors(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({
          kind:         'identitytoolkit#VerifyPasswordResponse',
          localId:      MOCK_ADMIN.uid,
          email:        MOCK_ADMIN.email,
          idToken:      FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh',
          expiresIn:    '3600',
          registered:   true,
        }),
      });
      return;
    }
    await route.fulfill({
      status:      200,
      contentType: 'application/json',
      body:        JSON.stringify({
        users: [{ localId: MOCK_ADMIN.uid, email: MOCK_ADMIN.email, emailVerified: true }],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status:      200,
      contentType: 'application/json',
      body:        JSON.stringify({
        access_token:  FAKE_ID_TOKEN,
        id_token:      FAKE_ID_TOKEN,
        expires_in:    '3600',
        token_type:    'Bearer',
        refresh_token: 'fake-refresh',
      }),
    });
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/api/admin/auth/profile')) {
      await route.fulfill({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({
          success: true,
          data: {
            id:                 MOCK_ADMIN.uid,
            email:              MOCK_ADMIN.email,
            role:               'superadmin',
            firstName:          'ClickUp',
            lastName:           'Visual',
            isActive:           true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }
    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

export async function loginAsAdmin(page: Page): Promise<void> {
  await installInterceptors(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Webhook + DB poll ─────────────────────────────────────────────────────────

/**
 * Dispara o webhook ClickUp patient e aguarda o patient_id aparecer no DB.
 * O UseCase é síncrono, mas o Docker pode ter latência mínima de rede.
 * Poll: 5 tentativas × 500ms = máx 2.5s de espera após a resposta HTTP.
 *
 * Lança Error se o patient não aparecer ou se o webhook retornar status não-2xx.
 */
export async function triggerWebhookAndWait(
  request: APIRequestContext,
  fields: PatientWebhookFields,
): Promise<string> {
  const payload = buildPatientWebhookPayload(fields, 'taskCreated');
  const { status, body } = await postClickUpPatientWebhook(request, payload, CLICKUP_WEBHOOK_SECRET);

  if (status !== 200 && status !== 201 && status !== 204) {
    throw new Error(
      `Webhook POST falhou: HTTP ${status} — body: ${JSON.stringify(body)}`,
    );
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const row = getPatientByClickUpTaskId(fields.clickupTaskId);
    if (row?.id) return row.id;
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `Patient não encontrado no DB após webhook (clickup_task_id=${fields.clickupTaskId})`,
  );
}

/** Gera um clickup_task_id único para cada spec. */
export function makeTaskId(): string {
  return `E2E-VISUAL-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
