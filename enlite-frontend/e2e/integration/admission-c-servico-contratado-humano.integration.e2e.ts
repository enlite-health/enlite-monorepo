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
  // 2º teste do mesmo arquivo reusa a conta (o e-mail é constante do módulo): cai no signIn.
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
  // serial: com 2 workers o `beforeAll` roda duas vezes no mesmo segundo → mesmo `case_number`.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let seed: { patientId: string; addressId: string; stamp: string };

  test.beforeAll(() => { seed = seedActivatablePatient(800000); }); // faixa própria (800000–889999): o C (900000–989999) roda em paralelo
  test.afterAll(() => { cleanupPatientDeep(seed.patientId); });

  test('mouse e teclado reais: todos os campos do drawer aceitam entrada; o domicílio é escolhível; salvar grava; a tabela e o detalhe mostram', async ({ page }) => {
    await loginComoHumano(page);
    await page.goto(`/admin/patients/${seed.patientId}`);

    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    // 06/09: "+ Nuevo servicio" no card abre direto o formulário de UM serviço — a tabela é a lista.
    await page.getByTestId('new-service-btn').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Nuevo servicio contratado' })).toBeVisible();
    const drawer = page.getByTestId('patient-contracted-services-edit-drawer');
    // Geometria só depois da animação de entrada (300 ms de translate): medir antes dá o
    // drawer ainda fora da tela — foi o que uma 1ª versão deste teste fez.
    await expect.poll(async () => { const b = await drawer.boundingBox(); return b ? Math.round(b.x + b.width) : 0; }, { timeout: 5_000 }).toBe(1600);
    // Colunas alinhadas (06/09): os campos numéricos de uma mesma linha da grade ficam na mesma altura,
    // mesmo com a dica "Solo números" (que agora fica embaixo do campo).
    const [hsSem, hsAut] = await Promise.all([
      page.getByTestId('svc-weeklyHours-1').boundingBox(),
      page.getByTestId('svc-authorizedHours-1').boundingBox(),
    ]);
    expect(Math.abs((hsSem?.y ?? 0) - (hsAut?.y ?? 1e9))).toBeLessThan(2);
    // Largura (06/09): a legenda "Franja etaria solicitada del prestador" cabe numa linha só.
    const franja = page.locator('label[for="svc-providerAgeBand-1"]');
    const box = await franja.boundingBox();
    expect(box?.height ?? 999).toBeLessThan(30);

    // ── Selects: escolha real ──
    await page.getByTestId('svc-code-1').selectOption('AT');
    await page.getByTestId('svc-careLocation-1').selectOption('HOME');
    const domicilio = page.getByTestId('svc-addressId-1');
    await expect(domicilio).toBeEnabled();
    await expect(domicilio.locator('option')).toHaveCount(2); // placeholder + o endereço da ficha
    await domicilio.selectOption(seed.addressId);
    await expect(domicilio).toHaveValue(seed.addressId);

    // ── Letra num campo numérico: o navegador recusa em silêncio; a tela AVISA (Gabriel, 06/09) ──
    const prest = page.getByTestId('svc-providersNeeded-1');
    await prest.click();
    await page.keyboard.type('abc');
    await expect(prest).toHaveValue('');
    await expect(page.getByText('Este campo acepta solo números.').first()).toBeVisible();
    await expect(page.getByText('Solo números').first()).toBeVisible();

    // ── Texto/número: clique + teclado, e o valor que FICOU ──
    expect(await digitar(page, 'svc-providersNeeded-1', '2')).toBe('2');
    expect(await digitar(page, 'svc-weeklyHours-1', '20')).toBe('20');
    expect(await digitar(page, 'svc-authorizedHours-1', '24')).toBe('24');
    expect(await digitar(page, 'svc-hourlyValue-1', '1500')).toBe('1500');
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

    // Depois de salvar, o drawer troca para a EDIÇÃO do recém-criado (06/09) — é aí que a
    // seção de prestadores existe. Esperar a troca também tira de cena a lixeira do form novo.
    await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible();
    await expect(page.getByTestId(`contracted-service-form-${body.data.id}`)).toBeVisible();

    // ── Fechar pelo X e ler a tabela como um humano lê ──
    await page.getByLabel('Cerrar').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).not.toBeVisible();
    const row = page.getByTestId(`contracted-service-row-${body.data.id}`);
    await expect(row).toContainText('Acompañante Terapéutico');
    await expect(page.getByTestId(`contracted-service-providers-${body.data.id}`)).toHaveText('2');
    await expect(page.getByTestId(`contracted-service-address-${body.data.id}`)).toContainText('CABA'); // o endereço do seed
    await expect(page.getByTestId(`contracted-service-schedule-${body.data.id}`)).toHaveText('Lunes 09:00-17:00');
    await expect(page.getByTestId(`contracted-service-address-missing-${body.data.id}`)).toHaveCount(0);

    // ── Clique real na linha → detalhe; "Editar" no detalhe → drawer SÓ deste serviço ──
    await row.click();
    await expect(page.getByTestId('contracted-service-detail-drawer')).toBeVisible();
    await expect(page.getByTestId('svc-detail-value')).toContainText('1500');
    await expect(page.getByTestId('svc-detail-schedule')).toContainText('Lunes 09:00-17:00');
    await page.getByTestId('contracted-service-detail-edit').click();
    await expect(page.getByTestId('contracted-service-detail-drawer')).not.toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible();
    await expect(page.getByTestId(`contracted-service-form-${body.data.id}`)).toBeVisible();
    await expect(page.getByTestId('svc-providersNeeded-1')).toHaveValue('2');
    await page.getByLabel('Cerrar').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).not.toBeVisible();

    // ── Lápis da linha → o mesmo drawer, direto ──
    await page.getByTestId(`contracted-service-edit-${body.data.id}`).click();
    await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible();
    await expect(page.getByTestId('contracted-service-detail-drawer')).toHaveCount(0);
    await page.getByLabel('Cerrar').click();
  });

  test('paciente SEM domicílio: o drawer diz isso em aviso âmbar na linha inteira, e o select fica desabilitado', async ({ page }) => {
    // `runSQL` devolve "id\nINSERT 0 1" num INSERT … RETURNING — só a 1ª linha é o id.
    const semEndereco = runSQL(`INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ('E2E-HUMANO-SEMDOM-${seed.stamp}', 'Humano', 'SinDomicilio', 'AR', 'PENDING_ADMISSION') RETURNING id`).split('\n')[0].trim();
    try {
      await loginComoHumano(page);
      await page.goto(`/admin/patients/${semEndereco}`);
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
      await page.getByTestId('new-service-btn').click();
      const aviso = page.getByTestId('svc-address-none-1');
      await expect(aviso).toBeVisible();
      await expect(aviso).toContainText('no tiene domicilio cargado');
      await expect(page.getByTestId('svc-addressId-1')).toBeDisabled();
      await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toHaveScreenshot('humano-sem-domicilio.png', {
        mask: [page.locator('.firebase-emulator-warning')],
      });
    } finally {
      cleanupPatientDeep(semEndereco);
    }
  });
});
