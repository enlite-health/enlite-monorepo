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
 *
 * P26a v2 (26/09, cadeia-paciente-vacante-itinerario Fase 2): `loginAsKanbanAdmin` e
 * `installKanbanInterceptors` passaram a DELEGAR para `installAuthInterceptors`/`tokenFor`
 * de `abac-stack-helper.ts` — o helper deixou de ter interceptor próprio. Motivo: o
 * catch-all de rotas "/api/(qualquer coisa)" daqui não cobria `/v1/me/authz`; com ABAC
 * ligado a API recusava (401) e a tela ficava presa em "Carregando...". `MOCK_ADMIN`
 * ganhou `country: 'AR'` (shape `MockUser`), e `loginAsKanbanAdmin` semeia a linha de
 * staff em `users` (mesmo padrão de `seedAdminUser` em `funil-vacante.integration.e2e.ts`,
 * via `runSQL` de `patient-detail-a-helper.ts`) antes de logar.
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { installAuthInterceptors, tokenFor, type MockUser } from './abac-stack-helper';
import { runSQL } from './patient-detail-a-helper';

export const BACKEND_URL = 'http://localhost:8080';

// ── Admin mock auth ───────────────────────────────────────────────────────────

export const MOCK_ADMIN: MockUser = {
  uid: 'e2e-talentum-kanban',
  email: 'admin.talentum.kanban@e2e.test',
  role: 'admin',
  country: 'AR',
};

export const MOCK_TOKEN = tokenFor(MOCK_ADMIN);

/** Garante a linha de staff em `users` — mesmo padrão de `seedAdminUser` em funil-vacante.integration.e2e.ts. */
function seedStaffUser(): void {
  runSQL(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active, account_type, status) ` +
      `VALUES ('${MOCK_ADMIN.uid}', '${MOCK_ADMIN.email}', 'E2E Talentum Kanban', 'admin', true, 'staff', 'ACTIVE') ` +
      `ON CONFLICT (firebase_uid) DO NOTHING`,
  );
}

/** Delega a `installAuthInterceptors` (abac-stack-helper.ts) — cobre **\/api/**, /v1/me/authz e /v1/me/simulation. */
export async function installKanbanInterceptors(page: Page): Promise<void> {
  await installAuthInterceptors(page, MOCK_ADMIN);
}

export async function loginAsKanbanAdmin(page: Page): Promise<void> {
  seedStaffUser();
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
