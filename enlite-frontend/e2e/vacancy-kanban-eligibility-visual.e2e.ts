/**
 * vacancy-kanban-eligibility-visual.e2e.ts
 *
 * Playwright E2E — Banner de bloqueio por elegibilidade no Kanban admin.
 *
 * Cobre: quando o backend retorna 403 com code='WORKER_NOT_ELIGIBLE' (worker
 * com cadastro/documentos incompletos), o frontend deve mostrar um banner
 * amber explicativo via i18n ao invés de erro genérico.
 */

import { test, expect, Page } from '@playwright/test';
import { E2E_EMAIL, loginAsAdmin } from './helpers/kanban-notes-e2e-helper';


const MOCK_VACANCY_ID = 'eligvis-0001-0001-0001-000000000001';

const MOCK_VACANCY = {
  id: MOCK_VACANCY_ID,
  case_number: 901,
  vacancy_number: 1,
  title: 'CASO 901-1',
  status: 'BUSQUEDA',
  country: 'Argentina',
  patient_first_name: 'Paciente',
  patient_last_name: 'Eligibility',
  encuadres: [],
  publications: [],
};

const MOCK_FUNNEL = {
  success: true,
  data: {
    stages: {
      INVITED: [],
      INICIADO: [],
      PRE_SCREENING: [],
      IN_PROGRESS: [
        {
          id: 'enc-incomplete',
          workerId: 'worker-incomplete-001',
          workerName: 'Worker Incompleto',
          workerPhone: '5491133445566',
          occupation: 'AT',
          interviewDate: null,
          interviewTime: null,
          meetLink: null,
          resultado: null,
          attended: null,
          rejectionReasonCategory: null,
          rejectionReason: null,
          matchScore: null,
          talentumStatus: null,
          workZone: 'Belgrano',
          redireccionamiento: null,
          acquisitionChannel: null,
        },
      ],
      COMPLETED: [],
      CONFIRMED: [],
      SELECTED: [],
      REJECTED: [],
    },
    totalEncuadres: 1,
  },
};

async function seedAdminAndLogin(page: Page): Promise<void> {
  // Login com a conta STAFF REAL (enlite-prd), não com usuário do emulador.
  //
  // Por que mudou: o usuário criado por `accounts:signUp` no emulador não carrega
  // custom claim nenhuma. Mockar `/auth/profile` com role=superadmin não basta —
  // o app decide staff × prestador pelo TOKEN, então a sessão caía na navegação de
  // prestador ("Home/Perfil") e o Kanban nunca montava. Os 13 testes destes dois
  // arquivos falhavam por isso, na `main` inclusive.
  //
  // Catch-all admin PRIMEIRO — rotas específicas registradas depois vencem
  // (Playwright: a última rota registrada tem precedência).
  //
  // Sem ele, as chamadas que o spec não mocka (lista de usuários, telemetria)
  // escapam para a API de `VITE_API_WORKER_FUNCTIONS_URL` e morrem em CORS: o
  // backend local só libera a origem `localhost:5173`, e um dev server em
  // qualquer outra porta faz o app cair na home de PRESTADOR — Kanban nunca
  // monta. Com o catch-all o spec fica hermético e roda em qualquer porta.
  await page.route('**/api/admin/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, data: null }),
  }));

  // O perfil segue mockado: dá o papel sem depender do backend.
  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: 'e2e-elig-admin',
          email: E2E_EMAIL,
          role: 'superadmin',
          firstName: 'Admin',
          lastName: 'Elig',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await loginAsAdmin(page);
}

function mockVacancyApis(page: Page) {
  return Promise.all([
    page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
      }),
    ),
    page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/funnel`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_FUNNEL),
      }),
    ),
  ]);
}

test.describe('Kanban — bloqueio por elegibilidade do worker (visual)', () => {
  test.setTimeout(60000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('exibe banner amber quando backend retorna 403 WORKER_NOT_ELIGIBLE', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    // Mock do move retornando 403 com payload do backend
    await page.route('**/api/admin/encuadres/*/move', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'registration_incomplete',
          code: 'WORKER_NOT_ELIGIBLE',
          reason: 'registration_incomplete',
          workerStatus: 'INCOMPLETE_REGISTER',
        }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);
    await expect(page.locator('[data-testid="kanban-card-enc-incomplete"]')).toBeVisible({
      timeout: 15000,
    });

    // Drag do card pra coluna CONFIRMED (droppable)
    const card = page.locator('[data-testid="kanban-card-enc-incomplete"]');
    const target = page.locator('[data-testid="kanban-column-CONFIRMED"]');

    const cardBox = await card.boundingBox();
    const targetBox = await target.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(targetBox).not.toBeNull();

    const startX = cardBox!.x + cardBox!.width / 2;
    const startY = cardBox!.y + cardBox!.height / 2;
    const endX = targetBox!.x + targetBox!.width / 2;
    const endY = targetBox!.y + targetBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Mover além do threshold de 8px do PointerSensor
    await page.mouse.move(startX + 10, startY, { steps: 3 });
    await page.mouse.move(endX, endY, { steps: 15 });
    await page.mouse.up();

    // Banner amber aparece com título e mensagem traduzida
    const banner = page.locator('[data-testid="kanban-move-error"]');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText(/registro incompleto|cadastro incompleto/i);
    await expect(banner).toContainText(/documentos|obligator/i);

    // Screenshot visual do banner
    await expect(banner).toHaveScreenshot('kanban-eligibility-block-banner.png');
  });

  test('dismiss button fecha o banner', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacancyApis(page);

    await page.route('**/api/admin/encuadres/*/move', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'registration_incomplete',
          code: 'WORKER_NOT_ELIGIBLE',
          reason: 'registration_incomplete',
          workerStatus: 'INCOMPLETE_REGISTER',
        }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/kanban`);
    await expect(page.locator('[data-testid="kanban-card-enc-incomplete"]')).toBeVisible({
      timeout: 15000,
    });

    const card = page.locator('[data-testid="kanban-card-enc-incomplete"]');
    const target = page.locator('[data-testid="kanban-column-CONFIRMED"]');

    const cardBox = await card.boundingBox();
    const targetBox = await target.boundingBox();
    const startX = cardBox!.x + cardBox!.width / 2;
    const startY = cardBox!.y + cardBox!.height / 2;
    const endX = targetBox!.x + targetBox!.width / 2;
    const endY = targetBox!.y + targetBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 10, startY, { steps: 3 });
    await page.mouse.move(endX, endY, { steps: 15 });
    await page.mouse.up();

    const banner = page.locator('[data-testid="kanban-move-error"]');
    await expect(banner).toBeVisible({ timeout: 10000 });

    // Clica em "Cerrar" — banner desaparece
    await banner.getByRole('button', { name: /cerrar|fechar/i }).click();
    await expect(banner).not.toBeVisible();
  });
});
