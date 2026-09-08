/**
 * Spec 017 — Projeto Terapêutico: um HUMANO cria a V.1.0, edita (nasce a V.1.1, a V.1.0 continua
 * intacta), abre a versão antiga e exporta o PDF — stack REAL (frontend + API + Postgres + emulador),
 * zero mock de dado. Régua humana (D283/D287, memória `e2e-humano-nao-e-fill`): click + `keyboard.type`
 * + valor lido da TELA, nunca `fill`.
 *
 * O que se prova:
 *   1. o card existe na aba Datos Clínicos; sem serviço contratado ativo, "Nuevo" fica desabilitado;
 *   2. com serviço (criado pela UI do bloco C? — não: semeado por SQL, o fluxo do serviço já tem e2e
 *      próprio; aqui o objeto é o projeto), "Nuevo" abre a modal larga; o CID é escolhido pelo combobox
 *      real (catálogo `terminology` semeado com UMA entidade sintética); os 3 multi-selects têm o seed
 *      da migration 415 (8/13/8 opções); salvar → POST devolve V.1.0 e a tabela mostra;
 *   3. "Editar" → V.1.1: o banco tem DUAS linhas e a V.1.0 mantém o texto original (imutável, lex C5);
 *   4. a versão antiga abre em leitura e "Exportar PDF" busca `?purpose=export` (trilha C13) e baixa um
 *      `.pdf` cujo texto (pdf-parse) contém o nome do paciente e o objetivo — e NÃO contém "ICHOM";
 *   5. foto do card e da modal (`toHaveScreenshot`).
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';

const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.tp.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const ICD_URI = 'http://id.who.int/icd/entity/e2e-tp-017';
const ICD_TITLE = 'Trastorno sintético de prueba 017';

async function loginComoHumano(page: Page): Promise<void> {
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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Proyecto', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').click();
  await page.keyboard.type(STAFF_EMAIL);
  await page.locator('input[type="password"]').click();
  await page.keyboard.type(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}

/** Clica como um humano, digita, devolve o que a TELA mostra. */
async function digitar(page: Page, selector: string, texto: string): Promise<string> {
  const campo = page.locator(selector);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
}

/** Abre um multi-select do DS e marca as N primeiras opções pelo mouse. */
async function marcarOpcoes(page: Page, id: string, n: number): Promise<void> {
  const root = page.locator(`#${id}`);
  await root.locator('button[aria-haspopup="listbox"]').click();
  const opcoes = root.locator('[role="option"] button');
  await expect(opcoes.first()).toBeVisible();
  for (let i = 0; i < n; i++) await opcoes.nth(i).click();
  await page.keyboard.press('Escape');
}

/** O catálogo CID-11 do stack de integração é vazio: UMA entidade sintética, no release corrente. */
function seedIcd(): void {
  runSQL(`INSERT INTO terminology.icd_releases (release, entity_count, is_current, promoted_at, promoted_by) VALUES ('2026-01', 1, true, now(), 'e2e-017') ON CONFLICT (release) DO UPDATE SET is_current = true, promoted_at = now(), promoted_by = 'e2e-017'`);
  runSQL(`INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) VALUES ('${ICD_URI}', '2026-01', '6E2E', '${ICD_TITLE}', 'Synthetic disorder 017', '06', NULL, 'stem', true) ON CONFLICT (icd_uri, release) DO NOTHING`);
}
function cleanupIcd(): void {
  runSQL(`DELETE FROM terminology.icd_entities WHERE icd_uri = '${ICD_URI}'`);
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on', acceptDownloads: true });

test.describe('spec 017 — projeto terapêutico: um HUMANO cria, edita (minor), lê a antiga e exporta o PDF @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let serviceId: string;

  test.beforeAll(() => {
    seed = seedActivatablePatient(700000); // faixa própria (700000–789999)
    seedIcd();
  });
  test.afterAll(() => {
    // As versões são IMUTÁVEIS (trigger 416): só saem por CASCADE do paciente — e a versão aponta
    // para o serviço (FK sem cascade), então o serviço não pode sair antes. O purge real (D248) faz
    // o mesmo: apaga o pai. Depois, o helper limpa o que sobrar (idempotente).
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupIcd();
  });

  test('sem serviço contratado ativo, o card diz por quê e "Nuevo" fica desabilitado', async ({ page }) => {
    await loginComoHumano(page);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tp-empty')).toContainText('servicio contratado activo');
    await expect(page.getByTestId('tp-new-btn')).toBeDisabled();
    await expect(page.getByTestId('tp-edit-btn')).toHaveCount(0);
  });

  test('com serviço: Nuevo → V.1.0 (CID pelo combobox real, catálogos do seed); Editar → V.1.1 e a V.1.0 fica intacta; a antiga exporta PDF', async ({ page }) => {
    // O serviço contratado tem e2e humano próprio (bloco C); aqui ele é pré-condição, semeado direto.
    serviceId = runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-017', 'e2e-017') RETURNING id`).split('\n')[0].trim();
    expect(serviceId).toMatch(/^[0-9a-f-]{36}$/);

    await loginComoHumano(page);
    await page.goto(`/admin/patients/${seed.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tp-empty')).toContainText('todavía no tiene proyecto');
    await expect(page.getByTestId('tp-new-btn')).toBeEnabled();

    // ── Nuevo ──────────────────────────────────────────────────────────────────────────────
    await page.getByTestId('tp-new-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('therapeutic-project-subtitle')).toContainText('Nueva versión');
    // Modal LARGA, encostada à direita (como a de serviço contratado).
    await expect.poll(async () => { const b = await drawer.boundingBox(); return b ? Math.round(b.x + b.width) : 0; }).toBe(1600);
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tp-save')).toBeDisabled();
    await expect(page.getByTestId('tp-service')).toHaveValue(serviceId);

    // CID pelo combobox REAL: digita como humano, escolhe a opção.
    const search = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()));
    await page.getByTestId('tp-icd-input').click();
    await page.keyboard.type('sintetico');
    expect((await search).status()).toBe(200);
    const opcao = page.getByTestId('tp-icd-option-0');
    await expect(opcao).toBeVisible({ timeout: 10_000 });
    await expect(opcao).toContainText(ICD_TITLE);
    await opcao.click();
    await expect(page.getByTestId('tp-diagnosis-chip')).toHaveCount(1);
    // REQ-21: o código nunca aparece na tela.
    await expect(drawer).not.toContainText('6E2E');

    expect(await digitar(page, '#tp-clinicalContext', 'Sintesis clinica digitada por humano 017')).toBe('Sintesis clinica digitada por humano 017');
    expect(await digitar(page, '#tp-generalObjective', 'Objetivo general digitado por humano 017')).toBe('Objetivo general digitado por humano 017');
    await marcarOpcoes(page, 'tp-specificObjectives', 2);
    await marcarOpcoes(page, 'tp-activities', 3);
    await marcarOpcoes(page, 'tp-pathologyTypes', 1);
    // Datas: `type=date` recebe teclado no formato do locale do browser (mm/dd/yyyy em en-US).
    await page.locator('#tp-startDate').click();
    await page.keyboard.type('09012026');
    await page.locator('#tp-endDate').click();
    await page.keyboard.type('12312026');
    await expect(page.locator('#tp-endDate')).toHaveValue('2026-12-31');
    await expect(page.getByTestId('tp-save')).toBeEnabled();
    await expect(drawer).toHaveScreenshot('tp-drawer-nuevo-preenchido.png', { mask: [page.locator('.firebase-emulator-warning')], maxDiffPixelRatio: 0.02 });

    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const body = (await (await created).json()) as { data: { id: string; version: string; specificObjectives: unknown[]; activities: unknown[]; pathologyTypes: { label: string }[]; diagnoses: { title: string }[] } };
    expect(body.data.version).toBe('V.1.0');
    expect(body.data.specificObjectives).toHaveLength(2);
    expect(body.data.activities).toHaveLength(3);
    expect(body.data.pathologyTypes).toHaveLength(1);
    expect(body.data.diagnoses[0].title).toBe(ICD_TITLE);
    const v10 = body.data.id;

    // A modal vira "ver" da criada; fecha; o card mostra a V.1.0 no topo e na tabela.
    await expect(page.getByTestId('therapeutic-project-subtitle')).toContainText('V.1.0 - Creado por: E2E Proyecto');
    await page.getByTestId('therapeutic-project-close').click();
    await expect(drawer).toHaveCount(0); // desmonta depois da animação (300 ms) — só então o próximo clique
    await expect(page.getByTestId(`tp-row-${v10}`)).toContainText('V.1.0');
    await expect(card.getByTestId('tpv-objective-text')).toContainText('Objetivo general digitado por humano 017');
    await expect(card).toHaveScreenshot('tp-card-v1-0.png', { mask: [page.locator('.firebase-emulator-warning'), page.getByTestId(`tp-row-${v10}`).locator('td').nth(3), page.getByTestId(`tp-row-${v10}`).locator('td').nth(4)], maxDiffPixelRatio: 0.02 });

    // ── Editar → V.1.1 ─────────────────────────────────────────────────────────────────────
    await page.getByTestId('tp-edit-btn').click();
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('therapeutic-project-subtitle')).toContainText('V.1.0');
    await expect(page.locator('#tp-generalObjective')).toHaveValue('Objetivo general digitado por humano 017');
    await page.locator('#tp-generalObjective').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' — editado');
    const edited = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const body11 = (await (await edited).json()) as { data: { id: string; version: string; editedFromVersionId: string; generalObjective: string } };
    expect(body11.data.version).toBe('V.1.1');
    expect(body11.data.editedFromVersionId).toBe(v10);
    expect(body11.data.generalObjective).toBe('Objetivo general digitado por humano 017 — editado');
    await page.getByTestId('therapeutic-project-close').click();
    await expect(drawer).toHaveCount(0);

    // O banco tem DUAS linhas e a V.1.0 NÃO mudou (imutável, lex C5).
    const linhas = runSQL(`SELECT string_agg(major || '.' || minor || ':' || general_objective, '|' ORDER BY created_at) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`);
    expect(linhas).toBe('1.0:Objetivo general digitado por humano 017|1.1:Objetivo general digitado por humano 017 — editado');
    await expect(page.getByTestId(`tp-row-${body11.data.id}`)).toContainText('V.1.1');
    // A lista é por data de criação, mais recente primeiro.
    const versoes = await page.locator('[data-testid^="tp-row-"] td:nth-child(2)').allInnerTexts();
    expect(versoes).toEqual(['V.1.1', 'V.1.0']);

    // ── A antiga em leitura + Exportar PDF ─────────────────────────────────────────────────
    await page.getByTestId(`tp-view-${v10}`).click();
    await expect(page.getByTestId('therapeutic-project-drawer')).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId('tpv-objective-text')).toContainText('Objetivo general digitado por humano 017');
    await expect(drawer.getByTestId('tpv-objective-text')).not.toContainText('editado');
    const exportFetch = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes(`/therapeutic-projects/${v10}?purpose=export`));
    const download = page.waitForEvent('download');
    await page.getByTestId('therapeutic-project-export-btn').click();
    expect((await exportFetch).status()).toBe(200);
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^proyecto-terapeutico-caso-.*-V_1_0\.pdf$/);
    const path = await file.path();
    const parsed = await pdfParse(readFileSync(path!));
    const texto = parsed.text.replace(/\s+/g, ' ');
    expect(texto).toContain('Proyecto Terapéutico – EnLite Care');
    expect(texto).toContain(`BlocoC Servicio${seed.stamp}`);
    expect(texto).toContain('Objetivo general digitado por humano 017');
    expect(texto).toContain(ICD_TITLE);
    expect(texto).toContain('Versión V.1.0');
    expect(texto).not.toContain('ICHOM');
    expect(texto).not.toContain('6E2E');
    // lex C13: a trilha do export existe, com o UUID do paciente e sem texto.
    const trilha = runSQL(`SELECT count(*) FROM resource_access_log WHERE resource_id = '${seed.patientId}' AND action LIKE 'export_pdf:%'`);
    expect(Number(trilha)).toBeGreaterThanOrEqual(1);
  });
});
