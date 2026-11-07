/**
 * match-vacancy-modal.integration.e2e.ts @integration
 *
 * Integration E2E — 089 T030: o modal "Hacer match" saiu da vacante. O botão único "Invitar
 * prestadores" do funnel leva à página /admin/vacancies/:id/match; aqui valida que ela distribui os
 * candidatos pelos anéis de distância (passos 5/10/20/50 km) e o painel flutuante do envio.
 * (O arquivo mantém o nome para não perder o histórico; a cobertura completa da página é do
 * `funil-vacante-invitar-prestadores-089.integration.e2e.ts`.)
 *
 * Setup (DB direto):
 *   1. Paciente em Moreno, Buenos Aires (lat=-34.6506, lng=-58.7798)
 *   2. Vacante linkada ao address do paciente, required_sex='F', occupation='AT'
 *   3. 5 workers REGISTERED, sex=F, occupation=AT (passam os hard filters):
 *        W_NEAR ~1km · W_MID ~12km · W_FAR ~30km · W_OUT Santiago (recusado pelo radius=50km)
 *        · W_NOCOORDS sem coords
 *
 * Fluxo do teste (UI): login admin (mock auth) → vacante → clique "Invitar prestadores" →
 * POST /match → página; passos 5, 20 e 50 km mostram NearW, MidW e FarW; OutW nunca aparece.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  insertBaseVacancy,
  cleanupVacancies,
  insertTestWorker,
  cleanupTestWorker,
} from '../helpers/db-test-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';

const BACKEND_URL = 'http://localhost:8080';

const MOCK_ADMIN_USER = {
  uid: 'e2e-int-match-modal',
  email: 'admin.match.modal@e2e.test',
  role: 'admin',
  country: 'AR',
};
// Patient address: Moreno, Buenos Aires (perto da vaga teste real)
const PATIENT_LAT = -34.6506;
const PATIENT_LNG = -58.7798;

async function loginAsAdmin(page: Page): Promise<void> {
  // login do mock do stack (token `mock_*` com `country`, `/v1/me/authz` incluído) — o molde dos irmãos
  await loginComoStaffMock(page, MOCK_ADMIN_USER, 'E2E Match');
}

test.describe('Invitar prestadores — anéis de distância @integration', () => {
  test.setTimeout(120_000);

  let patientId: string;
  let addressId: string | null;
  let vacancyId: string;
  const workerIds: Record<string, string> = {};

  test.beforeAll(async () => {
    // sem linha em `users` o claim de país vem nulo e as consultas protegidas voltam vazias ("Vacante no encontrada")
    seedMockStaff(MOCK_ADMIN_USER, 'E2E Match');
    // 1. Patient em Moreno, BA — com geocoding
    const result = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'MatchModalTest',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      addressLat: PATIENT_LAT,
      addressLng: PATIENT_LNG,
    });
    patientId = result.patientId;
    addressId = result.addressId;
    if (!addressId) throw new Error('Setup: addressId is required');

    // 2. Vacancy via DB helper (caseNumber alto pra evitar colisões)
    const caseNumber = 990_000 + Math.floor(Math.random() * 9999);
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber,
      requiredSex: 'F',
      requiredProfessions: ['AT'],
      // vacante publicada: o rascunho redireciona para /borrador e a vacante nem tem funil
      status: 'SEARCHING',
      isDraft: false,
    });

    // 3. Workers — 5 cenários cobrindo os 4 buckets de distância + sem coords
    workerIds.near = insertTestWorker({
      sex: 'F',
      occupation: 'AT',
      firstName: 'NearW',
      lat: -34.6450,
      lng: -58.7780, // ~0.6 km de Moreno
    });
    workerIds.mid = insertTestWorker({
      sex: 'F',
      occupation: 'AT',
      firstName: 'MidW',
      lat: -34.7500,
      lng: -58.6800, // ~12 km
    });
    workerIds.far = insertTestWorker({
      sex: 'F',
      occupation: 'AT',
      firstName: 'FarW',
      lat: -34.9000,
      lng: -58.5500, // ~33 km
    });
    workerIds.out = insertTestWorker({
      sex: 'F',
      occupation: 'AT',
      firstName: 'OutW',
      lat: -33.4489,
      lng: -70.6693, // Santiago, Chile (>1000 km, fora do radius=50)
    });
    workerIds.nocoords = insertTestWorker({
      sex: 'F',
      occupation: 'AT',
      firstName: 'NoCoordsW',
      lat: null,
      lng: null,
    });
  });

  test.afterAll(() => {
    cleanupMockStaff(MOCK_ADMIN_USER);
    Object.values(workerIds).forEach(cleanupTestWorker);
    if (vacancyId) cleanupVacancies([vacancyId]);
    if (patientId) cleanupTestPatient(patientId);
  });

  test('abre a página Invitar prestadores e distribui candidatos pelos anéis de distância', async ({
    page,
  }) => {
    const SNAP = 'e2e/integration/match-vacancy-modal.integration.e2e.ts-snapshots';

    await loginAsAdmin(page);
    await page.screenshot({ path: `${SNAP}/01-after-login.png`, fullPage: false });

    // Navega pra vacancy detail (default tab = encuadres → renderiza FunnelView)
    await page.goto(`/admin/vacancies/${vacancyId}`);

    const entry = page.getByRole('button', { name: /Invitar prestadores/i });
    await expect(entry).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SNAP}/02-vacancy-detail.png`, fullPage: false });

    // A página dispara o match 1× ao abrir (DF-9)
    const matchPromise = page.waitForResponse(
      (resp) =>
        resp.url().includes(`/api/admin/vacancies/${vacancyId}/match?`) &&
        resp.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await entry.click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}/match`), { timeout: 15_000 });
    const matchResp = await matchPromise;
    expect(matchResp.ok(), `Match POST failed: ${matchResp.status()}`).toBe(true);

    // Cabeçalho com os critérios e os cartões de passo
    const chips = page.getByTestId('invite-chips');
    await expect(chips).toBeVisible({ timeout: 30_000 });
    await expect(chips).toContainText(/Sexo:/);
    await expect(chips).toContainText(/Profesión:/);
    await expect(chips).toContainText(/Servicio:/);
    await expect(page.getByTestId('invite-step-cards')).toBeVisible({ timeout: 30_000 });

    // ── Candidatos por anel (clique no cartão do passo) ───────────────────────
    // NearW (~0.6 km) → Hasta 5 km
    await page.getByTestId('invite-step-5').click();
    await expect(page.getByText(/NearW/).first()).toBeVisible({ timeout: 10_000 });
    // MidW (~12 km) → Hasta 20 km
    await page.getByTestId('invite-step-20').click();
    await expect(page.getByText(/MidW/).first()).toBeVisible({ timeout: 10_000 });
    // FarW (~33 km) → Hasta 50 km
    await page.getByTestId('invite-step-50').click();
    await expect(page.getByText(/FarW/).first()).toBeVisible({ timeout: 10_000 });

    // Worker em Santiago (W_OUT) NÃO aparece em passo nenhum — radius=50km o recusa
    await expect(page.getByText(/OutW/)).toHaveCount(0);

    await page.setViewportSize({ width: 1280, height: 1800 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SNAP}/03-modal-fullview.png`, fullPage: false });
    await page.screenshot({ path: `${SNAP}/04-modal-fullpage.png`, fullPage: true });
  });
});

/**
 * Painel de progresso de convite (estilo upload do Drive, não-bloqueante).
 * Setup próprio e isolado (paciente + vaga + 1 worker) pra não colidir com a
 * suíte de buckets acima (vaga distinta ⇒ sem match concorrente/WJA duplicado)
 * e pra não depender das asserts de distribuição por bucket.
 */
test.describe('Invitar prestadores — painel de convite flutuante @integration', () => {
  test.setTimeout(120_000);

  let patientId: string;
  let addressId: string | null;
  let vacancyId: string;
  let workerIds: string[] = [];

  test.beforeAll(async () => {
    // sem linha em `users` o claim de país vem nulo e as consultas protegidas voltam vazias ("Vacante no encontrada")
    seedMockStaff(MOCK_ADMIN_USER, 'E2E Match');
    const result = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'PanelTest',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      addressLat: PATIENT_LAT,
      addressLng: PATIENT_LNG,
    });
    patientId = result.patientId;
    addressId = result.addressId;
    if (!addressId) throw new Error('Setup: addressId is required');

    const caseNumber = 980_000 + Math.floor(Math.random() * 9999);
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber,
      requiredSex: 'F',
      requiredProfessions: ['AT'],
      // vacante publicada: o rascunho redireciona para /borrador e a vacante nem tem funil
      status: 'SEARCHING',
      isDraft: false,
    });

    // 3 workers perto garantem múltiplos candidatos — permite ver o estado
    // "enviando" (barra parcial + spinner) além do "concluído".
    workerIds = [
      insertTestWorker({ sex: 'F', occupation: 'AT', firstName: 'PanelA', lat: -34.6450, lng: -58.7780 }),
      insertTestWorker({ sex: 'F', occupation: 'AT', firstName: 'PanelB', lat: -34.6460, lng: -58.7790 }),
      insertTestWorker({ sex: 'F', occupation: 'AT', firstName: 'PanelC', lat: -34.6470, lng: -58.7800 }),
    ];
  });

  test.afterAll(() => {
    cleanupMockStaff(MOCK_ADMIN_USER);
    workerIds.forEach(cleanupTestWorker);
    if (vacancyId) cleanupVacancies([vacancyId]);
    if (patientId) cleanupTestPatient(patientId);
  });

  test('invita candidato → painel flutuante aparece e não bloqueia o fluxo', async ({
    page,
  }) => {
    const SNAP = 'e2e/integration/match-vacancy-modal.integration.e2e.ts-snapshots';

    await loginAsAdmin(page);

    // Mock do envio WhatsApp — jamais dispara Twilio real. Delay de 700ms deixa
    // o estado "enviando" visível pro screenshot. Rota mais específica que a
    // genérica `**/api/**` (registrada depois → tem precedência).
    await page.route(
      '**/api/admin/messaging/whatsapp/vacancy-match',
      async (route: Route) => {
        await new Promise((r) => setTimeout(r, 700));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { sid: 'SM_e2e_mock', status: 'queued' },
          }),
        });
      },
    );

    await page.goto(`/admin/vacancies/${vacancyId}`);
    const entry = page.getByRole('button', { name: /Invitar prestadores/i });
    await expect(entry).toBeVisible({ timeout: 20_000 });

    const matchPromise = page.waitForResponse(
      (resp) =>
        resp.url().includes(`/api/admin/vacancies/${vacancyId}/match?`) &&
        resp.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await entry.click();
    await matchPromise;

    // Os 3 candidatos do passo 5 km vêm pré-selecionados (DF-6); a confirmação F3 lista os nomes.
    for (const id of workerIds) {
      await expect(page.getByTestId(`invite-row-check-${id}`)).toBeChecked({ timeout: 30_000 });
    }
    await page.getByTestId('invite-btn-invite').click();
    await expect(page.getByTestId('invite-confirm-dialog')).toBeVisible();
    await page.getByTestId('invite-confirm-send').click();

    // O painel flutuante aparece (canto inferior-direito) e NÃO é um modal
    // bloqueante — a página de match segue acessível por trás.
    const panel = page.getByTestId('invite-progress-panel');
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // ── Estado "enviando" — barra de progresso parcial + spinner ──────────────
    await expect(panel.getByText(/enviando/i).first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SNAP}/05-panel-sending.png`, fullPage: false });

    // ── Estado "concluído" — todos enviados ───────────────────────────────────
    await expect(panel.getByText(/3 invitaciones enviadas/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: `${SNAP}/06-panel-done.png`, fullPage: false });
  });
});
