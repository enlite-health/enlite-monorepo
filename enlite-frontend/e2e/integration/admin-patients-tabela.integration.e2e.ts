/**
 * admin-patients-tabela.integration.e2e.ts @integration
 *
 * ⚠️ POR QUE ESTE ARQUIVO EXISTE, e não mais um teste no `admin-patients.e2e.ts`:
 * aquele arquivo NÃO RODA NO CI. Medido em 03/09/2026 — o CI só executa
 * `playwright test --project=integration` (que casa apenas
 * `**\/integration\/**\/*.integration.e2e.ts`) e, com o config mockado, três
 * specs de plantillas nomeadas uma a uma. Os projetos `chromium`/`firefox`/
 * `webkit`, onde vivem os 12 testes do `admin-patients.e2e.ts`, não são
 * invocados por passo nenhum do workflow — e o runner só instala o Chromium.
 * Guarda que não roda é instrumento morto: ela dá a sensação de proteção sem
 * proteger. Este arquivo põe as garantias da tabela no lugar que o CI executa.
 *
 * O que ele afirma:
 *   1. a coluna "Servicio" mostra o ALIAS, nunca o ENUM (AT, CAREGIVER…);
 *   2. a data do registro aparece na linha, na mesma célula do nome;
 *   3. a tabela CABE no container — o Estado não fica cortado.
 *
 * Auth e API: mesmo padrão de interceptação dos vizinhos desta pasta
 * (admin-vacancies-filters), então não depende de backend nem de emulador.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

const MOCK_ADMIN_USER = {
  uid: 'e2e-pac-tabela',
  email: 'admin.pac-tabela@e2e.test',
};

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN_USER.uid,
      uid: MOCK_ADMIN_USER.uid,
      email: MOCK_ADMIN_USER.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

/**
 * Os 4 casos que importam para a tabela: serviço simples, serviço COMPOSTO
 * (o alias mais longo que existe), paciente sem nome (linha do responsável,
 * D249) e nome longo (que não pode alargar a tabela).
 */
const MOCK_PATIENTS = [
  { id: 'pt-1', firstName: 'Francisco', lastName: 'Alomon', responsibleName: null, documentType: 'DNI', documentNumber: '50076035', caseNumber: 12, dependencyLevel: 'SEVERE', clinicalSpecialty: 'GERIATRIC', serviceType: ['AT'], needsAttention: false, attentionReasons: [], createdAt: '2026-04-23T10:00:00Z' },
  { id: 'pt-2', firstName: '', lastName: '', responsibleName: 'Marta Gómez', documentType: null, documentNumber: null, caseNumber: null, dependencyLevel: null, clinicalSpecialty: 'ASD', serviceType: ['AT', 'CAREGIVER'], needsAttention: true, attentionReasons: ['MISSING_INFO'], createdAt: '2026-04-22T08:00:00Z' },
  { id: 'pt-3', firstName: 'María Guadalupe', lastName: 'Rodríguez de la Fuente', responsibleName: null, documentType: 'DNI', documentNumber: '31998877', caseNumber: 41, dependencyLevel: 'MODERATE', clinicalSpecialty: 'NEUROLOGICAL', serviceType: ['NURSE'], needsAttention: false, attentionReasons: [], createdAt: '2026-08-29T13:45:00Z' },
  { id: 'pt-4', firstName: 'Julián', lastName: 'Castro', responsibleName: null, documentType: 'DNI', documentNumber: '28114455', caseNumber: 5, dependencyLevel: 'MILD', clinicalSpecialty: 'PSYCHIATRIC', serviceType: ['PSYCHOLOGIST'], needsAttention: false, attentionReasons: [], createdAt: '2026-09-01T09:00:00Z' },
];

async function installInterceptors(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          localId: MOCK_ADMIN_USER.uid,
          email: MOCK_ADMIN_USER.email,
          idToken: FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh-token',
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
        users: [{ localId: MOCK_ADMIN_USER.uid, email: MOCK_ADMIN_USER.email, emailVerified: true }],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
        id_token: FAKE_ID_TOKEN,
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
            id: MOCK_ADMIN_USER.uid,
            email: MOCK_ADMIN_USER.email,
            role: 'superadmin',
            firstName: 'Tabela',
            lastName: 'Tester',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    if (url.includes('/api/admin/patients/stats')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { total: 4, complete: 3, needsAttention: 1, createdToday: 0, createdYesterday: 0, createdLast7Days: 0 },
        }),
      });
      return;
    }

    if (/\/api\/admin\/patients(\?|$)/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENTS, total: MOCK_PATIENTS.length, limit: 20, offset: 0 }),
      });
      return;
    }

    await route.continue();
  });
}

async function abrirListaDePacientes(page: Page): Promise<void> {
  await installInterceptors(page);
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'es');
  });
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
  await page.goto('/admin/patients');
  await expect(page.locator('text=Alomon, Francisco').first()).toBeVisible({ timeout: 20_000 });
}

test.describe('AdminPatientsPage — a tabela @integration', () => {
  test.setTimeout(90_000);

  test('coluna Servicio mostra o ALIAS, nunca o ENUM', async ({ page }) => {
    await abrirListaDePacientes(page);

    await expect(page.getByText('Acompañante Terapéutico', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Enfermería', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Psicólogo', { exact: true }).first()).toBeVisible();

    // O ENUM cru é o sintoma do bug: não pode existir como texto de célula.
    for (const enumCru of ['AT', 'CAREGIVER', 'NURSE', 'PSYCHOLOGIST', 'KINESIOLOGIST']) {
      await expect(page.getByText(enumCru, { exact: true })).toHaveCount(0);
    }

    // O composto vira alias nos DOIS lados; com o clamp o texto fica no title.
    const composto = page.locator('[title="Acompañante Terapéutico + Cuidador"]');
    await expect(composto).toHaveCount(1);
  });

  test('a data do registro aparece na MESMA célula do nome, sem coluna nova', async ({ page }) => {
    await abrirListaDePacientes(page);

    const celulaDoNome = page.getByTestId('patient-row-pt-1-name').locator('xpath=ancestor::td[1]');
    await expect(celulaDoNome).toContainText('23/04/2026');
    await expect(page.locator('thead th')).toHaveCount(8);

    // Paciente sem nome (D249): traço + responsável + data convivem.
    const celulaSemNome = page.getByTestId('patient-row-pt-2-name').locator('xpath=ancestor::td[1]');
    await expect(celulaSemNome).toContainText('Marta Gómez');
    await expect(celulaSemNome).toContainText('22/04/2026');
  });

  test('a tabela CABE no container — a coluna Estado não fica cortada', async ({ page }) => {
    await abrirListaDePacientes(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    // O layout precisa assentar: medir cedo demais lê larguras de antes da
    // fonte carregar, e foi exatamente assim que uma medição anterior deu
    // "estouro zero" numa tela que estava visivelmente cortada.
    await expect(page.locator('thead th').last()).toBeVisible();
    await page.waitForFunction(() => {
      const t = document.querySelector('table');
      return !!t && t.scrollWidth > 0;
    });

    const medida = await page.locator('table').first().evaluate((el) => {
      const wrapper = el.parentElement as HTMLElement;
      const badge = el.querySelector('tbody tr td:last-child span') as HTMLElement;
      return {
        estouro: wrapper.scrollWidth - wrapper.clientWidth,
        badgeDireita: Math.round(badge.getBoundingClientRect().right),
        wrapperDireita: Math.round(wrapper.getBoundingClientRect().right),
      };
    });

    expect(medida.estouro).toBe(0);
    expect(medida.badgeDireita).toBeLessThanOrEqual(medida.wrapperDireita);
  });
});
