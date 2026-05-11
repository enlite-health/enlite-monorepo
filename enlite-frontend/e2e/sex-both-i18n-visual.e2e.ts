/**
 * Visual proof that `required_sex='BOTH'` is rendered as "Indistinto",
 * never as the raw literal "BOTH", in both es and pt-BR.
 *
 * Uses the public vacancy route (`/vacantes/:id`), so it does not require
 * Firebase Emulator or Postgres. Screenshots saved to
 * `e2e/screenshots/sex-both-{lang}.png` for manual inspection.
 */
import { test, expect } from '@playwright/test';

const VACANCY_ID = 'aaaaaaaa-9999-9999-9999-aaaaaaaaaaaa';

const MOCK_VACANCY = {
  id: VACANCY_ID,
  case_number: 9999,
  title: 'Caso 9999 — Visual Proof',
  status: 'BUSQUEDA',
  country: 'Argentina',
  service_start_date: null,
  providers_needed: 1,
  worker_profile_sought: null,
  schedule_days_hours: null,
  patient_id: null,
  patient_first_name: 'Paciente',
  patient_last_name: 'Teste',
  patient_zone: 'Palermo',
  patient_city: 'Buenos Aires',
  patient_neighborhood: 'Palermo',
  insurance_verified: false,
  required_professions: ['Acompañante Terapéutico'],
  required_sex: 'BOTH',
  pathology_types: null,
  encuadres: [],
  publications: [],
  talentum_description: null,
  age_range_min: null,
  age_range_max: null,
  worker_attributes: null,
  service_type: null,
  schedule: null,
  meet_link_1: null,
  meet_datetime_1: null,
  meet_link_2: null,
  meet_datetime_2: null,
  meet_link_3: null,
  meet_datetime_3: null,
};

async function mockPublicVacancy(page: import('@playwright/test').Page) {
  await page.route('**/api/vacancies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
    }),
  );
}

test.describe('sex BOTH renders as Indistinto (no raw leak)', () => {
  test('es-AR: PublicVacancyPage shows Indistinto, never BOTH', async ({
    page,
  }) => {
    await mockPublicVacancy(page);
    await page.goto(`/vacantes/${VACANCY_ID}?lng=es`);

    await expect(
      page.locator('text=Disponible para:').first(),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Indistinto').first()).toBeVisible();
    await expect(page.locator('text=BOTH')).toHaveCount(0);

    await page.screenshot({
      path: 'e2e/screenshots/sex-both-es.png',
      fullPage: true,
    });
  });

  test('pt-BR: PublicVacancyPage shows Indistinto, never BOTH', async ({
    page,
  }) => {
    await mockPublicVacancy(page);
    await page.goto(`/vacantes/${VACANCY_ID}?lng=pt-BR`);

    await expect(
      page.locator('text=Disponível para:').first(),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Indistinto').first()).toBeVisible();
    await expect(page.locator('text=BOTH')).toHaveCount(0);

    await page.screenshot({
      path: 'e2e/screenshots/sex-both-pt-br.png',
      fullPage: true,
    });
  });
});
