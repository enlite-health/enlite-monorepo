/**
 * public-vacancy-pathology-device-type.e2e.ts
 *
 * Visual proof: PublicVacancyPage renders ALL detail fields the public
 * vacancy card should show — including the two that were missing
 * (Patología / Tipo de dispositivo) and the "Franja etaria" row that used
 * to disappear entirely when both age bounds were null.
 *
 * Mocks `**\/api/vacancies/**` with a realistic payload (case 797-2208):
 * required_sex BOTH, age_range_min/max null, pathologies (free text with
 * line breaks), service_type ['AT'], patient_zone, worker_attributes and
 * schedule present, talentum_description.
 *
 * Pattern follows `sex-both-i18n-visual.e2e.ts` (public route, no auth
 * needed) and uses `toHaveScreenshot()` per enlite-frontend/CLAUDE.md.
 */
import { test, expect } from '@playwright/test';

const VACANCY_ID = 'cccccccc-0797-2208-0797-cccccccccccc';

const MOCK_VACANCY = {
  id: VACANCY_ID,
  case_number: 797,
  vacancy_number: 2208,
  title: 'Acompañante Terapéutico',
  status: 'BUSQUEDA',
  required_professions: ['Acompañante Terapéutico'],
  required_sex: 'BOTH',
  age_range_min: null,
  age_range_max: null,
  worker_attributes:
    'Se busca un/a Acompañante Terapéutico con experiencia en pacientes con trastornos del ánimo y disponibilidad full-time.',
  schedule: {
    lunes: [{ start: '09:00h', end: '13:00h' }],
    martes: [{ start: '09:00h', end: '13:00h' }],
  },
  schedule_days_hours: 'Lun-Mar 09-13h',
  pathologies: 'Trastorno Bipolar,\ncomórbido con TDAH y TEA',
  service_type: ['AT'],
  salary_text: 'A convenir',
  talentum_description:
    'Buscamos un/a Acompañante Terapéutico para acompañar a paciente adulto con diagnóstico psiquiátrico.',
  talentum_whatsapp_url: 'https://wa.me/5491112345678',
  patient_zone: 'Villa Ballester, Buenos Aires',
  country: 'Argentina',
  created_at: '2026-04-01T00:00:00Z',
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

test.describe('PublicVacancyPage — Patología, Tipo de dispositivo e Franja etaria sempre visível', () => {
  test('es-AR: exibe os 8 campos de detalhe da vaga (incluindo os 2 que faltavam)', async ({
    page,
  }) => {
    await mockPublicVacancy(page);
    await page.goto(`/vacantes/${VACANCY_ID}?lng=es`);

    // 1. Sexo (Disponible para: Indistinto — required_sex=BOTH nunca cru)
    await expect(page.locator('text=Disponible para:').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Indistinto').first()).toBeVisible();
    await expect(page.locator('text=/^BOTH$/')).toHaveCount(0);

    // 2. Descripción
    await expect(
      page.locator('text=/Buscamos un\\/a Acompañante Terapéutico/').first(),
    ).toBeVisible();

    // 3. Franja etaria — SEMPRE visível, com fallback "Indistinta" (não some quando null)
    await expect(page.locator('text=Rango Etario:').first()).toBeVisible();
    await expect(page.locator('text=Indistinta').first()).toBeVisible();

    // 4. Ubicación
    await expect(page.locator('text=Villa Ballester, Buenos Aires').first()).toBeVisible();

    // 5. Perfil
    await expect(page.locator('text=/experiencia en pacientes con trastornos/').first()).toBeVisible();

    // 6. Días y horarios
    await expect(page.locator('text=/Días y Horarios/i').first()).toBeVisible();

    // 7. Patología (Hipótesis Diagnóstica) — texto livre, preserva quebra de linha
    await expect(page.locator('text=Hipótesis Diagnóstica - CIE:').first()).toBeVisible();
    await expect(page.locator('text=/Trastorno Bipolar/').first()).toBeVisible();

    // 8. Tipo de dispositivo (service_type) — traduzido, nunca "AT" cru como enum solto
    await expect(page.locator('text=Tipo de servicio:').first()).toBeVisible();
    await expect(page.locator('text=Acompañante Terapéutico').first()).toBeVisible();

    await expect(page).toHaveScreenshot('public-vacancy-pathology-device-type-es.png', {
      fullPage: true,
    });
  });

  test('pt-BR: exibe Patología e Tipo de dispositivo traduzidos', async ({ page }) => {
    await mockPublicVacancy(page);
    await page.goto(`/vacantes/${VACANCY_ID}?lng=pt-BR`);

    await expect(page.locator('text=Disponível para:').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Hipótese Diagnóstica - CID:').first()).toBeVisible();
    await expect(page.locator('text=/Trastorno Bipolar/').first()).toBeVisible();
    await expect(page.locator('text=Tipo de serviço:').first()).toBeVisible();
    await expect(page.locator('text=Acompanhante Terapêutico').first()).toBeVisible();
    await expect(page.locator('text=Faixa Etária:').first()).toBeVisible();
    await expect(page.locator('text=Indistinta').first()).toBeVisible();

    await expect(page).toHaveScreenshot('public-vacancy-pathology-device-type-pt-br.png', {
      fullPage: true,
    });
  });
});
