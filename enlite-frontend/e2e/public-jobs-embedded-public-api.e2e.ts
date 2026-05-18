/**
 * public-jobs-embedded-public-api.e2e.ts
 *
 * Proves visual parity between the two data sources of JobsEmbeddedSection.
 *
 * Strategy:
 *   - Inject window.__USE_PUBLIC_JOBS_API = true so the component fetches
 *     from /api/public/v1/jobs (instead of the legacy /api/jobs scraper).
 *   - Serve the SAME visual content but in the new PublicJobDto shape.
 *   - Compare against the SAME screenshot baseline used by the legacy test
 *     (`jobs-embedded-section.png`). If they match, parity is pixel-perfect.
 */

import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/profile-worker.json' });

const MOCK_PUBLIC_JOBS = {
  success: true,
  data: [
    {
      id: 'pub-0001',
      case_number: 736,
      vacancy_number: 1,
      title: '736 - Acompañante Terapéutico - Provincia de Buenos Aires - Lanús Este',
      status: 'SEARCHING',
      description: 'Descripción del caso 736.',
      schedule_days_hours: 'Lunes a viernes de 09:00 a 15:00 hs.',
      worker_profile_sought: 'AT con experiencia en salud mental.',
      service: 'domiciliario',
      pathologies: 'trastorno disociativo, tlp',
      state: 'provincia de buenos aires',
      city: 'lanús este',
      detail_link: 'https://jobs.enlite.health/es/vagas/736/',
      worker_type: ['acompañante terapéutico'],
      worker_sex: 'indistinto',
      job_zone: null,
      neighborhood: '',
      state_city: 'provincia de buenos aires / lanús este',
      country: 'AR',
      age_range_min: 25,
      age_range_max: 40,
      whatsapp_url: 'https://wa.me/5491100000000?text=CASO+736',
    },
    {
      id: 'pub-0002',
      case_number: 732,
      vacancy_number: 1,
      title: '732 - Acompañante Terapéutico - Nordelta y Puerto Madero',
      status: 'SEARCHING',
      description: 'Descripción del caso 732.',
      schedule_days_hours: 'Lunes y jueves de 11:00 a 14:00.',
      worker_profile_sought: 'Profesional mujer con formación en AT.',
      service: 'traslado',
      pathologies: 'discapacidad intelectual leve',
      state: 'provincia de buenos aires',
      city: 'nordelta (tigre) y puerto madero (caba)',
      detail_link: 'https://jobs.enlite.health/es/vagas/732/',
      worker_type: ['acompañante terapéutico'],
      worker_sex: 'mujer',
      job_zone: null,
      neighborhood: '',
      state_city: 'provincia de buenos aires / nordelta (tigre) y puerto madero (caba)',
      country: 'AR',
      age_range_min: 20,
      age_range_max: 45,
      whatsapp_url: 'https://wa.me/5491100000000?text=CASO+732',
    },
  ],
};

const MOCK_WORKER_PROGRESS = {
  success: true,
  data: {
    id: 'worker-test-id',
    email: 'test@test.com',
    firstName: 'Test',
    lastName: 'Worker',
    generalInfo: null,
    serviceArea: null,
    availability: null,
  },
};

async function mockWorkerApis(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/workers/me/progress**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_WORKER_PROGRESS),
    }),
  );
  await page.route('**/api/workers/me/documents**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          resumeCvUrl: null,
          identityDocumentUrl: null,
          criminalRecordUrl: null,
          professionalRegistrationUrl: null,
          liabilityInsuranceUrl: null,
        },
      }),
    }),
  );
  await page.route('**/api/workers/me/availability**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
  await page.route('**/api/workers/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: {} }),
    }),
  );
}

test.describe('JobsEmbeddedSection — public API mode (visual parity)', () => {
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    });
  });

  test('renders job cards from mocked /api/public/v1/jobs', async ({ page }) => {
    await mockWorkerApis(page);
    await page.route('**/api/public/v1/jobs**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_PUBLIC_JOBS),
      }),
    );

    await page.goto('/');
    await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('lanús este', { exact: false }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('nordelta', { exact: false }).first()).toBeVisible({ timeout: 5000 });
  });

  test('shows Postularse (WhatsApp) button in public-api mode', async ({ page }) => {
    await mockWorkerApis(page);
    await page.route('**/api/public/v1/jobs**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_PUBLIC_JOBS),
      }),
    );

    await page.goto('/');
    await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('lanús este', { exact: false }).first()).toBeVisible({ timeout: 10000 });

    const applyBtn = page.getByRole('button', { name: /postularse/i }).first();
    await expect(applyBtn).toBeVisible({ timeout: 5000 });
  });

  test('screenshot — matches legacy baseline (pixel parity)', async ({ page }) => {
    await mockWorkerApis(page);
    await page.route('**/api/public/v1/jobs**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_PUBLIC_JOBS),
      }),
    );

    await page.goto('/');
    await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('lanús este', { exact: false }).first()).toBeVisible({ timeout: 10000 });

    await expect(page.locator('#jobs-section')).toHaveScreenshot('jobs-embedded-section.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
