/**
 * funil-vacante-atalho-itinerario.integration.e2e.ts @integration — spec 041 R4 (DEC-04, Q1).
 *
 * Full-stack, sem mock de dado de negócio (só auth): do detalhe da vacante, o clique humano em
 * "Ver itinerario del paciente" chega à ficha do paciente DONO da vaga já na aba Itinerario
 * (`/admin/patients/:id?tab=itinerary`). O nome do arquivo casa o `--grep` `funil-vacante` do
 * job `frontend-integration` (pr-gate.yml), então roda no CI sem tocar o filtro.
 *
 * Reusa `seedVacancyWithCards([])` (paciente + vaga publicada, sem cards), `seedMockStaff`,
 * `loginAs`, `gotoVacancyDetail`. Nunca `fill()`.
 */
import { test, expect } from '@playwright/test';
import { seedVacancyWithCards } from '../helpers/funnel-move-e2e-helper';
import { gotoVacancyDetail } from '../helpers/compativeis-e2e-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import { loginAs, type MockUser } from '../helpers/abac-stack-helper';

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-funil-atalho-itinerario',
  email: 'staff.funil.atalho.itinerario@e2e.test',
  role: 'admin',
  country: 'AR',
};

test.describe('detalhe da vacante — atalho para o itinerário do paciente (041 R4) @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Funil Atalho Itinerario');
  });

  test.afterAll(() => {
    cleanupMockStaff(MOCK_STAFF);
  });

  test('funil-vacante-atalho-itinerario', async ({ page }) => {
    const seed = seedVacancyWithCards([]);
    try {
      await loginAs(page, MOCK_STAFF);
      await gotoVacancyDetail(page, seed.vacancyId);

      await page.getByRole('button', { name: 'Ver itinerario del paciente' }).click();

      await expect(page, 'chega à ficha do paciente DONO da vaga, com ?tab=itinerary').toHaveURL(
        new RegExp(`/admin/patients/${seed.patientId}\\?tab=itinerary$`),
        { timeout: 15_000 },
      );
      // A aba Itinerario está ativa: ou a agenda (`itinerario-aba`) ou o estado vazio (paciente sem serviços).
      await expect(
        page.getByTestId('itinerario-aba').or(page.getByTestId('itinerario-sem-servicos')),
        'conteúdo da aba Itinerario visível',
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('patient-profile-tabs')).toBeVisible();
    } finally {
      seed.cleanup();
    }
  });
});
