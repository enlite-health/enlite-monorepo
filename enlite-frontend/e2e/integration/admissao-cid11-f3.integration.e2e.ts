/**
 * admissao-cid11-f3.integration.e2e.ts @integration — spec 016, F3 (front do diagnóstico CID-11).
 *
 * Front real (Vite 5173) + API real (docker enlite-api, `USE_MOCK_AUTH=true`) + Postgres real
 * (schema `terminology`, migrations até 325). Zero mock de DADO — só dado sintético.
 *
 * 🔴 Estratégia de auth medida nesta sessão, não copiada sem checar: o molde
 * `admission-b-campos.integration.e2e.ts` autentica via emulador REAL (Firebase sign-in), mas
 * `worker-functions/src/modules/identity/infrastructure/MockAuthMiddleware.ts:39-45` REJEITA
 * com 401 qualquer token que não comece com `mock_` sempre que `USE_MOCK_AUTH=true` (a config
 * atual do container `enlite-api`) — `app.use(mockAuthMiddleware)` roda ANTES do
 * `AuthMiddleware`, global, então nenhum token real do emulador alcança o Firebase Admin SDK.
 * Reproduzido na mão (`curl` com o idToken real do emulador → 401 "Invalid credentials") e
 * confirmado que o PRÓPRIO molde falha hoje pelo mesmo motivo (ver relatório-f3.md, achado
 * "auth real via emulador está quebrada"). Este spec usa o padrão DOCUMENTADO no
 * `enlite-frontend/CLAUDE.md` ("Estratégia de auth" — troca do header para `mock_<base64>`,
 * molde `full-create-vacancy.integration.e2e.ts`), que roda de ponta a ponta contra a MESMA API
 * e o MESMO Postgres — só a alegação de identidade é o bypass que o próprio backend oferece
 * para E2E; nenhum dado de diagnóstico é mockado.
 *
 * REQ-21 (`2026-08-26a#REQ-21`): o código do CID NUNCA aparece na tela — nem no chip, nem no
 * card, nem em atributo. A API só devolve `{ uri, title }`.
 *
 *  T1 — typo → acha → escolhe → salva (POST) → a ficha mostra a patología → Postgres tem a
 *       linha com o código certo (6A20, Esquizofrenia) — sincronizado pela RESPOSTA da requisição.
 *  T2 — assertion POSITIVA de que o código NÃO está no DOM — com CONTROLE que injeta o código e
 *       prova que a checagem tem poder de acusar.
 *  T3 — US-4: catálogo indisponível (503) mostra falha visível, distinta de "sem resultado".
 */
import { test, expect, type Page } from '@playwright/test';
import {
  seedPatientForDiagnosis, readPatientDiagnoses, setCatalogPromoted, isCatalogPromoted,
  cleanupPatientDeep, runSQL,
} from '../helpers/terminology-diagnosis-helper';

/** O código REAL de "Esquizofrenia" no release 2026-01 (medido no catálogo — F0/F1). Usado só
 * para a assertion NEGATIVA (T2) — nunca é o que a UI recebe ou exibe (REQ-21). */
const CODIGO_ESQUIZOFRENIA = '6A20';

// `E2E_FIREBASE_EMULATOR` aponta para o emulador de um stack isolado (`docker compose -p`); default inalterado.
const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.cid11f3.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';

/**
 * Auth REAL pelo emulador do Firebase — mesmo molde dos 5 e2e irmãos da admissão
 * (`admission-{a,b,c,d,a6}`), e NÃO o bypass `mock_*`.
 *
 * 🔴 Por que isto foi trocado: a primeira versão desta fase usou o bypass porque a regressão
 * parecia "estruturalmente quebrada". Não estava — o container `enlite-api` tinha sido recriado
 * com `USE_MOCK_AUTH=true` (o rebuild sem as 3 camadas de compose, exatamente o que o HANDOFF
 * avisa). Com o container correto (`USE_MOCK_AUTH=false`), o token `mock_*` é REJEITADO e este
 * e2e falhava: ou seja, o "2 passed" da primeira versão só valia no ambiente errado.
 * Teste que passa em ambiente diferente do CI não é evidência.
 */
async function loginAsAdmin(page: Page): Promise<void> {
  const signUp = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  // 2º teste reusa o mesmo e-mail: signUp devolve 400 EMAIL_EXISTS e caímos no signIn.
  // (Molde dos irmãos — omitir este fallback quebra o segundo teste do arquivo.)
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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E CID11 F3', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
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

test.describe('Spec 016 F3 — front do diagnóstico CID-11 @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let patient: { patientId: string; stamp: string };
  const wasPromotedBefore = isCatalogPromoted();

  test.beforeAll(() => {
    patient = seedPatientForDiagnosis();
    setCatalogPromoted(true); // pré-condição da F3: sem release corrente, TODA busca é 503 (US-4)
  });
  test.afterAll(() => {
    cleanupPatientDeep(patient.patientId);
    // Restaura o ambiente exatamente como o achamos — nunca deixar diferente por efeito colateral.
    setCatalogPromoted(wasPromotedBefore);
  });

  test('T1/T2 — typo acha o diagnóstico, escolhe, salva (POST), a ficha mostra a patología, Postgres grava o código; e o código NUNCA está no DOM', async ({ page }, testInfo) => {
    await loginAsAdmin(page);
    await openDetail(page, patient.patientId);

    await page.getByTestId('edit-clinical-btn').click();
    const drawer = page.getByTestId('patient-clinical-edit-drawer');
    await expect(drawer).toBeVisible();

    const searchInput = page.getByTestId('icd-search-input');
    await expect(searchInput).toBeVisible();
    // Cláusula 1.3 da licença OMS: atribuição visível junto da busca.
    await expect(page.getByTestId('who-attribution')).toContainText('Organización Mundial de la Salud');

    const searchResponse = page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()),
    );
    await searchInput.pressSequentially('esquisofrenia', { delay: 30 }); // erro de digitação deliberado (F0: flexisearch não corrige — a US-1 é NOSSA camada)
    const searchRes = await searchResponse;
    expect(searchRes.status()).toBe(200);

    const option0 = page.getByTestId('icd-search-option-0');
    await expect(option0).toBeVisible({ timeout: 10_000 });
    await expect(option0).toContainText('Esquizofrenia');

    await expect(drawer).toHaveScreenshot('cid11-f3-drawer-busca.png', { maxDiffPixelRatio: 0.06 });

    const createResponse = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/diagnoses$/.test(r.url()),
    );
    await option0.click(); // "escolhe" — o próprio clique dispara o POST ("salva")
    const createRes = await createResponse;
    expect(createRes.status()).toBe(201);

    await expect(page.getByTestId('diagnosis-chips')).toContainText('Esquizofrenia', { timeout: 10_000 });

    await expect(drawer).toHaveScreenshot('cid11-f3-drawer-chip.png', { maxDiffPixelRatio: 0.06 });

    // Fecha o drawer (X) — não passou pelo react-hook-form, então não há confirmação de descarte.
    await drawer.getByRole('button', { name: 'Cerrar' }).click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    // A ficha mostra a patología (o "onChanged" da seção já disparou o refetch).
    const card = page.getByTestId('diagnostico-card-patologias');
    await expect(card).toContainText('Esquizofrenia', { timeout: 20_000 });
    await expect(card).toHaveScreenshot('cid11-f3-card-diagnostico.png', { maxDiffPixelRatio: 0.06 });

    // ── Prova no Postgres: a linha existe com o CÓDIGO certo ──────────────────────────────
    const rows = readPatientDiagnoses(patient.patientId);
    testInfo.annotations.push({ type: 'evidência', description: `T1 — patient_diagnoses: ${JSON.stringify(rows)}` });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ conceptCode: CODIGO_ESQUIZOFRENIA, conceptTitle: 'Esquizofrenia', active: true, source: 'PANEL' });

    // ── REQ-21: assertion POSITIVA de que o código NÃO está no DOM (chip nem card) ────────
    const domContent = await page.content();
    expect(domContent).not.toContain(CODIGO_ESQUIZOFRENIA);
    expect(domContent).not.toContain(rows[0].conceptUri);
    testInfo.annotations.push({ type: 'evidência', description: `T2 — DOM não contém "${CODIGO_ESQUIZOFRENIA}" nem a URI do conceito (tamanho do DOM: ${domContent.length} chars)` });

    // ── Controle (prova que a checagem TEM PODER de acusar, não é régua morta) ────────────
    // Injeta o código real no DOM e confirma que a MESMA leitura (`page.content()`) o capturaria
    // — ou seja, se o código aparecesse de verdade na tela, a assertion acima teria reprovado.
    await page.evaluate((codigo) => {
      const poison = document.createElement('span');
      poison.setAttribute('data-e2e-control-poison', 'true');
      poison.textContent = codigo;
      document.body.appendChild(poison);
    }, CODIGO_ESQUIZOFRENIA);
    const poisonedContent = await page.content();
    expect(poisonedContent).toContain(CODIGO_ESQUIZOFRENIA); // controle: a checagem ACUSARIA se o código vazasse
    await page.evaluate(() => document.querySelector('[data-e2e-control-poison]')?.remove());
    const cleanedAgain = await page.content();
    expect(cleanedAgain).not.toContain(CODIGO_ESQUIZOFRENIA);
    testInfo.annotations.push({ type: 'evidência', description: 'T2 controle — page.content() ACUSOU o código injetado (régua viva), e voltou limpo após remover o poison' });
  });

  /**
   * T4 (06/09, Gabriel): "quando clico qual CID-11 eu quero, demora uns milissegundos para aparecer —
   * precisamos de um aviso de carregando para o usuário entender que NÃO TRAVOU" · "quando deleto uma
   * também precisa". Sem mock: a latência é emulada no NAVEGADOR (DevTools `Network.emulateNetworkConditions`),
   * o POST/PATCH vão para a API real e gravam no Postgres real. Com a rede lenta, o estado intermediário
   * fica visível o bastante para ser fotografado.
   */
  test('T4 — enquanto a API responde: chip "Agregando…" ao escolher e "Quitando…" ao remover (rede lenta emulada, sem mock)', async ({ page }, testInfo) => {
    await loginAsAdmin(page);
    await openDetail(page, patient.patientId);
    await page.getByTestId('edit-clinical-btn').click();
    const drawer = page.getByTestId('patient-clinical-edit-drawer');
    await expect(drawer).toBeVisible();

    const searchInput = page.getByTestId('icd-search-input');
    await searchInput.pressSequentially('trastorno esquizoafectivo', { delay: 20 });
    const option0 = page.getByTestId('icd-search-option-0');
    await expect(option0).toBeVisible({ timeout: 10_000 });
    const titulo = (await option0.textContent())?.trim() ?? '';
    expect(titulo.length).toBeGreaterThan(0);

    // Latência de 1,5 s por requisição — só no navegador; nada é interceptado nem respondido por nós.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });

    const createResponse = page.waitForResponse((r) => r.request().method() === 'POST' && /\/diagnoses$/.test(r.url()));
    await option0.click();
    const pending = page.getByTestId('diagnosis-chip-pending');
    await expect(pending).toBeVisible({ timeout: 5_000 });
    await expect(pending).toContainText(titulo);
    await expect(pending).toContainText('Agregando…');
    await expect(searchInput).toBeDisabled();
    await expect(page.getByTestId('diagnosis-chips')).toHaveScreenshot('cid11-f3-chip-agregando.png', { maxDiffPixelRatio: 0.06 });
    const createRes = await createResponse;
    expect(createRes.status()).toBe(201);
    await expect(pending).toHaveCount(0, { timeout: 10_000 });
    await expect(searchInput).not.toBeDisabled();
    const chipNovo = page.getByTestId('diagnosis-chips').locator('li', { hasText: titulo }).first();
    await expect(chipNovo).toBeVisible();
    const chipId = (await chipNovo.getAttribute('data-testid'))!.replace('diagnosis-chip-', '');

    // Remover com a mesma rede lenta: "Quitando…" no lugar dos botões, depois o chip some.
    await page.getByTestId(`diagnosis-chip-remove-${chipId}`).click();
    const patchResponse = page.waitForResponse((r) => r.request().method() === 'PATCH' && new RegExp(`/diagnoses/${chipId}$`).test(r.url()));
    await page.getByTestId(`diagnosis-chip-remove-confirm-btn-${chipId}`).click();
    const busy = page.getByTestId(`diagnosis-chip-busy-${chipId}`);
    await expect(busy).toBeVisible({ timeout: 5_000 });
    await expect(busy).toContainText('Quitando…');
    await expect(page.getByTestId(`diagnosis-chip-remove-${chipId}`)).toHaveCount(0);
    await expect(page.getByTestId('diagnosis-chips')).toHaveScreenshot('cid11-f3-chip-quitando.png', { maxDiffPixelRatio: 0.06 });
    expect((await patchResponse).status()).toBe(200);
    await expect(page.getByTestId(`diagnosis-chip-${chipId}`)).toHaveCount(0, { timeout: 10_000 });

    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await cdp.detach();

    const rows = readPatientDiagnoses(patient.patientId);
    testInfo.annotations.push({ type: 'evidência', description: `T4 — patient_diagnoses: ${JSON.stringify(rows)}` });
    const novo = rows.find((r) => r.conceptTitle === titulo);
    expect(novo).toBeDefined();
    expect(novo!.active).toBe(false); // gravado pelo POST real, desativado pelo PATCH real
    await drawer.getByRole('button', { name: 'Cerrar' }).click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
  });

  test('T3 — US-4: catálogo indisponível (503) mostra falha visível, DISTINTA de "sem resultado"', async ({ page }) => {
    setCatalogPromoted(false); // reproduz a pré-condição real: sem release corrente, TODA busca é 503
    await loginAsAdmin(page);
    await openDetail(page, patient.patientId);
    await page.getByTestId('edit-clinical-btn').click();
    const drawer = page.getByTestId('patient-clinical-edit-drawer');
    await expect(drawer).toBeVisible();

    const searchInput = page.getByTestId('icd-search-input');
    const searchResponse = page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()),
    );
    await searchInput.pressSequentially('esquizofrenia', { delay: 30 });
    const searchRes = await searchResponse;
    expect(searchRes.status()).toBe(503);

    const status = page.getByTestId('icd-search-status');
    await expect(status).toBeVisible({ timeout: 10_000 });
    await expect(status).toContainText('No pudimos conectar con el catálogo de diagnósticos');
    await expect(status).not.toContainText('No se encontraron resultados');
    await expect(page.getByTestId('icd-search-listbox')).toHaveCount(0);
    await expect(status).toHaveScreenshot('cid11-f3-catalogo-indisponivel.png', { maxDiffPixelRatio: 0.06 });

    await drawer.getByRole('button', { name: 'Cerrar' }).click();
    setCatalogPromoted(true); // devolve o estado que o T1 (e o afterAll) esperam
  });
});
