/**
 * admission-c-servico-contratado-humano.integration.e2e.ts @integration — D283 (06/09/2026)
 *
 * A pergunta do Gabriel: "quero saber se O FUNCIONAMENTO HUMANO também funciona". As specs C e
 * A6 preenchem por `fill()`/`selectOption()` depois de `scrollIntoViewIfNeeded()` — provam o
 * ESTADO, não que um humano consegue clicar e digitar. Aqui NÃO há `evaluate`, `fill` nem
 * `dispatchEvent`: cada campo é `click()` (hit-test real de mouse) + `keyboard.type()`, e o que
 * se afirma é o valor que FICOU na tela depois de digitar. Se algo estiver por cima do campo
 * (backdrop, banner, drawer fantasma), o clique não foca e o teste reprova.
 *
 * Fluxo: abrir a ficha → aba "Servicio Contratado" → "Editar servicios" → "+ Nuevo servicio" →
 * digitar em TODOS os campos de texto/número → escolher serviço, lugar e DOMICÍLIO → adicionar um
 * horário no editor → Guardar → fechar → a tabela mostra a linha → clique na linha abre o detalhe.
 * API e Postgres reais (stack docker), login real pelo emulador do Firebase.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';

const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.humano.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';

/** Login como um humano: clica no campo, digita, clica no botão. Sem `fill`. */
async function loginComoHumano(page: Page): Promise<void> {
  const signUp = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(signUp.ok).toBe(true);
  const { localId } = (await signUp.json()) as { localId: string };
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
  });
  expect(claims.ok).toBe(true);
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Humano', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').click();
  await page.keyboard.type(STAFF_EMAIL);
  await page.locator('input[type="password"]').click();
  await page.keyboard.type(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}

/** Clica no campo como um humano, digita, e devolve o que a TELA mostra depois. */
async function digitar(page: Page, testId: string, texto: string): Promise<string> {
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('D283 — serviço contratado: um HUMANO consegue preencher, salvar e ler @integration', () => {
  test.setTimeout(240_000);

  let seed: { patientId: string; addressId: string; stamp: string };

  test.beforeAll(() => { seed = seedActivatablePatient(); });
  test.afterAll(() => { cleanupPatientDeep(seed.patientId); });

  test('mouse e teclado reais: todos os campos do drawer aceitam entrada; o domicílio é escolhível; salvar grava; a tabela e o detalhe mostram', async ({ page }) => {
    await loginComoHumano(page);
    await page.goto(`/admin/patients/${seed.patientId}`);

    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await page.getByTestId('edit-service-btn').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toBeVisible();
    await page.getByTestId('contracted-service-add').click();

    // ── Selects: escolha real ──
    await page.getByTestId('svc-code-1').selectOption('AT');
    await page.getByTestId('svc-careLocation-1').selectOption('HOME');
    const domicilio = page.getByTestId('svc-addressId-1');
    await expect(domicilio).toBeEnabled();
    await expect(domicilio.locator('option')).toHaveCount(2); // placeholder + o endereço da ficha
    await domicilio.selectOption(seed.addressId);
    await expect(domicilio).toHaveValue(seed.addressId);

    // ── Texto/número: clique + teclado, e o valor que FICOU ──
    expect(await digitar(page, 'svc-providersNeeded-1', '2')).toBe('2');
    expect(await digitar(page, 'svc-weeklyHours-1', '20')).toBe('20');
    expect(await digitar(page, 'svc-authorizedHours-1', '24')).toBe('24');
    expect(await digitar(page, 'svc-hourlyValue-1', '1500')).toBe('1500');
    expect(await digitar(page, 'svc-version-1', 'v1')).toBe('v1');
    expect(await digitar(page, 'svc-profile-1', 'perfil digitado por humano')).toBe('perfil digitado por humano');

    // ── Horário: o "+" de segunda-feira cria um slot 09:00–17:00 ──
    await page.getByTestId('day-schedule-add-monday').click();
    await expect(page.getByTestId('day-schedule-remove-monday-0')).toBeVisible();

    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toHaveScreenshot('humano-drawer-preenchido.png', {
      mask: [page.locator('.firebase-emulator-warning')],
    });

    // ── Guardar: a resposta real da API carrega o que foi digitado ──
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/contracted-services$/.test(r.url()));
    await page.getByTestId('contracted-service-new-save').click();
    const body = (await (await created).json()) as { data: { id: string; addressId: string; schedule: unknown[]; providersNeeded: number; hourlyValue: number } };
    expect(body.data.addressId).toBe(seed.addressId);
    expect(body.data.schedule).toEqual([{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }]);
    expect(body.data.providersNeeded).toBe(2);
    expect(body.data.hourlyValue).toBe(1500);

    // ── Fechar pelo X e ler a tabela como um humano lê ──
    await page.getByLabel('Cerrar').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).not.toBeVisible();
    const row = page.getByTestId(`contracted-service-row-${body.data.id}`);
    await expect(row).toContainText('Acompañante Terapéutico');
    await expect(page.getByTestId(`contracted-service-providers-${body.data.id}`)).toHaveText('2');
    await expect(page.getByTestId(`contracted-service-address-${body.data.id}`)).toContainText('CABA'); // o endereço do seed
    await expect(page.getByTestId(`contracted-service-schedule-${body.data.id}`)).toHaveText('Lunes 09:00-17:00');
    await expect(page.getByTestId(`contracted-service-address-missing-${body.data.id}`)).toHaveCount(0);

    // ── Clique real na linha → detalhe ──
    await row.click();
    await expect(page.getByTestId('contracted-service-detail-drawer')).toBeVisible();
    await expect(page.getByTestId('svc-detail-value')).toContainText('1500');
    await expect(page.getByTestId('svc-detail-schedule')).toContainText('Lunes 09:00-17:00');
    await page.getByTestId('contracted-service-detail-close').click();
    await expect(page.getByTestId('contracted-service-detail-drawer')).not.toBeVisible();
  });
});
