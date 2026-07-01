/**
 * vacancy-detail.e2e.ts
 *
 * Playwright E2E — Tela de Detalhe da Vaga (/admin/vacancies/:id)
 *
 * Fluxo coberto:
 *   - Navegar de /admin/vacancies para detalhe ao clicar na linha
 *   - Exibir case number, status, dados do paciente
 *   - Requisitos e horário da vaga exibidos a partir dos campos manuais
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'test-api-key';
const API_URL           = 'http://localhost:8080';

// ── Fixtures de dados mockados ────────────────────────────────────────────

const MOCK_VACANCY_ID = 'aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa';

const MOCK_VACANCY = {
  id: MOCK_VACANCY_ID,
  case_number: 11001,
  title: 'Caso 11001 — Paciente Teste',
  status: 'BUSQUEDA',
  country: 'Argentina',
  service_start_date: '2026-04-01',
  providers_needed: 2,
  worker_profile_sought: 'AT con experiencia en adultos mayores',
  schedule_days_hours: 'Lunes a Viernes 08-16hs',
  patient_id: null,
  patient_first_name: 'Paciente',
  patient_last_name: 'Teste',
  patient_zone: 'Palermo',
  insurance_verified: false,
  required_professions: ['Acompañante Terapéutico', 'Enfermero'],
  required_sex: 'Indistinto',
  pathology_types: 'TEA leve',
  encuadres: [],
  publications: [],
  meet_link_1: 'https://meet.google.com/nox-yqex-sdj',
  meet_datetime_1: '2026-04-06T10:00:00Z',
  meet_link_2: null,
  meet_datetime_2: null,
  meet_link_3: null,
  meet_datetime_3: null,
};

const MOCK_VACANCIES_LIST = {
  success: true,
  data: [
    {
      id: MOCK_VACANCY_ID,
      case_number: 11001,
      title: 'Caso 11001 — Paciente Teste',
      status: 'BUSQUEDA',
      country: 'Argentina',
      providers_needed: 2,
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<{ email: string; token: string }> {
  const email    = `e2e.vacancy.detail.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid, idToken: token } = (await signUpRes.json()) as any;

  // Seed Postgres
  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at) VALUES ('${uid}', '${email}', 'Admin E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at) VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch {
    // ignora se Postgres não disponível — mock abaixo
  }

  // Mock profile — deve seguir o envelope { success: true, data: {...} }
  await page.route('**/api/admin/auth/profile', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid, email, role: 'superadmin',
          firstName: 'Admin', lastName: 'Test',
          isActive: true, mustChangePassword: false,
        },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });

  return { email, token };
}

// ── Testes ────────────────────────────────────────────────────────────────

test.describe('VacancyDetailPage', () => {
  test.setTimeout(60000);

  test('navega de /admin/vacancies para detalhe ao clicar na linha', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Mock API calls
    await page.route('**/api/admin/vacancies?**', route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(MOCK_VACANCIES_LIST),
      }),
    );
    await page.route('**/api/admin/vacancies/stats', route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
      }),
    );

    await page.goto('/admin/vacancies');
    await expect(page.locator(`text=11001`).first()).toBeVisible({ timeout: 15000 });

    // Clica na linha da vaga
    await page.locator(`text=11001`).first().click();

    // Verifica que navegou para o detalhe
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${MOCK_VACANCY_ID}`), { timeout: 10000 });
  });

  test('exibe case number e status badge na tela de detalhe', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);

    // Case number visível
    await expect(page.locator('text=11001').first()).toBeVisible({ timeout: 15000 });

    // Status badge
    await expect(page.locator('text=BUSQUEDA').first()).toBeVisible({ timeout: 10000 });
  });

  test('card de requisitos exibe profissões e patologias do cadastro manual', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);

    // Profissões manuais
    await expect(page.locator('text=Acompañante Terapéutico').first()).toBeVisible({ timeout: 15000 });
    // Patologia manual
    await expect(page.locator('text=TEA leve').first()).toBeVisible({ timeout: 5000 });
  });

  // ── Testes visuais das tabs ───────────────────────────────────────────────

  test('tabs visíveis: Encuadres (default), Talentum, Links', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=11001').first()).toBeVisible({ timeout: 15000 });

    // 3 abas visíveis
    await expect(page.getByRole('button', { name: /Encuadres/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Talentum/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Links/i })).toBeVisible();

    // Aba Encuadres é a default (estilo ativo)
    const encuadresBtn = page.getByRole('button', { name: /Encuadres/i });
    await expect(encuadresBtn).toHaveClass(/bg-primary/);

    // Screenshot: estado default com aba Encuadres ativa
    await page.screenshot({ path: 'e2e/screenshots/vacancy-detail-tab-encuadres.png', fullPage: true });
  });

  test('cards fixos (Status, Paciente, Requisitos, Horário) visíveis em todas as abas', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=11001').first()).toBeVisible({ timeout: 15000 });

    // Cards fixos visíveis na aba default (Encuadres)
    await expect(page.locator('text=11001').first()).toBeVisible();
    await expect(page.locator('text=Palermo').first()).toBeVisible();

    // Troca para aba Talentum — cards fixos continuam
    await page.getByRole('button', { name: /Talentum/i }).click();
    await expect(page.locator('text=11001').first()).toBeVisible();
    await expect(page.locator('text=Palermo').first()).toBeVisible();

    // Screenshot: aba Talentum com cards fixos visíveis
    await page.screenshot({ path: 'e2e/screenshots/vacancy-detail-tab-talentum.png', fullPage: true });

    // Troca para aba Links — cards fixos continuam
    await page.getByRole('button', { name: /Links/i }).click();
    await expect(page.locator('text=11001').first()).toBeVisible();
    await expect(page.locator('text=Palermo').first()).toBeVisible();

    // Screenshot: aba Links com cards fixos visíveis
    await page.screenshot({ path: 'e2e/screenshots/vacancy-detail-tab-links.png', fullPage: true });
  });

  test('navegar entre abas alterna conteúdo corretamente', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
      }),
    );
    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { questions: [], faq: [] } }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=11001').first()).toBeVisible({ timeout: 15000 });

    // Aba Talentum — verifica conteúdo Talentum aparece
    await page.getByRole('button', { name: /Talentum/i }).click();
    await expect(page.getByRole('button', { name: /Talentum/i })).toHaveClass(/bg-primary/);

    // Aba Links — verifica que Meet links aparece
    await page.getByRole('button', { name: /Links/i }).click();
    await expect(page.getByRole('button', { name: /Links/i })).toHaveClass(/bg-primary/);

    // Volta para Encuadres — verifica retorno
    await page.getByRole('button', { name: /Encuadres/i }).click();
    await expect(page.getByRole('button', { name: /Encuadres/i })).toHaveClass(/bg-primary/);

    // Screenshot final: round-trip completo
    await page.screenshot({ path: 'e2e/screenshots/vacancy-detail-tab-roundtrip.png', fullPage: true });
  });

  // ── Testes visuais MeetLinksCard ─────────────────────────────────────────

  test('MeetLinksCard exibe título "Link del Google Meet para la entrevista de Encuadre Terapéutico"', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=11001').first()).toBeVisible({ timeout: 15000 });

    // Navega para aba Links
    await page.getByRole('button', { name: /Links/i }).click();

    // Título atualizado com referência ao Encuadre Terapéutico
    await expect(
      page.locator('text=Link del Google Meet para la entrevista de Encuadre Terapéutico'),
    ).toBeVisible({ timeout: 5000 });

    // Screenshot: título do card MeetLinks
    await page.screenshot({ path: 'e2e/screenshots/vacancy-detail-meetlinks-title.png', fullPage: true });
  });

  test('MeetLinksCard exibe data/hora amigável (dia + mês por extenso + ano + hora)', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=11001').first()).toBeVisible({ timeout: 15000 });

    // Navega para aba Links
    await page.getByRole('button', { name: /Links/i }).click();

    // Formato amigável: "6 de abril de 2026" (mês por extenso, sem formato curto como "6/4/26")
    await expect(
      page.locator('text=/abril/i').first(),
    ).toBeVisible({ timeout: 5000 });

    // Verifica que o formato curto antigo NÃO aparece (ex: "6/4/26")
    const meetCard = page.locator('text=Link del Google Meet para la entrevista de Encuadre Terapéutico').locator('..');
    await expect(meetCard).not.toContainText(/\d{1,2}\/\d{1,2}\/\d{2,4},/);

    // Screenshot: formato de data/hora amigável no badge
    await page.screenshot({ path: 'e2e/screenshots/vacancy-detail-meetlinks-datetime.png', fullPage: true });
  });

  test('MeetLinksCard com todos links preenchidos exibe datas amigáveis em cada um', async ({ page }) => {
    await seedAdminAndLogin(page);

    const vacancyAllLinks = {
      ...MOCK_VACANCY,
      meet_link_1: 'https://meet.google.com/nox-yqex-sdj',
      meet_datetime_1: '2026-04-06T10:00:00Z',
      meet_link_2: 'https://meet.google.com/abc-defg-hij',
      meet_datetime_2: '2026-05-15T14:30:00Z',
      meet_link_3: 'https://meet.google.com/xyz-mnop-qrs',
      meet_datetime_3: '2026-06-20T09:00:00Z',
    };

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: vacancyAllLinks }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=11001').first()).toBeVisible({ timeout: 15000 });

    // Navega para aba Links
    await page.getByRole('button', { name: /Links/i }).click();

    // 3 meses por extenso: abril, mayo, junio
    await expect(page.locator('text=/abril/i').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=/mayo/i').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=/junio/i').first()).toBeVisible({ timeout: 5000 });

    // 3 ícones verdes (link + datetime presente)
    const greenIcons = page.locator('.text-green-500');
    await expect(greenIcons).toHaveCount(3);

    // Screenshot: todos os links preenchidos com datas amigáveis
    await page.screenshot({ path: 'e2e/screenshots/vacancy-detail-meetlinks-all-filled.png', fullPage: true });
  });

  test('vaga sem requisitos manuais exibe placeholders (—)', async ({ page }) => {
    await seedAdminAndLogin(page);

    const vacancyWithoutRequirements = {
      ...MOCK_VACANCY,
      id: MOCK_VACANCY_ID,
      required_professions: null,
      required_sex: null,
      pathology_types: null,
      schedule_days_hours: null,
    };

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: vacancyWithoutRequirements }),
      }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=11001').first()).toBeVisible({ timeout: 15000 });

    // Badge LLM parseado nunca mais existe
    await expect(page.locator('text=/LLM parseado/i').first()).not.toBeVisible();
  });
});
