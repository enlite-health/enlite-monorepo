/**
 * patient-itinerary.integration.e2e.ts @integration — D445, rodada 2.
 *
 * Full-stack, sem mock de dado de negócio (só auth/Firebase, o MESMO padrão de
 * `admission-patient-flow.integration.e2e.ts`): abre a aba Itinerario, vê a agenda semanal e os
 * próximos eventos, registra substituição pelo "Nuevo +" (feliz), tenta um substituto em conflito
 * (alternativo 1) e faz um reemplazo permanente "Entero" (alternativo 2).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import {
  seedItinerary,
  seedTitularAllocation,
  seedConflictForSubstitute,
  readAssignments,
  readOpenAbsences,
  readPatientStatus,
  cleanupItinerary,
  type ItinerarySeed,
} from '../helpers/itinerary-db-helper';

const MOCK_ADMIN_USER = { uid: 'e2e-int-admin-itinerario', email: 'admin.itinerario@e2e.test', role: 'admin' };
const MOCK_TOKEN = 'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN_USER), 'utf-8').toString('base64');
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
      body: JSON.stringify({ users: [{ localId: MOCK_ADMIN_USER.uid, email: MOCK_ADMIN_USER.email, emailVerified: true }] }),
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
            firstName: 'Itinerario',
            lastName: 'Admin',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }
    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installInterceptors(page);
    await page.route('**/v1/me/authz**', async (route: Route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').click();
  await page.keyboard.type(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').click();
  await page.keyboard.type('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

async function openItinerarioTab(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await page.getByTestId('patient-profile-tabs').getByText('Itinerario', { exact: true }).click();
  await expect(page.getByTestId('itinerario-aba')).toBeVisible({ timeout: 15_000 });
}

test.describe('Aba Itinerario — full stack, sem mock @integration', () => {
  test.setTimeout(90_000);
  let seed: ItinerarySeed;

  test.beforeAll(() => {
    seed = seedItinerary();
    seedTitularAllocation(seed);
    seedConflictForSubstitute(seed);
  });

  test.afterAll(() => {
    cleanupItinerary(seed);
  });

  test('feliz: abre Itinerario, vê agenda semanal e próximos eventos, "Nuevo +" registra substituição e o card aparece', async ({ page }) => {
    await loginAsAdmin(page);
    await openItinerarioTab(page, seed.patientId);

    // Coluna direita: agenda semanal com a faixa alocada ao titular.
    await expect(page.getByText('Agenda de Atenciones')).toBeVisible();
    await expect(page.getByTestId(`itinerario-slot-prestador-${seed.slotId}-${seed.titularWorkerId}`)).toBeVisible({ timeout: 10_000 });

    // Coluna esquerda: painel de próximos eventos presente, com "Nuevo +".
    await expect(page.getByTestId('itinerario-eventos-painel')).toBeVisible();

    // "Nuevo +": registra substituição do dia (Complementar) com o substituto.
    await page.getByTestId('itinerario-novo-btn').click();
    await expect(page.getByTestId('substitution-slot')).toBeVisible({ timeout: 10_000 });
    // Figma: PAINEL LATERAL à direita, altura cheia (não diálogo central).
    const viewport = page.viewportSize()!;
    await expect
      .poll(async () => {
        const box = await page.getByTestId('substitution-modal').boundingBox();
        return box ? Math.round(box.x + box.width) : -1;
      })
      .toBe(viewport.width);
    expect((await page.getByTestId('substitution-modal').boundingBox())!.height).toBe(viewport.height);
    await page.getByTestId('substitution-date').selectOption({ index: 2 })  // 2ª segunda: a 1ª fica intacta (o alternativo 2 a usa como "antes de D");
    const chosenDate = await page.getByTestId('substitution-date').inputValue();
    await page.getByTestId('substitution-worker').click();
    await page.getByRole('listbox').getByText(seed.names.free).click();
    // Fase 2: a substituição de um dia pede o motivo (catálogo; 'Otro' = OTHER, da carga inicial).
    await page.getByTestId('substitution-reason').selectOption('OTHER');
    await page.getByTestId('substitution-confirm').click();

    await expect(page.getByTestId('substitution-modal')).toHaveCount(0, { timeout: 10_000 });
    // O card do evento daquela data aparece com o SUBSTITUTO (não o titular) e o selo "substituído".
    const eventPrestador = page.locator(`[data-testid^="itinerario-evento-prestador-"][data-testid$="-${chosenDate}"]`);
    await expect(eventPrestador).toContainText(seed.names.free, { timeout: 10_000 });
    await expect(page.locator(`[data-testid^="itinerario-evento-status-"][data-testid$="-${chosenDate}"]`)).toBeVisible();
    // Prova de banco: 1 ausência aberta, naquela data, com o substituto.
    expect(readOpenAbsences(seed)).toEqual([{ onDate: chosenDate, substituteWorkerId: seed.freeSubstituteWorkerId }]);
  });

  test('alternativo 1: reemplazo com substituto em conflito → erro legível na tela, nada muda', async ({ page }) => {
    await loginAsAdmin(page);
    await openItinerarioTab(page, seed.patientId);

    const before = readAssignments(seed);
    await page.getByTestId('itinerario-novo-btn').click();
    await expect(page.getByTestId('substitution-slot')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('substitution-mode-permanent').click();
    await page.getByTestId('substitution-date').selectOption({ index: 1 });
    await page.getByTestId('substitution-worker').click();
    // `substituteWorkerId` continua "Selecionado" neste serviço (nunca foi alocado nele — a 1ª
    // `it` só o usou como substituto de UM DIA, não muda a candidatura), mas já cobre uma faixa
    // que se sobrepõe em OUTRO serviço (`seedConflictForSubstitute`, invariante 4: o gatilho de
    // conflito é GLOBAL por worker, não por paciente/serviço).
    await page.getByRole('listbox').getByText(seed.names.substitute).click();
    await page.getByTestId('substitution-confirm').click();

    const erro = page.getByTestId('itinerario-novo-erro-submit');
    await expect(erro).toBeVisible({ timeout: 10_000 });
    expect((await erro.innerText()).trim().length).toBeGreaterThan(10); // texto legível, não código cru
    // Nada muda: a faixa continua com o titular original.
    await expect(page.getByTestId(`itinerario-slot-prestador-${seed.slotId}-${seed.titularWorkerId}`)).toBeVisible();
    expect(readAssignments(seed)).toEqual(before);
  });

  test('alternativo 2: "Entero" (reemplazo permanente) — a partir da data, o titular sai e o novo entra', async ({ page }) => {
    await loginAsAdmin(page);
    await openItinerarioTab(page, seed.patientId);

    // ANTES: horas cobertas (texto do par cobertas/contratadas) e estado do paciente.
    const parLocator = page.getByTestId(`itinerario-servico-par-${seed.serviceId}`);
    await expect(page.getByTestId(`itinerario-slot-prestador-${seed.slotId}-${seed.titularWorkerId}`)).toBeVisible();
    const parAntes = await parLocator.innerText();
    const statusAntes = readPatientStatus(seed);
    await page.getByTestId('itinerario-novo-btn').click();
    await expect(page.getByTestId('substitution-slot')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('substitution-mode-permanent').click();
    await page.getByTestId('substitution-date').selectOption({ index: 2 });
    const fromDate = await page.getByTestId('substitution-date').inputValue();
    await page.getByTestId('substitution-worker').click();
    await page.getByRole('listbox').getByText(seed.names.permanent).click();
    await page.getByTestId('substitution-confirm').click();

    await expect(page.getByTestId('substitution-modal')).toHaveCount(0, { timeout: 10_000 });
    // A agenda (asOf = hoje < D): a faixa AINDA mostra o titular — ele trabalha até D-1.
    await expect(page.getByTestId(`itinerario-slot-prestador-${seed.slotId}-${seed.titularWorkerId}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`itinerario-slot-sem-prestador-${seed.slotId}`)).toHaveCount(0);
    // Horas cobertas e estado do paciente: IGUAIS antes e depois (hoje < D).
    await expect(parLocator).toHaveText(parAntes);
    expect(readPatientStatus(seed)).toBe(statusAntes);
    // Prova de banco: o titular encerra em D-1 e o novo entra em D, ambos no mesmo slot.
    await expect
      .poll(() => readAssignments(seed).find((a) => a.workerId === seed.permanentWorkerId)?.validFrom, { timeout: 10_000 })
      .toBe(fromDate);
    const rows = readAssignments(seed);
    const titular = rows.find((a) => a.workerId === seed.titularWorkerId);
    const novo = rows.find((a) => a.workerId === seed.permanentWorkerId);
    expect(titular?.status).toBe('ACTIVE'); // NÃO 'ENDED': com ENDED + valid_to futuro o titular sairia hoje
    expect(titular?.validTo).not.toBeNull();
    expect(titular!.validTo! < fromDate).toBe(true);
    expect(novo?.status).toBe('ACTIVE');
    expect(novo?.validTo).toBeNull();
    // Na tela (próximos eventos): antes de D (1ª segunda) o TITULAR; a partir de D o NOVO.
    // "Antes de D" = o 1º evento com data < fromDate (não `seed.nextMonday`: numa segunda-feira ele coincide com D).
    const idEventoAntesDeD = async (): Promise<string> =>
      (await page.locator('[data-testid^="itinerario-evento-prestador-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? '')))
        .filter((id) => id.slice(-10) < fromDate)[0] ?? '';
    await expect.poll(idEventoAntesDeD, { timeout: 10_000 }).not.toBe('');
    await expect(page.getByTestId(await idEventoAntesDeD())).toContainText(seed.names.titular, { timeout: 10_000 });
    // Na tela: o evento de D mostra o NOVO prestador.
    await expect(
      page.locator(`[data-testid^="itinerario-evento-prestador-"][data-testid$="-${fromDate}"]`).first(),
    ).toContainText(seed.names.permanent, { timeout: 10_000 });
  });
});
