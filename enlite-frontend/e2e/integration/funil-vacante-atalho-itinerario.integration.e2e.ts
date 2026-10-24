/**
 * funil-vacante-atalho-itinerario.integration.e2e.ts @integration — spec 041 R4 (DEC-04, Q1).
 *
 * Full-stack, sem mock de dado de negócio (só auth): do detalhe da vacante, o clique humano em
 * "Ver itinerario del paciente" chega à ficha do paciente DONO da vaga já na aba Itinerario
 * (`/admin/patients/:id?tab=itinerary`). O nome do arquivo casa o `--grep` `funil-vacante` do
 * job `frontend-integration` (pr-gate.yml), então roda no CI sem tocar o filtro.
 *
 * Reusa `seedLaunchablePatient` + `activateRecruitmentViaApi` (paciente, serviço, vaga) + 2º serviço pela API, `seedMockStaff`,
 * `loginAs`, `gotoVacancyDetail`. Nunca `fill()`.
 */
import { test, expect } from '@playwright/test';
import { seedLaunchablePatient } from '../helpers/lancamento-e2e-helper';
import { activateRecruitmentViaApi, createServiceViaApi } from '../helpers/itinerario-e2e-helper';
import { cleanupItineraryWrite } from '../helpers/itinerario-escrita-e2e-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
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

  test('funil-vacante-atalho-itinerario', async ({ page, request }) => {
    // O paciente da vaga tem 2 serviços e a vaga é do 2º: o atalho leva o `serviceId` na URL e a aba abre direto na tela DELE (sem passar pela lista).
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -47.1203, lng: -66.2204 });
    try {
      await createServiceViaApi(request, seed.patientId, { addressId: seed.addressId, schedule: [{ dayOfWeek: 3, startTime: '08:00', durationMinutes: 240 }] });
      const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId); // a vaga do serviço da semente
      runSQL(`UPDATE job_postings SET is_draft = false WHERE id = '${vacancyId}'`); // publicada: o funil (Kanban) da vaga carrega
      await loginAs(page, MOCK_STAFF);
      await gotoVacancyDetail(page, vacancyId);

      await page.getByRole('button', { name: 'Ver itinerario del paciente' }).click();

      await expect(page, 'chega à ficha do paciente DONO da vaga, com ?tab=itinerary&serviceId=<serviço da vaga>').toHaveURL(
        new RegExp(`/admin/patients/${seed.patientId}\\?tab=itinerary&serviceId=${seed.serviceId}$`),
        { timeout: 15_000 },
      );
      // A aba Itinerario está ativa e abriu NA TELA DO SERVIÇO da vaga (e "Volver a los servicios" leva à lista dos 2).
      await expect(page.getByTestId(`itinerario-servico-tela-${seed.serviceId}`), 'a aba abre direto no serviço da vaga').toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('itinerario-lista-servicos')).toHaveCount(0);
      await expect(page.getByTestId('patient-profile-tabs')).toBeVisible();
      await page.getByTestId('itinerario-voltar-servicos').click();
      await expect(page.locator('[data-testid^="itinerario-cartao-abrir-"]')).toHaveCount(2);
    } finally {
      cleanupItineraryWrite(seed.patientId);
      seed.cleanup();
    }
  });
});
