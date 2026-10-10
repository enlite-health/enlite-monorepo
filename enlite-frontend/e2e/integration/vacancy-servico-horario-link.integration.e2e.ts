/**
 * vacancy-servico-horario-link.integration.e2e.ts @integration — F4 de `vaga-le-do-servico-contratado`.
 *
 * Backend real (Docker `enlite-api`) + Postgres real + frontend real. Zero mock de API (só o login, pelo mock
 * do stack de CI). Dado sintético. Vaga que nasce do serviço contratado (foguete) e é publicada por SQL
 * (`is_draft=false`; sem Talentum — canal real proibido em teste).
 *
 *  1. o lápis do horário da vaga com serviço é um LINK: clique real → URL `?tab=contractedService` e a aba
 *     "Servicio Contratado" aberta (o conteúdo dela, a linha do serviço, está na tela; o da aba inicial não);
 *  2. `?tab=lixo` na ficha → cai na aba inicial (Datos Clínicos);
 *  3. o serviço muda o horário com a vaga publicada → a faixa de aviso aparece no detalhe; "marcar como
 *     atendido" (clique real) fecha o aviso no backend e a faixa some.
 *
 * O CI roda este portão com `--ignore-snapshots`: o `toHaveScreenshot` abaixo existe pela regra do projeto
 * (baseline é gitignored; não há baseline versionada).
 */
import { test, expect } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? process.env.API_BASE_URL ?? 'http://localhost:8080';
const STAFF: MockUser = { uid: `e2e-vaga-servico-link-${Date.now()}`, email: `e2e.vaga-servico-link.${Date.now()}@enlite.health`, role: 'admin', country: 'AR' };
const AUTH_HEADERS = { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' };

test.describe('vacancy-servico-horario-link — F4 (vaga-le-do-servico-contratado) @integration', () => {
  // Uma vaga só, compartilhada; o 3º teste muda o horário do serviço e fecha o aviso.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  let patientId = '';
  let serviceId = '';
  let vacancyId = '';

  test.beforeAll(async ({ request }) => {
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION',
      firstName: 'ServicoLink',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      hasConsent: true,
      insuranceInformed: 'OSDE',
    });
    patientId = seeded.patientId;
    const addressId = seeded.addressId ?? '';
    expect(addressId, 'insertTestPatient não devolveu addressId').toBeTruthy();

    const svc = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services`, {
      headers: AUTH_HEADERS,
      data: {
        serviceCode: 'AT',
        providersNeeded: 1,
        weeklyHours: 20,
        careLocation: 'HOME',
        addressId,
        schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
      },
    });
    expect(svc.ok(), `POST contracted-services falhou: ${svc.status()} ${await svc.text()}`).toBe(true);
    serviceId = (await svc.json()).data.id as string;

    const act = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, {
      headers: AUTH_HEADERS,
    });
    expect(act.ok(), `activate-recruitment falhou: ${act.status()} ${await act.text()}`).toBe(true);
    vacancyId = (await act.json()).data.vacancyId as string;

    // Publicada (o rascunho redireciona para /borrador): só o bit `is_draft` importa para a tela e para o aviso.
    runSQL(`UPDATE job_postings SET is_draft = false WHERE id = '${vacancyId}'`);
  });

  test.afterAll(() => cleanupTestPatient(patientId));

  test('1. lápis do horário (vaga com serviço) → clique real leva à ficha na aba Servicio Contratado', async ({ page }) => {
    await loginComoStaffMock(page, STAFF, 'E2E Servico Link');
    await page.goto(`/admin/vacancies/${vacancyId}`);
    await expect(page.getByTestId('vacancy-profession-card')).toBeVisible({ timeout: 20_000 });

    // O horário é do serviço: o lápis é o link, não o botão que abre o modal.
    await expect(page.getByTestId('vacancy-edit-schedule-trigger')).toHaveCount(0);
    const lapis = page.getByTestId('vacancy-schedule-service-link');
    await expect(lapis).toBeVisible();
    await lapis.click();

    await expect(page).toHaveURL(new RegExp(`/admin/patients/${patientId}\\?tab=contractedService$`), { timeout: 20_000 });
    // A aba aberta é a do serviço: a linha do serviço está na tela e o card da aba inicial (Datos Clínicos), não.
    await expect(page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' })).toBeVisible();
    await expect(page.getByTestId(`contracted-service-row-${serviceId}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('diagnostico-card')).toHaveCount(0);
    await expect(page).toHaveScreenshot('vacancy-servico-horario-ficha-aba-servico-integration.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
      mask: [page.getByTestId('patient-identity-card')],
    });
  });

  test('2. ?tab=lixo na ficha → cai na aba inicial (Datos Clínicos), sem a aba do serviço', async ({ page }) => {
    await loginComoStaffMock(page, STAFF, 'E2E Servico Link');
    await page.goto(`/admin/patients/${patientId}?tab=lixo`);
    await expect(page.getByTestId('diagnostico-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`contracted-service-row-${serviceId}`)).toHaveCount(0);
  });

  test('3. serviço muda o horário com a vaga publicada → faixa de aviso; "marcar como atendido" fecha e a faixa some', async ({ page, request }) => {
    const patch = await request.patch(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}`, {
      headers: AUTH_HEADERS,
      data: { schedule: [{ dayOfWeek: 3, startTime: '09:00', endTime: '13:00' }] },
    });
    expect(patch.ok(), `PATCH do serviço falhou: ${patch.status()} ${await patch.text()}`).toBe(true);

    // O backend (F3) abriu 1 aviso de `schedule` — lido do GET, não assumido.
    const before = (await (await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, { headers: AUTH_HEADERS })).json()).data;
    expect(before.source_change_notices.map((n: { field: string }) => n.field)).toEqual(['schedule']);

    await loginComoStaffMock(page, STAFF, 'E2E Servico Link');
    await page.goto(`/admin/vacancies/${vacancyId}`);
    const faixa = page.getByTestId('source-change-notice-banner');
    await expect(faixa).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('source-change-notice-schedule')).toBeVisible();
    await expect(faixa).toHaveScreenshot('vacancy-source-change-notice-banner-integration.png', {
      maxDiffPixelRatio: 0.02,
      mask: [page.getByText(/Cambio registrado el/)],
    });

    const [ack] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && /\/source-change-notices\/schedule\/ack$/.test(r.url())),
      page.getByTestId('source-change-notice-ack-schedule').click(),
    ]);
    expect(ack.status()).toBe(200);
    await expect(page.getByTestId('source-change-notice-banner')).toHaveCount(0, { timeout: 15_000 });

    const after = (await (await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, { headers: AUTH_HEADERS })).json()).data;
    expect(after.source_change_notices).toEqual([]);

    // Recarregar a página não traz a faixa de volta (o aviso está fechado no banco, não só escondido na tela).
    await page.reload();
    await expect(page.getByTestId('vacancy-profession-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('source-change-notice-banner')).toHaveCount(0);
  });
});
