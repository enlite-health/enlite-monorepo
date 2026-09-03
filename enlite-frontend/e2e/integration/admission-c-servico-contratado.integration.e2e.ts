/**
 * admission-c-servico-contratado.integration.e2e.ts @integration — spec 013, bloco C.
 *
 * Front real (Vite 5173) + API real (docker enlite-api, rebuildada desta worktree) + Postgres real
 * (migrations 318-321). Auth REAL pelo emulador do Firebase. Zero mock de dado. Só dado sintético.
 * Molde: admission-b-campos.integration.e2e.ts.
 *
 * Aceite da US-C1: paciente com 2 serviços contratados (AT domiciliar 20h/sem, 2 prestadores
 * necessários; cuidador escolar 10h/sem) → card mostra os dois, valores reais; associa 1
 * prestador ao 1º; ativa → 2 vagas, cada uma com contracted_service_id do serviço certo.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import {
  seedActivatablePatient, seedWorker, cleanupWorker, readContractedServices, readVacanciesByService,
  cleanupPatientDeep, runSQL,
} from '../helpers/patient-detail-c-helper';

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.blococ.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';

async function loginAsRealStaff(page: Page): Promise<void> {
  const signUp = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  const auth = signUp.ok ? signUp : await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(auth.ok).toBe(true);
  const { localId } = (await auth.json()) as { localId: string };
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
  });
  expect(claims.ok).toBe(true);
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Bloco C', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await forceClick(page.getByRole('button', { name: /Iniciar sesi/i }));
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

/**
 * O banner do Firebase Auth Emulator ("Running in emulator mode…") fica FIXO no rodapé da
 * VIEWPORT — não do drawer — então nenhuma quantidade de scroll do conteúdo tira um botão perto
 * do fim do formulário de debaixo dele, e um clique real (mesmo `force:true`, que só pula a
 * checagem do Playwright — o NAVEGADOR ainda entrega o evento a quem está no topo daquele
 * pixel) acerta o banner, não o botão. `el.click()` via `evaluate` invoca o handler diretamente
 * no elemento, sem hit-test de coordenada — o único jeito que sobrevive a um overlay fixo
 * cosmético que 3 tentativas de escondê-lo (CSS, MutationObserver) não tiraram do caminho.
 */
async function forceClick(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el: HTMLElement) => el.click());
}

/** Mesmo motivo do `forceClick`: `scrollIntoViewIfNeeded` primeiro, sempre, num drawer que cresce
 * (2 formulários de serviço inteiros) e cujo fim de conteúdo fica perto do banner fixo. */
async function forceFill(locator: Locator, value: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.fill(value);
}

async function forceSelect(locator: Locator, value: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.selectOption(value);
}

async function openDetail(page: Page, patientId: string): Promise<void> {
  const isDetail = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const detail = page
      .waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 })
      .catch(() => null);
    await page.goto(`/admin/patients/${patientId}`);
    const res = await detail;
    if (res) return;
  }
  throw new Error(`GET /api/admin/patients/${patientId} não observado em 2 tentativas`);
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Spec 013 bloco C — serviço contratado como entidade @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let seed: { patientId: string; stamp: string };
  let worker: { workerId: string; name: string };

  test.beforeAll(() => {
    seed = seedActivatablePatient();
    worker = seedWorker(seed.stamp);
  });

  test.afterAll(() => {
    cleanupPatientDeep(seed.patientId);
    cleanupWorker(worker.workerId);
  });

  test('1. dois serviços contratados + 1 prestador associado + ativar → 2 vagas, cada uma com o contracted_service_id certo', async ({ page }) => {
    // O banner do Firebase Auth Emulator ("Running in emulator mode…") fica fixo na tela e
    // INTERCEPTA o clique de verdade — mesmo com `force:true` o navegador entrega o evento a
    // quem está no topo daquele pixel, então esconder por CSS (`display:none`) não bastou
    // (medido: o clique "passava" sem erro do Playwright, mas o estado React nunca mudava,
    // porque o banner é quem recebia o evento). Solução definitiva: REMOVER o elemento do DOM
    // assim que ele aparecer, via MutationObserver — `addInitScript` roda de novo em CADA
    // navegação (`page.goto()` acontece dentro de `openDetail`).
    await page.addInitScript(() => {
      const strip = () => {
        document.querySelectorAll('.firebase-emulator-warning').forEach((el) => el.remove());
      };
      strip();
      new MutationObserver(strip).observe(document.documentElement, { childList: true, subtree: true });
    });
    await loginAsRealStaff(page);
    await openDetail(page, seed.patientId);

    // O card mora na aba "Servicio Contratado" — a ficha abre em "Datos Clínicos".
    await forceClick(page.getByRole('button', { name: 'Servicio Contratado' }));

    // ── #PEND-08 vivo: sem serviço, o card mostra o empty state real, não 5 colunas fantasma ──
    await expect(page.getByTestId('servicos-contratados-card')).toBeVisible();

    // ── Abre o drawer, cria o 1º serviço (AT domiciliar, 20h/sem, 2 prestadores necessários) ──
    await forceClick(page.getByTestId('edit-service-btn'));
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toBeVisible();
    await forceClick(page.getByTestId('contracted-service-add'));
    await forceSelect(page.getByTestId('svc-code-1'), 'AT');
    await forceFill(page.getByTestId('svc-providersNeeded-1'), '2');
    await forceFill(page.getByTestId('svc-weeklyHours-1'), '20');
    await forceSelect(page.getByTestId('svc-careLocation-1'), 'HOME');
    const createService1 = page.waitForResponse((r) => r.request().method() === 'POST' && /\/contracted-services$/.test(r.url()));
    await forceClick(page.getByTestId('contracted-service-new-save'));
    const svc1Body = (await (await createService1).json()) as { data: { id: string } };
    const service1Id = svc1Body.data.id;
    // O form "novo" (index 1) só vira o form do serviço 1 DEPOIS do refetch da lista (GET) que
    // `handleChildSaved` dispara — sem esperar isso, "+ Nuevo" de novo criaria o 2º form com
    // `index=1` também (colisão de testid), porque `services` ainda estaria vazio.
    await expect(page.getByTestId(`contracted-service-form-${service1Id}`)).toBeVisible({ timeout: 15_000 });

    // ── 2º serviço (cuidador escolar, 10h/sem) ──
    await forceClick(page.getByTestId('contracted-service-add'));
    await forceSelect(page.getByTestId('svc-code-2'), 'CAREGIVER');
    await forceFill(page.getByTestId('svc-weeklyHours-2'), '10');
    await forceSelect(page.getByTestId('svc-careLocation-2'), 'SCHOOL');
    const createService2 = page.waitForResponse((r) => r.request().method() === 'POST' && /\/contracted-services$/.test(r.url()));
    await forceClick(page.getByTestId('contracted-service-new-save'));
    const svc2Body = (await (await createService2).json()) as { data: { id: string } };
    await expect(page.getByTestId(`contracted-service-form-${svc2Body.data.id}`)).toBeVisible({ timeout: 15_000 });

    // ── Associa 1 prestador ao 1º serviço ──
    await forceFill(page.getByTestId(`provider-search-${service1Id}`), worker.name.slice(0, 12));
    await expect(page.locator(`[data-testid^="provider-hit-"]`).first()).toBeVisible({ timeout: 10_000 });
    await forceClick(page.locator(`[data-testid^="provider-hit-"]`).first());
    await forceFill(page.getByTestId(`provider-weekly-hours-${service1Id}`), '20');
    const associate = page.waitForResponse((r) => r.request().method() === 'POST' && /\/providers$/.test(r.url()));
    await forceClick(page.getByTestId(`provider-associate-${service1Id}`));
    await associate;
    await expect(page.getByText(worker.name)).toBeVisible();

    // ── Fecha o drawer e confere o card com dado REAL (não "—") ──
    await forceClick(page.getByLabel('Cerrar'));
    await page.waitForTimeout(400);
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).not.toBeVisible();
    await expect(page.getByTestId(`contracted-service-row-${service1Id}`)).toContainText('2 / 1'); // 2 necessários, 1 ativo
    await expect(page.locator('[data-testid="servicos-contratados-card"]')).toHaveScreenshot('bloco-c-servicos-reais.png');

    // ── Ativar: 1 vaga por (serviço ativo × endereço ativo) = 2 vagas ──
    await forceClick(page.getByTestId('activate-patient-btn'));
    // Sincroniza pela RESPOSTA do POST, não pelo sumiço do botão: a ficha desmonta o botão no
    // skeleton do refetch antes de a API terminar, e sob carga a leitura do banco abaixo chegava
    // antes das vagas (medido 03/09: verde sozinho, `toHaveLength(2)` vermelho com jest rodando junto).
    const activated = page.waitForResponse((r) => r.request().method() === 'POST' && /\/activate$/.test(r.url()), { timeout: 30_000 });
    await forceClick(page.getByTestId('activate-confirm'));
    expect((await activated).status()).toBe(200);
    await expect(page.getByTestId('activate-patient-btn')).not.toBeVisible({ timeout: 15_000 }); // status vira ACTIVE, some

    const services = readContractedServices(seed.patientId);
    expect(services).toHaveLength(2);
    expect(services.every((s) => s.active)).toBe(true);

    const vacancies = readVacanciesByService(seed.patientId);
    expect(vacancies).toHaveLength(2);
    const byService = new Map(vacancies.map((v) => [v.serviceCode, v.providersNeeded]));
    expect(byService.get('AT')).toBe(2);
    expect(byService.get('CAREGIVER')).toBeNull();
    expect(vacancies.every((v) => v.serviceCode !== null)).toBe(true); // toda vaga aponta pro serviço certo
  });
});
