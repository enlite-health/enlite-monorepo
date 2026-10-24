/**
 * patient-itinerary.integration.e2e.ts @integration — D445, rodada 2.
 *
 * Full-stack, sem mock de dado de negócio (só auth/Firebase, o MESMO padrão de
 * `admission-patient-flow.integration.e2e.ts`): abre a aba Itinerario, vê a agenda semanal ("Horario fijo") e os próximos días, registra a
 * substituição de um dia pelo fluxo "Nueva sustitución" (feliz), tenta um substituto em conflito (alternativo 1) e faz a saída definitiva
 * "No vuelve más" com substituto (alternativo 2). ADAPTADO à spec 069 (F7): o QUE cada teste prova é o de antes; só o caminho mudou.
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
import { openFixedSchedule, openServiceScreen, openUpcomingDays } from '../helpers/itinerario-aba-e2e-helper';
import {
  abrirNuevaSustitucion, confirmarPedido, irParaSemanaPeloCalendario, paso1QuienNoViene, paso2PorCuantoTiempo, paso3UnaPersona, paso4Motivo, siguiente, somaDias,
} from '../helpers/itinerario-069-flow-helper';

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

  test('feliz: abre Itinerario, vê a agenda semanal e os próximos días, "Nueva sustitución" registra a substituição de um dia e o turno aparece com o substituto', async ({ page }) => {
    await loginAsAdmin(page);
    await openItinerarioTab(page, seed.patientId);

    // "Horario fijo": a agenda semanal com a faixa alocada ao titular.
    await openFixedSchedule(page, seed.serviceId);
    await expect(page.getByTestId(`itinerario-slot-prestador-${seed.slotId}-${seed.titularWorkerId}`)).toBeVisible({ timeout: 10_000 });

    // "Próximos días": a tabela da semana com "Nueva sustitución".
    await openUpcomingDays(page, seed.serviceId);
    await expect(page.getByTestId('itinerario-proximos-tabela')).toBeVisible();

    // A 2ª segunda: a 1ª fica intacta (o alternativo 2 a usa como "antes de D").
    const chosenDate = somaDias(seed.nextMonday, 7);
    await abrirNuevaSustitucion(page);
    await paso1QuienNoViene(page, seed.titularWorkerId);
    await paso2PorCuantoTiempo(page, 'ONE_DAY', chosenDate);
    await siguiente(page);
    await paso3UnaPersona(page, seed.freeSubstituteWorkerId);
    await expect(page.locator('[data-testid^="substitucion-estado-"]')).toHaveText('Libre', { timeout: 15_000 });
    await siguiente(page);
    // A substituição de um dia pede o motivo (catálogo; 'Otro' = OTHER, da carga inicial).
    await paso4Motivo(page, 'OTHER');
    const resp = await confirmarPedido(page);
    expect(resp.status()).toBe(201);

    await expect(page.getByTestId('substitucion-flujo')).toHaveCount(0, { timeout: 10_000 });
    // O turno daquela data aparece com o SUBSTITUTO (não o titular) e o selo "Sustitución".
    await irParaSemanaPeloCalendario(page, chosenDate);
    const turno = page.getByTestId(`itinerario-proximo-${seed.slotId}-${chosenDate}`);
    await expect(turno).toContainText(seed.names.free, { timeout: 10_000 });
    await expect(turno).toContainText('Sustitución');
    // Prova de banco: 1 ausência aberta, naquela data, com o substituto.
    expect(readOpenAbsences(seed)).toEqual([{ onDate: chosenDate, substituteWorkerId: seed.freeSubstituteWorkerId }]);
  });

  test('041 R2 — modal de edição: verde no alocado, azul na Resposta Rápida, nada no Selecionado, nessa ordem', async ({ page }) => {
    await loginAsAdmin(page);
    await openItinerarioTab(page, seed.patientId);
    await openFixedSchedule(page, seed.serviceId);

    await page.getByTestId(`itinerario-slot-editar-${seed.slotId}`).click();
    const modal = page.getByTestId('itinerario-editar-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('itinerario-editar-preselecionados')).toBeVisible({ timeout: 10_000 });

    const dotOf = (workerId: string) => modal.getByTestId(`itinerario-editar-status-${workerId}`).getByTestId('allocation-option-dot');
    // Verde no alocado (em atendimento), azul em Resposta Rápida, nenhuma bolinha em quem só está Selecionado.
    await expect(dotOf(seed.titularWorkerId)).toHaveClass(/bg-green-600/);
    await expect(dotOf(seed.quickOnlyWorkerId)).toHaveClass(/bg-blue-600/);
    await expect(modal.getByTestId(`itinerario-editar-status-${seed.selectedOnlyWorkerId}`)).toContainText('Seleccionado');
    await expect(dotOf(seed.selectedOnlyWorkerId)).toHaveCount(0);
    // Prova de que os dois estados com bolinha são DISTINTOS: a cor computada do verde difere da do azul.
    const rgb = (workerId: string) => dotOf(workerId).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await rgb(seed.titularWorkerId)).not.toBe(await rgb(seed.quickOnlyWorkerId));

    // Ordem vinda da API: em atendimento → resposta rápida → selecionado.
    const ids = await modal
      .getByTestId('itinerario-editar-preselecionados')
      .locator('[data-testid^="itinerario-editar-card-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
    const pos = (workerId: string) => ids.indexOf(`itinerario-editar-card-${workerId}`);
    expect(pos(seed.titularWorkerId)).toBe(0);
    expect(pos(seed.titularWorkerId)).toBeLessThan(pos(seed.quickOnlyWorkerId));
    expect(pos(seed.quickOnlyWorkerId)).toBeLessThan(pos(seed.selectedOnlyWorkerId));
    expect(pos(seed.selectedOnlyWorkerId)).toBe(ids.length - 1);

    // A mesma marca aparece no dropdown de escolha do prestador (digitando, como pessoa).
    await modal.getByTestId('itinerario-editar-prestador').click();
    await modal.getByPlaceholder('Buscar...').click();
    await page.keyboard.type('Sofia', { delay: 20 });
    const option = modal.getByRole('option', { name: new RegExp(seed.names.selected) });
    await expect(option).toBeVisible();
    await expect(option.getByTestId('allocation-option-dot')).toHaveCount(0);
  });

  test('alternativo 1: saída definitiva com substituto em conflito → o conflito é DITO na tela e o fluxo não avança; nada muda', async ({ page }) => {
    await loginAsAdmin(page);
    await openItinerarioTab(page, seed.patientId);
    await openUpcomingDays(page, seed.serviceId);

    const before = readAssignments(seed);
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/substitution-requests$/.test(r.url())) posts.push(r.url());
    });
    await abrirNuevaSustitucion(page);
    await paso1QuienNoViene(page, seed.titularWorkerId);
    await paso2PorCuantoTiempo(page, 'PERMANENT', seed.nextMonday);
    await siguiente(page);
    // `substituteWorkerId` continua "Selecionado" neste serviço, mas já cobre uma faixa que se sobrepõe em OUTRO serviço (`seedConflictForSubstitute`,
    // invariante 4: o gatilho de conflito é GLOBAL por worker, não por paciente/serviço). A pré-visão do passo 3 DIZ isso antes de enviar.
    await paso3UnaPersona(page, seed.substituteWorkerId);
    const estado = page.locator('[data-testid^="substitucion-estado-"]');
    await expect(estado).toHaveText('Conflicto', { timeout: 15_000 });
    const nota = page.locator('[data-testid^="substitucion-conflicto-"]').first();
    await expect(nota).toBeVisible();
    expect((await nota.innerText()).trim().length).toBeGreaterThan(10); // texto legível, não código cru
    await expect(page.getByTestId('substitucion-siguiente')).toBeDisabled();
    await expect(page.getByTestId('substitucion-bloqueo')).toBeVisible();

    // Nada muda: a faixa continua com o titular original e nenhum pedido saiu.
    await page.getByTestId('substitucion-cerrar').click();
    await openFixedSchedule(page, seed.serviceId);
    await expect(page.getByTestId(`itinerario-slot-prestador-${seed.slotId}-${seed.titularWorkerId}`)).toBeVisible();
    expect(readAssignments(seed)).toEqual(before);
    expect(posts).toHaveLength(0);
  });

  test('alternativo 2: "No vuelve más" com substituto — a partir da data, o titular sai e o novo entra', async ({ page }) => {
    await loginAsAdmin(page);
    await openItinerarioTab(page, seed.patientId);
    await openServiceScreen(page, seed.serviceId);

    // ANTES: horas cobertas (texto lido da tela) e estado do paciente.
    const horasAntes = await page.getByTestId('itinerario-servico-horas').innerText();
    const statusAntes = readPatientStatus(seed);
    // D = a SEGUNDA seguinte à 1ª segunda (`nextMonday` = 1ª segunda em hoje+1..hoje+7). Com D = `nextMonday` o 1º turno da faixa (segunda) já cai
    // em D e nunca existe turno "antes de D" para o titular (medido no CI #712).
    const fromDate = somaDias(seed.nextMonday, 7);
    await openUpcomingDays(page, seed.serviceId);
    await abrirNuevaSustitucion(page);
    await paso1QuienNoViene(page, seed.titularWorkerId);
    await paso2PorCuantoTiempo(page, 'PERMANENT', fromDate);
    await siguiente(page);
    await paso3UnaPersona(page, seed.permanentWorkerId);
    await expect(page.locator('[data-testid^="substitucion-estado-"]')).toHaveText('Libre', { timeout: 15_000 });
    await siguiente(page);
    await paso4Motivo(page, 'OTHER');
    const resp = await confirmarPedido(page);
    expect(resp.status()).toBe(201);

    await expect(page.getByTestId('substitucion-flujo')).toHaveCount(0, { timeout: 10_000 });
    // A agenda (asOf = hoje < D): a faixa AINDA mostra o titular — ele trabalha até D-1.
    await openFixedSchedule(page, seed.serviceId);
    await expect(page.getByTestId(`itinerario-slot-prestador-${seed.slotId}-${seed.titularWorkerId}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`itinerario-slot-sem-prestador-${seed.slotId}`)).toHaveCount(0);
    // Horas cobertas e estado do paciente: IGUAIS antes e depois (hoje < D).
    await expect(page.getByTestId('itinerario-servico-horas')).toHaveText(horasAntes);
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
    // Na tela (Próximos días): antes de D (a 1ª segunda) o TITULAR; a partir de D o NOVO.
    await openUpcomingDays(page, seed.serviceId);
    await irParaSemanaPeloCalendario(page, seed.nextMonday);
    await expect(page.getByTestId(`itinerario-proximo-${seed.slotId}-${seed.nextMonday}`)).toContainText(seed.names.titular, { timeout: 10_000 });
    await irParaSemanaPeloCalendario(page, fromDate);
    await expect(page.getByTestId(`itinerario-proximo-${seed.slotId}-${fromDate}`)).toContainText(seed.names.permanent, { timeout: 10_000 });
  });
});
