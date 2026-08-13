/**
 * kanban-notes-e2e-helper.ts
 *
 * Setup compartilhado (auth Firebase REAL + mocks base do backend admin) pelos
 * testes de "botão Comentarios" do Kanban:
 *   - kanban-card-notes-button.e2e.ts        (card comum — coluna COMPLETED)
 *   - kanban-card-blocked-notes-button.e2e.ts (card BLOQUEADO — mesma UX)
 *
 * Extraído pra manter os dois arquivos de teste dentro do limite de 400
 * linhas (CLAUDE.md).
 *
 * Ordem de registro de rotas importa no Playwright: a ÚLTIMA rota registrada
 * que casa com a URL vence. Por isso `mockAdminBaseRoutes` registra o
 * catch-all PRIMEIRO — cada teste registra suas rotas específicas de
 * `funnel` e `contact-notes` DEPOIS de chamar esta função, e só então chama
 * `loginAsAdmin`.
 */
import { expect, type Page, type Route } from '@playwright/test';

export const E2E_EMAIL =
  process.env.E2E_ADMIN_EMAIL ?? process.env.E2E_TEST_EMAIL ?? 'gabriel.g.stein@gmail.com';
export const E2E_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? process.env.E2E_TEST_PASSWORD ?? 'Teste@123';

export const VACANCY_ID = 'aaaa1111-2222-3333-4444-555566667777';

export interface ContactNote {
  id: string;
  workerJobApplicationId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminName: string | null;
  createdByAdminEmail: string | null;
  createdAt: string;
  canDelete: boolean;
}

export function ok(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: body }),
  };
}

export function emptyStages(): Record<string, unknown[]> {
  return {
    INVITED: [], BLOQUEADO: [], INICIADO: [], PRE_SCREENING: [],
    IN_PROGRESS: [], COMPLETED: [], CONFIRMED: [], SELECTED: [], REJECTED: [],
  };
}

export const mockVacancy = {
  id: VACANCY_ID,
  case_number: 55501,
  vacancy_number: 1,
  title: 'Caso 55501 — Vacante Comentarios',
  status: 'SEARCHING',
  country: 'Argentina',
  providers_needed: 1,
  worker_profile_sought: 'AT',
  schedule: null,
  schedule_days_hours: null,
  patient_id: 'patient-55501',
  patient_first_name: 'Paciente',
  patient_last_name: 'Comentarios',
  patient_zone: 'Palermo',
  patient_city: 'CABA',
  patient_neighborhood: 'Palermo',
  insurance_verified: true,
  required_professions: ['AT'],
  required_sex: 'F',
  pathology_types: 'TEA',
  encuadres: [],
  publications: [],
  meet_link_1: null,
  meet_datetime_1: null,
  meet_link_2: null,
  meet_datetime_2: null,
  meet_link_3: null,
  meet_datetime_3: null,
};

/**
 * Registra o catch-all admin + mocks genéricos (perfil, detalhe da vaga,
 * funnel-table vazio). NÃO navega — cada teste registra as rotas específicas
 * de `funnel` e `contact-notes` depois disto, e só então chama `loginAsAdmin`.
 */
export async function mockAdminBaseRoutes(page: Page): Promise<void> {
  // Catch-all admin PRIMEIRO — rotas específicas registradas depois têm
  // precedência (Playwright: última rota registrada vence). Evita 401/crash.
  await page.route('**/api/admin/**', (route: Route) => route.fulfill(ok(null)));

  await page.route('**/api/admin/auth/profile', (route: Route) =>
    route.fulfill(ok({
      id: 'e2e-admin',
      email: E2E_EMAIL,
      role: 'superadmin',
      firstName: 'Admin',
      lastName: 'E2E',
      isActive: true,
      mustChangePassword: false,
    })),
  );

  await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, (route: Route) =>
    route.fulfill(ok(mockVacancy)),
  );

  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/funnel-table**`, (route: Route) =>
    route.fulfill(ok({ rows: [], counts: {}, total: 0 })),
  );
}

/** Login REAL no Firebase (sem interceptar identitytoolkit). */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(E2E_EMAIL);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 25_000 });
}
