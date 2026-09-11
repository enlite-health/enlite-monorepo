/**
 * admission-b-campos.integration.e2e.ts @integration — spec 012, bloco B.
 *
 * Front real (Vite 5173) + API real (docker enlite-api, rebuildada desta worktree) + Postgres real
 * (migrations 311-317). Auth REAL pelo emulador do Firebase. Zero mock de dado. Só dado sintético.
 *
 *  B7  — mudar o estado pela ficha com motivo (ACTIVE → ON_HOLD) e ver no Historial;
 *        transição proibida (ON_HOLD → REPLACEMENT) → mensagem traduzida (422 com código)
 *  B2  — criar domicílio NA FICHA (drawer com mapa + zona/corredor/acesso) e ativar sem sair dela
 *  B3  — gravar 2 coberturas verificadas por CÓDIGO do catálogo
 *  B4  — dispositivo HOME+SCHOOL pelo multi-select (escalar derivado pela 310)
 *  B5  — parentesco por select (enum da 139)
 *  B6/B9 — fecha de nacimiento no modal de criação; inicio del servicio no drawer geral
 *  B10 — o card do Kanban identifica o solicitante pelo nome (sem telefone)
 */
import { test, expect, type Page } from '@playwright/test';
import {
  seedActivePatient, seedAdmissionPatient, readPatientStatus, readHistoryTop, readAddresses, readInsuranceCodes,
  readDeviceTypes, readRelationship, readBirthAndServiceStart, findPatientIdByFirstName, countVacancies,
  cleanupPatientDeep, runSQL,
} from '../helpers/patient-detail-b-helper';
// ⚠️ O autocomplete do e2e é FAKE, e isso é requisito, não atalho: a PEND-06 da ata de
// 09/09/2026 manda reimplementar o campo "sem os testes automatizados que disparavam custo".
// Teste que bate no Places de verdade paga SKU por corrida do CI — foi o que levou o
// autocomplete a ser desligado da primeira vez.
//
// O fake usado aqui reproduz os GESTOS medidos contra o Google real em 10/09 (digitar não
// dispara nada; Enter sem seta devolve um toco só com `name`; seta+Enter e clique devolvem o
// place completo). O `google-maps-fake.ts` genérico NÃO serve a estes casos: ele dispara ao
// DIGITAR, o que faria "digitar sem escolher não grava" passar por acidente.
import { instalarFakeDeGestos, contarChamadasAoGoogle, CABA_CORRIENTES } from '../helpers/google-places-fake-gestos';

// `E2E_FIREBASE_EMULATOR` aponta para o emulador de um stack isolado (`docker compose -p`); default inalterado.
const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.blocob.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const NOTE = 'La obra social todavía no autorizó — nota e2e bloco B';

/** Auth REAL pelo emulador (molde: admission-a-bugs-dado.integration.e2e.ts). */
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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Bloco B', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

/** Abre a ficha e devolve o JSON REAL de GET /api/admin/patients/:id (contrato vivo). */
async function openDetail(page: Page, patientId: string): Promise<Record<string, any>> {
  const isDetail = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const detail = page
      .waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 })
      .catch(() => null);
    await page.goto(`/admin/patients/${patientId}`);
    const res = await detail;
    if (res) {
      try {
        return ((await res.json()) as { data: Record<string, any> }).data;
      } catch {
        // Corpo descartado por navegação concorrente (spec 014 D5: criar paciente abre a ficha
        // sozinho, e o `goto` acima interrompe esse GET). Mesma guarda do bloco A. Tenta de novo.
      }
    }
  }
  throw new Error(`GET /api/admin/patients/${patientId} não observado em 2 tentativas`);
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Spec 012 bloco B — os campos que faltam na ficha @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let active: { patientId: string; stamp: string };
  let admission: { patientId: string; stamp: string };
  let createdViaModalId = '';

  test.beforeAll(() => { active = seedActivePatient(); admission = seedAdmissionPatient(); });
  test.afterAll(() => {
    cleanupPatientDeep(active.patientId);
    cleanupPatientDeep(admission.patientId);
    cleanupPatientDeep(createdViaModalId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('B7 — mudar o estado pela ficha com motivo, ver no Historial; transição proibida → mensagem', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    const data = await openDetail(page, active.patientId);
    expect(data.admissionStatus).toBe('DONE');
    expect(data.status).toBe('ACTIVE');

    const control = page.getByTestId('patient-status-control');
    await expect(control).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('patient-status-select').selectOption('ON_HOLD');
    await page.getByTestId('patient-status-reason').selectOption('INSURER');
    const note = page.getByTestId('patient-status-note');
    expect(await note.evaluate((el) => el.closest('[data-clarity-mask="True"]') !== null)).toBe(true);
    await note.fill(NOTE);
    await expect(control).toHaveScreenshot('bloco-b-estado-en-espera.png', { maxDiffPixelRatio: 0.05 });
    await page.getByTestId('patient-status-save').click();
    await expect(page.getByTestId('patient-status-badge')).toHaveText('En espera', { timeout: 20_000 });
    await expect(page.getByTestId('patient-on-hold-reason')).toHaveText('Obra social');

    const db = readPatientStatus(active.patientId);
    testInfo.annotations.push({ type: 'evidência', description: `B7 — banco: ${JSON.stringify(db)} · history: ${JSON.stringify(readHistoryTop(active.patientId))}` });
    expect(db).toEqual({ status: 'ON_HOLD', admissionStatus: 'DONE', onHoldReason: 'INSURER', onHoldNote: NOTE });
    expect(readHistoryTop(active.patientId)).toEqual({ from: 'ACTIVE', to: 'ON_HOLD', source: 'admin_panel' });

    // Historial: quando / de → para / origem — sem ator, sem nota
    await page.getByRole('button', { name: /^Historial$/ }).click();
    const history = page.getByTestId('patient-status-history-card');
    await expect(history).toBeVisible();
    const row0 = page.getByTestId('status-history-row-0');
    await expect(row0).toContainText('Activo');
    await expect(row0).toContainText('En espera');
    await expect(row0).toContainText('Panel');
    expect(await history.textContent()).not.toContain(NOTE);
    await expect(history).toHaveScreenshot('bloco-b-historial.png', { maxDiffPixelRatio: 0.05 });

    // Transição PROIBIDA (ON_HOLD → REPLACEMENT não está na 315): 422 com código → mensagem traduzida
    await page.getByTestId('patient-status-select').selectOption('REPLACEMENT');
    const put = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/status$/.test(r.url()));
    await page.getByTestId('patient-status-save').click();
    expect((await put).status()).toBe(422);
    await expect(page.getByTestId('patient-status-error')).toHaveText('Transición no permitida: En espera → Reemplazo');
    await expect(page.getByTestId('patient-status-control')).toHaveScreenshot('bloco-b-transicion-prohibida.png', { maxDiffPixelRatio: 0.05 });
    expect(readPatientStatus(active.patientId).status).toBe('ON_HOLD');
  });

  test('B2 — criar domicílio na ficha (drawer com mapa + logística) e ativar sem sair dela', async ({ page }, testInfo) => {
    await instalarFakeDeGestos(page);
    await loginAsRealStaff(page);
    await openDetail(page, admission.patientId);
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Servicio Contratado/i }).click(); // spec 014: escopado — checklist de completude pode render chip com o mesmo texto
    const card = page.getByTestId('localizacoes-card');
    await expect(card).toContainText('Sin datos cargados');
    await page.getByTestId('new-address-btn').click();
    const drawer = page.getByTestId('patient-address-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('pad-map')).toBeVisible();

    // Gesto humano: o widget do Google escuta DIGITAÇÃO, não `value=`. `fill()` provaria
    // que o estado do React aceita uma string — não que a operadora consegue usar a tela.
    const campoEndereco = page.getByTestId('pad-address');
    await campoEndereco.click();
    await campoEndereco.pressSequentially('Av. Corrientes 1234', { delay: 60 });
    // Digitar não escolhe nada — a lista abre e só. É preciso o gesto de escolher.
    await expect(campoEndereco).toHaveValue('Av. Corrientes 1234');
    await campoEndereco.press('ArrowDown');
    await campoEndereco.press('Enter');
    // Escolhido: o campo passa a mostrar o endereço FORMATADO do Google, não o digitado.
    await expect(campoEndereco).toHaveValue(CABA_CORRIENTES.formatted_address, { timeout: 10_000 });

    await page.getByTestId('pad-type').selectOption('primary');
    await page.getByTestId('pad-neighborhood').fill('San Nicolás');
    await page.getByTestId('pad-corridor').fill('Corredor Norte');
    const access = page.getByTestId('pad-access');
    expect(await access.evaluate((el) => el.closest('[data-clarity-mask="True"]') !== null)).toBe(true);
    await access.fill('Timbre 3B, portero de 8 a 12');
    await expect(drawer).toHaveScreenshot('bloco-b-drawer-domicilio.png', { maxDiffPixelRatio: 0.08 });
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && /\/addresses$/.test(r.url()));
    await page.getByTestId('pad-save').click();
    expect((await post).status()).toBe(201);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    await expect(card).toContainText('Av. Corrientes 1234', { timeout: 20_000 });
    // Spec Localizaciones Fase 1 (T3): a Zona (`neighborhood`) é a única logística visível na
    // LISTA agora (linha 2 da Dirección) — Corredor logístico e Logística y acceso saíram das
    // colunas (ficam só dentro do drawer de edição). Continuam gravados: conferidos no banco
    // logo abaixo (`rows[0]`), não mais na tela.
    await expect(card).toContainText('San Nicolás');
    const rows = readAddresses(admission.patientId);
    testInfo.annotations.push({ type: 'evidência', description: `B2 — patient_addresses: ${JSON.stringify(rows)}` });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ neighborhood: 'San Nicolás', corridor: 'Corredor Norte', access: 'Timbre 3B, portero de 8 a 12', country: 'AR' });
    await expect(card).toHaveScreenshot('bloco-b-localizaciones.png', { maxDiffPixelRatio: 0.05 });

    // Ativar sem sair da ficha: 1 vaga borrador por endereço, ACTIVE / DONE
    await page.getByTestId('activate-patient-btn').click();
    await page.getByTestId('activate-confirm').click();
    await expect(page.getByTestId('patient-status-badge')).toHaveText('Activo', { timeout: 20_000 });
    await expect(page.getByTestId('activate-patient-btn')).toHaveCount(0);
    await expect(page.getByTestId('patient-status-control')).toBeVisible();
    const st = readPatientStatus(admission.patientId);
    expect(st).toMatchObject({ status: 'ACTIVE', admissionStatus: 'DONE' });
    expect(countVacancies(admission.patientId)).toBe(1);
  });

  // ── Caminhos alternativos do domicílio (escolha obrigatória, decisão de 10/09) ──────────
  // Os dois são recusas REAIS de gravação, medidas no banco — não "botão desabilitado".

  test('B2-alt1 — texto digitado à mão, sem escolher da lista, NÃO grava endereço', async ({ page }, testInfo) => {
    await instalarFakeDeGestos(page);
    await loginAsRealStaff(page);
    const alvo = seedAdmissionPatient();
    try {
      await openDetail(page, alvo.patientId);
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Servicio Contratado/i }).click();
      await page.getByTestId('new-address-btn').click();
      await expect(page.getByTestId('patient-address-drawer')).toBeVisible();

      // O gesto que de fato fura o portão: digitar o endereço INTEIRO e apertar Enter sem
      // descer na lista. Medido contra o Google real em 10/09 — dispara `place_changed` com
      // um place que só tem `name`. Antes do conserto, a tela resolvia a 1ª predição e
      // gravava um domicílio que ninguém viu, marcado como escolhido.
      const campo = page.getByTestId('pad-address');
      await campo.click();
      await campo.pressSequentially('Av. Corrientes 1234', { delay: 60 });
      await campo.press('Enter');
      await page.waitForTimeout(500);
      await page.getByTestId('pad-save').click();

      await expect(page.getByTestId('patient-address-drawer')).toBeVisible();
      await expect(page.getByTestId('patient-address-drawer')).toContainText(/lista de sugerencias|lista de sugestões/i);

      // A prova não é a mensagem na tela: é a ausência da linha no banco.
      const rows = readAddresses(alvo.patientId);
      const google = await contarChamadasAoGoogle(page);
      testInfo.annotations.push({ type: 'evidência', description: `B2-alt1 — patient_addresses: ${JSON.stringify(rows)} · chamadas ao Google: ${JSON.stringify(google)}` });
      expect(rows).toHaveLength(0);
      // Não é só "não gravou": a tela nem PERGUNTOU ao Google qual endereço seria. Adivinhar
      // aqui é fabricar domicílio de paciente.
      expect(google.predictions, 'nenhuma predição pedida no Enter sem escolha').toBe(0);
      expect(google.details, 'nenhum Place Details pedido no Enter sem escolha').toBe(0);
    } finally {
      cleanupPatientDeep(alvo.patientId);
    }
  });

  test('B2-alt2 — buscador do Google fora do ar: a tela AVISA e segue sem gravar', async ({ page }, testInfo) => {
    // A queda é encenada bloqueando o host do Google — nenhuma chamada real sai daqui.
    // Com escolha obrigatória, buscador morto significa que nenhum domicílio entra por esta
    // tela; o que não pode acontecer é a operadora não saber disso.
    await page.route('https://maps.googleapis.com/**', (r) => r.abort());
    await loginAsRealStaff(page);
    const alvo = seedAdmissionPatient();
    try {
      await openDetail(page, alvo.patientId);
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Servicio Contratado/i }).click();
      await page.getByTestId('new-address-btn').click();
      await expect(page.getByTestId('patient-address-drawer')).toBeVisible();

      await expect(page.getByTestId('pad-autocomplete-down')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('patient-address-drawer')).toHaveScreenshot('bloco-b-drawer-buscador-caido.png', { maxDiffPixelRatio: 0.08 });

      const campo = page.getByTestId('pad-address');
      await campo.click();
      await campo.pressSequentially('Av. Corrientes 1234', { delay: 40 });
      await page.getByTestId('pad-save').click();

      const rows = readAddresses(alvo.patientId);
      testInfo.annotations.push({ type: 'evidência', description: `B2-alt2 — patient_addresses com o buscador caído: ${JSON.stringify(rows)}` });
      expect(rows).toHaveLength(0);
    } finally {
      cleanupPatientDeep(alvo.patientId);
    }
  });

  test('B3 — duas coberturas verificadas por código do catálogo', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    await openDetail(page, active.patientId);
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Servicio Contratado/i }).click(); // spec 014: escopado — checklist de completude pode render chip com o mesmo texto
    await page.getByTestId('edit-coverage-btn').click();
    const drawer = page.getByTestId('patient-coverage-edit-drawer');
    await expect(drawer).toBeVisible();
    await page.locator('#pcv-codes button').first().click();
    await page.locator('#pcv-codes').getByRole('option', { name: 'OSDE', exact: true }).click();
    await page.locator('#pcv-codes').getByRole('option', { name: 'Swiss Medical', exact: true }).click();
    await page.getByTestId('pcv-affiliate').fill('AF-B3-0001');
    await expect(page.getByTestId('pcv-codes-selected')).toContainText('Swiss Medical');
    await page.getByTestId('pcv-save').click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    const card = page.getByTestId('cobertura-medica-card');
    await expect(page.getByTestId('coverage-verified')).toContainText('OSDE, Swiss Medical', { timeout: 20_000 });
    await expect(card).toContainText('AF-B3-0001');
    const codes = readInsuranceCodes(active.patientId);
    testInfo.annotations.push({ type: 'evidência', description: `B3 — patient_insurance_verified: ${JSON.stringify(codes)}` });
    expect(codes).toEqual(['OSDE:admin_manual', 'SWISS_MEDICAL:admin_manual']);
    await expect(card).toHaveScreenshot('bloco-b-cobertura.png', { maxDiffPixelRatio: 0.05 });
  });

  test('B4/B8 — dispositivo HOME+SCHOOL pelo multi-select; especialidade não existe mais no card nem no drawer', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    await openDetail(page, active.patientId);
    const card = page.locator('text=Diagnóstico').locator('xpath=ancestor::div[contains(@class,"rounded-card")]').first();
    await expect(card).not.toContainText('ICHOM');
    await expect(card).not.toContainText('Especialidad');
    await page.getByTestId('edit-clinical-btn').click();
    const drawer = page.getByTestId('patient-clinical-edit-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('pce-specialty')).toHaveCount(0);
    await page.locator('#pce-device button').first().click();
    await page.locator('#pce-device').getByRole('option', { name: 'Domiciliario', exact: true }).click();
    await page.locator('#pce-device').getByRole('option', { name: 'Escolar', exact: true }).click();
    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/clinical$/.test(r.url()));
    await page.getByTestId('pce-save').click();
    expect((await patch).status()).toBe(200);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    // 07/09: o Dispositivo virou CHIP, um por valor (`DeviceChips`) — em chip a lista se lê sem
    // vírgula, então o `', '` do `devices.join(', ')` anterior não existe mais no DOM. A prova é a
    // mesma (os dois dispositivos aparecem no cartão depois de salvar), agora por ELEMENTO em vez
    // de por string concatenada — que é o que sobrevive a mudança de peça.
    await expect(card.getByText('Domiciliario', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText('Escolar', { exact: true })).toBeVisible();
    const dev = readDeviceTypes(active.patientId);
    testInfo.annotations.push({ type: 'evidência', description: `B4 — patient_device_types: ${JSON.stringify(dev)}` });
    expect(dev).toEqual({ set: ['HOME', 'SCHOOL'], scalar: 'HOME' });
    await expect(card).toHaveScreenshot('bloco-b-diagnostico-dispositivo.png', { maxDiffPixelRatio: 0.05 });
  });

  test('B5 — parentesco por select (enum da 139)', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    await openDetail(page, active.patientId);
    await page.getByRole('button', { name: /Red de Apoyo/i }).click();
    await page.getByTestId('edit-support-btn').click();
    const rel = page.getByTestId('psn-rel-0');
    await expect(rel).toHaveValue('OTHER');
    expect(await rel.evaluate((el) => (el as HTMLSelectElement).tagName)).toBe('SELECT');
    await rel.selectOption('PARENT');
    await page.getByTestId('psn-save').click();
    await expect(page.getByTestId('patient-support-edit-drawer')).toHaveCount(0, { timeout: 15_000 });
    const card = page.getByTestId('familiares-card');
    await expect(card).toContainText('Madre / Padre', { timeout: 20_000 });
    testInfo.annotations.push({ type: 'evidência', description: `B5 — relationship: ${readRelationship(active.patientId)}` });
    expect(readRelationship(active.patientId)).toBe('PARENT');
    await expect(card).toHaveScreenshot('bloco-b-familiares.png', { maxDiffPixelRatio: 0.05 });
  });

  test('B6/B9 — fecha de nacimiento no modal de criação; inicio del servicio no drawer geral', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    const stamp = Date.now().toString().slice(-6);
    const firstName = `NuevoBlocoB${stamp}`;
    await page.goto('/admin/patients');
    await page.getByTestId('new-patient-btn').click();
    await expect(page.getByTestId('patient-create-modal')).toBeVisible();
    await page.getByTestId('pc-firstName').fill(firstName);
    await page.getByTestId('pc-lastName').fill('Modal');
    await page.getByTestId('pc-birthDate').fill('2015-06-20');
    await page.getByTestId('pc-phone').fill('+5491100000031');
    await page.getByTestId('pc-save').click();
    await expect(page.getByTestId('patient-create-modal')).toHaveCount(0, { timeout: 15_000 });
    createdViaModalId = findPatientIdByFirstName(firstName);
    expect(createdViaModalId).toMatch(/^[0-9a-f-]{36}$/);

    await openDetail(page, createdViaModalId);
    await page.getByTestId('edit-general-btn').click();
    await page.getByTestId('pge-serviceStartDate').fill('2026-09-15');
    await page.getByTestId('pge-save').click();
    await expect(page.getByTestId('patient-general-edit-drawer')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('text=Inicio del servicio').first()).toBeVisible();
    const dates = readBirthAndServiceStart(createdViaModalId);
    testInfo.annotations.push({ type: 'evidência', description: `B6/B9 — ${JSON.stringify(dates)}` });
    expect(dates).toEqual({ birthDate: '2015-06-20', serviceStartDate: '2026-09-15' });
  });

  test('B10 — o card do Kanban identifica o solicitante pelo nome, sem telefone', async ({ page }) => {
    await loginAsRealStaff(page);
    await page.goto('/admin/patients/kanban');
    const card = page.getByTestId(`patient-kanban-card-${createdViaModalId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).not.toContainText('Solicitante');
    await expect(card).toContainText('Modal');
    expect(await card.textContent()).not.toMatch(/\+\d{8,}|\d[\d\s-]{9,}\d/);
    await expect(card).toHaveScreenshot('bloco-b-kanban-card.png', { maxDiffPixelRatio: 0.05 });
  });
});
