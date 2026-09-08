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
import { E2E_EMAIL, loginAsStaffOffline, dragKanbanCard } from './helpers/kanban-notes-e2e-helper';


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
          encuadreId: 'enc-incomplete',
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

  await loginAsStaffOffline(page);
}

/**
 * Abre a vaga com a aba de Encuadres já em visão KANBAN.
 *
 * A rota `/admin/vacancies/:id/kanban` que estes testes usavam NÃO EXISTE mais —
 * `App.tsx` tem `vacancies/:id`, `/edit` e `/talentum`, e o catch-all `path="*"`
 * mandava tudo para `/`. Por isso os 13 testes destes dois arquivos falhavam sem
 * relação nenhuma com o código sob teste: navegavam para uma URL removida.
 * O Kanban passou a viver DENTRO da página de detalhe da vaga, e a visão escolhida
 * é lembrada em localStorage — mesma técnica de kanban-card-blocked-notes-button.
 */
async function gotoVacancyKanban(page: Page, vacancyId: string): Promise<void> {
  await page.addInitScript(
    ([key]) => window.localStorage.setItem(key, 'kanban'),
    [`vacancy-funnel-view-${vacancyId}`],
  );
  await page.goto(`/admin/vacancies/${vacancyId}`);
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

    await gotoVacancyKanban(page, MOCK_VACANCY_ID);
    await expect(page.locator('[data-testid="kanban-card-enc-incomplete"]')).toBeVisible({
      timeout: 15000,
    });

    // Drag do card pra coluna CONFIRMED (droppable)
    await dragKanbanCard(page, 'enc-incomplete', 'INVITED');

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

    await gotoVacancyKanban(page, MOCK_VACANCY_ID);
    await expect(page.locator('[data-testid="kanban-card-enc-incomplete"]')).toBeVisible({
      timeout: 15000,
    });

    await dragKanbanCard(page, 'enc-incomplete', 'INVITED');

    const banner = page.locator('[data-testid="kanban-move-error"]');
    await expect(banner).toBeVisible({ timeout: 10000 });

    // Clica em "Cerrar" — banner desaparece
    await banner.getByRole('button', { name: /cerrar|fechar/i }).click();
    await expect(banner).not.toBeVisible();
  });
});
