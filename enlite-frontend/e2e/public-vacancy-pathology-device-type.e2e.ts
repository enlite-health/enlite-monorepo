/**
 * public-vacancy-pathology-device-type.e2e.ts
 *
 * Visual proof: PublicVacancyPage renders the public vacancy detail fields
 * — Tipo de dispositivo — and the "Franja etaria" row that used to
 * disappear entirely when both age bounds were null.
 *
 * 🔧 F1.5-CORREÇÃO C5 (D261, spec 016): the "Patología" (free-text clinical
 * field) assertions and mock field were REMOVED here. The backend already
 * dropped that field from the public payload on 2026-08-25
 * (`PublicVacancyController.ts`), and `PublicVacancyPage.tsx` still
 * rendered it — dead code that would have become a live leak of clinical
 * data the moment F2/F3 of spec 016 added `diagnoses[]` to the response
 * (REQ-21 requires the CID-11 code/diagnosis NEVER appear on the public
 * ficha). The render was removed from the page in this same correction.
 *
 * Mocks `**\/api/vacancies/**` with a realistic payload (case 797-2208):
 * required_sex BOTH, age_range_min/max null, service_type ['AT'],
 * patient_zone, worker_attributes and schedule present,
 * talentum_description.
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

test.describe('PublicVacancyPage — Tipo de dispositivo e Franja etaria sempre visível', () => {
  test('es-AR: exibe os campos de detalhe da vaga, e NUNCA a seção de patología (C5/D261)', async ({
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

    // 7. C5/D261 (REQ-21): a seção de patología NUNCA aparece — o campo saiu do payload e o
    //    render morto saiu da página nesta correção.
    await expect(page.locator('text=Hipótesis Diagnóstica - CIE:')).toHaveCount(0);

    // 8. Tipo de dispositivo (service_type) — traduzido, nunca "AT" cru como enum solto
    await expect(page.locator('text=Tipo de servicio:').first()).toBeVisible();
    await expect(page.locator('text=Acompañante Terapéutico').first()).toBeVisible();

    await expect(page).toHaveScreenshot('public-vacancy-pathology-device-type-es.png', {
      fullPage: true,
    });
  });

  test('pt-BR: exibe Tipo de dispositivo traduzido, e NUNCA a seção de patología (C5/D261)', async ({ page }) => {
    await mockPublicVacancy(page);
    await page.goto(`/vacantes/${VACANCY_ID}?lng=pt-BR`);

    await expect(page.locator('text=Disponível para:').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Hipótese Diagnóstica - CID:')).toHaveCount(0);
    await expect(page.locator('text=Tipo de serviço:').first()).toBeVisible();
    await expect(page.locator('text=Acompanhante Terapêutico').first()).toBeVisible();
    await expect(page.locator('text=Faixa Etária:').first()).toBeVisible();
    await expect(page.locator('text=Indistinta').first()).toBeVisible();

    await expect(page).toHaveScreenshot('public-vacancy-pathology-device-type-pt-br.png', {
      fullPage: true,
    });
  });
});
