/**
 * talentumWebhookHelper.ts
 *
 * Helper para disparar payloads do webhook Talentum em testes E2E de integração.
 * Inclui também o helper de autenticação admin (mock token) para reutilização
 * em testes de integração do Kanban.
 *
 * Usa `APIRequestContext` do Playwright (não fetch do browser) para evitar
 * problemas de CORS e Authorization. O backend roda com USE_MOCK_AUTH=true,
 * portanto o endpoint /api/webhooks/talentum/prescreening não requer header
 * de autenticação.
 */

import type { APIRequestContext, Page, Route } from '@playwright/test';
import { expect } from '@playwright/test';

export const BACKEND_URL = 'http://localhost:8080';

// ── Admin mock auth ───────────────────────────────────────────────────────────

export const MOCK_ADMIN = {
  uid: 'e2e-talentum-kanban',
  email: 'admin.talentum.kanban@e2e.test',
  role: 'admin',
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

export async function installKanbanInterceptors(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          localId: MOCK_ADMIN.uid,
          email: MOCK_ADMIN.email,
          idToken: FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh',
          expiresIn: '3600',
          registered: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [{ localId: MOCK_ADMIN.uid, email: MOCK_ADMIN.email, emailVerified: true }],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: FAKE_ID_TOKEN,
        id_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh',
      }),
    });
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/api/admin/auth/profile')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: MOCK_ADMIN.uid,
            email: MOCK_ADMIN.email,
            role: MOCK_ADMIN.role,
            firstName: 'Integration',
            lastName: 'Admin',
            isActive: true,
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

export async function loginAsKanbanAdmin(page: Page): Promise<void> {
  await installKanbanInterceptors(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

/**
 * Garante que a aba Encuadres da página de detalhe da vaga abra em view=kanban
 * via localStorage (a chave que o VacancyFunnelView lê na inicialização).
 */
async function forceKanbanView(page: Page, vacancyId: string): Promise<void> {
  await page.addInitScript(
    ([key]) => {
      window.localStorage.setItem(key, 'kanban');
    },
    [`vacancy-funnel-view-${vacancyId}`],
  );
}

/** Abre o detalhe da vaga forçando view=kanban e aguarda o board ficar visível. */
export async function openKanban(page: Page, vacancyId: string): Promise<void> {
  await forceKanbanView(page, vacancyId);
  await page.goto(`/admin/vacancies/${vacancyId}`);
  await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 15_000 });
}

/**
 * Aguarda que um card com determinado data-testid apareça no kanban com
 * o data-stage correto, recarregando a página para tratar race conditions.
 */
export async function waitForCardInStage(
  page: Page,
  vacancyId: string,
  cardTestId: string,
  expectedStage: string,
): Promise<void> {
  await forceKanbanView(page, vacancyId);
  await expect
    .poll(
      async () => {
        await page.goto(`/admin/vacancies/${vacancyId}`);
        await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 10_000 });
        // DraggableCard wrapper e KanbanCard inner têm o mesmo data-testid;
        // só o inner tem data-stage, então filtramos por ele.
        return page
          .locator(`[data-testid="${cardTestId}"][data-stage]`)
          .first()
          .getAttribute('data-stage')
          .catch(() => null);
      },
      { timeout: 15_000, intervals: [1000, 2000, 4000] },
    )
    .toBe(expectedStage);
}

/**
 * Busca o id da worker_job_application (wja.id = card.id) para um worker+vacancy.
 * Após PR #41, card.id = wja.id — use esta função para obter o id do DraggableCard.
 *
 * ATENÇÃO: o nome "getEncuadreId" é legado. Após PR #41 este helper retorna wja.id,
 * não encuadre.id. Use `getRealEncuadreId` para obter o UUID do encuadre real.
 */
export async function getEncuadreId(
  request: APIRequestContext,
  workerId: string,
  vacancyId: string,
): Promise<string> {
  const res = await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}/funnel`, {
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
  });

  if (res.status() !== 200) return 'unknown';

  const body = (await res.json()) as {
    success: boolean;
    data: { stages: Record<string, Array<{ id: string; encuadreId: string | null; workerId: string | null }>> };
  };

  if (!body.success) return 'unknown';

  for (const items of Object.values(body.data.stages)) {
    const found = items.find((item) => item.workerId === workerId);
    if (found) return found.id;
  }

  return 'unknown';
}

/**
 * Busca o encuadreId REAL (UUID do encuadre) para um worker+vacancy via funnel API.
 * Distinto do wja.id retornado por getEncuadreId. Necessário para validar URLs
 * de PUT /api/admin/encuadres/<encuadreId>/move.
 */
export async function getRealEncuadreId(
  request: APIRequestContext,
  workerId: string,
  vacancyId: string,
): Promise<string> {
  const res = await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}/funnel`, {
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
  });

  if (res.status() !== 200) return 'unknown';

  const body = (await res.json()) as {
    success: boolean;
    data: { stages: Record<string, Array<{ id: string; encuadreId: string | null; workerId: string | null }>> };
  };

  if (!body.success) return 'unknown';

  for (const items of Object.values(body.data.stages)) {
    const found = items.find((item) => item.workerId === workerId);
    if (found) return found.encuadreId ?? 'unknown';
  }

  return 'unknown';
}

export type TalentumSubtype = 'INITIATED' | 'IN_PROGRESS' | 'COMPLETED' | 'ANALYZED';

export interface TalentumWebhookOpts {
  /** ID único do prescreening no Talentum (deve ser estável por cenário). */
  prescreeningId: string;
  /** Nome do prescreening — deve coincidir com o título da vaga para o webhook achar o job_posting. */
  prescreeningName: string;
  /** ID único do perfil do candidato no Talentum. */
  profileId: string;
  /** Email do worker já cadastrado no banco. */
  profileEmail: string;
  /** Phone do worker (com DDI, ex: +54911...). */
  profilePhone: string;
  /** Primeiro nome do worker. */
  profileFirstName: string;
  /** Último nome do worker. */
  profileLastName: string;
  subtype: TalentumSubtype;
  /** Obrigatório quando subtype='ANALYZED'. */
  statusLabel?: 'QUALIFIED' | 'NOT_QUALIFIED' | 'IN_DOUBT' | 'PENDING';
  /** Score do prescreening (0-100). Usado em ANALYZED. */
  score?: number;
}

/** Constrói o payload PRESCREENING_RESPONSE com os campos necessários. */
function buildPayload(opts: TalentumWebhookOpts): Record<string, unknown> {
  const responseBlock: Record<string, unknown> = {
    id: `resp-${opts.prescreeningId}-${opts.subtype}`,
    state: [],
    ...(opts.statusLabel !== undefined ? { statusLabel: opts.statusLabel } : {}),
    ...(opts.score !== undefined ? { score: opts.score } : {}),
  };

  return {
    action: 'PRESCREENING_RESPONSE',
    subtype: opts.subtype,
    data: {
      prescreening: {
        id: opts.prescreeningId,
        name: opts.prescreeningName,
      },
      profile: {
        id: opts.profileId,
        firstName: opts.profileFirstName,
        lastName: opts.profileLastName,
        email: opts.profileEmail,
        phoneNumber: opts.profilePhone,
        registerQuestions: [],
      },
      response: responseBlock,
    },
  };
}

/**
 * Envia um webhook Talentum ao backend real via `request.post()`.
 * Retorna o status HTTP da resposta.
 *
 * @param request - APIRequestContext do Playwright (fixture `request` ou `page.request`)
 * @param opts    - Dados do evento Talentum
 */
export async function sendTalentumWebhook(
  request: APIRequestContext,
  opts: TalentumWebhookOpts,
): Promise<number> {
  const payload = buildPayload(opts);
  const response = await request.post(
    `${BACKEND_URL}/api/webhooks/talentum/prescreening`,
    {
      data: payload,
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return response.status();
}
