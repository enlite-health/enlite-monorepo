/**
 * Spec 061 — catálogo de atividades com TÍTULO + DESCRIÇÃO, do cadastro ao PDF — stack REAL (frontend + API com o
 * engine ABAC LIGADO + Postgres), zero mock de dado. Régua humana (memória `e2e-humano-nao-e-fill`): click +
 * `keyboard.type`, valor LIDO DA TELA, nunca `fill`. Molde: `projeto-terapeutico-humano` (PT/PDF) e
 * `pt-atividades-az-e-busca-060` (staff em grupo com células + escolha da atividade pela busca).
 *
 * O que se prova (3 testes em série):
 *   1. `/admin/catalogos/actividades`: SEM coluna "Orden"; "Nueva opción" digita título e descrição (contadores lidos),
 *      salva, a linha mostra os dois e o banco tem os dois; a lista é A–Z (o item "Aaa…" é a 1ª linha e a ordem inteira
 *      lida da tela bate com o Intl.Collator calculado AQUI);
 *   2. o PT de um paciente sintético usa esse item (criado pela UI; só o serviço contratado é semeado por SQL); a versão
 *      mostra título + descrição congelada e o PDF BAIXADO (pdf-parse) contém título E descrição;
 *   3. o catálogo é editado (nova descrição, só ela viaja no PATCH): a versão antiga e o PDF antigo mantêm o texto de antes.
 * O teste que MORRE sem a descrição no PDF/na versão: o 2 (e o 3 sem o congelamento).
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  psql, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';
import { escolherSegmento, primeiroSegmento } from '../helpers/pti-segmento-helper';
import { escolherNoCombo } from '../helpers/combobox';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
/** Só letras: sequência longa de dígitos é lida como documento/telefone e recusada (guarda de PII do servidor). */
const LETRAS = (): string => Math.random().toString(36).replace(/[0-9.]/g, '').slice(0, 8).padEnd(4, 'x');
const SUFIXO = LETRAS();
/** "Aaa" no começo: tem de ser a 1ª linha da lista A–Z (nenhum item do seed começa assim). */
const TITULO = `Aaa TITULO-SINTETICO-${SUFIXO}`;
const DESCRICAO = `DESCRIPCION-SINTETICA-${SUFIXO} original`;
const DESCRICAO_NOVA = `DESCRIPCION-SINTETICA-${SUFIXO} reescrita`;
const ROTA = '/admin/catalogos/actividades';

const RELEASE = `e061-${RUN_ID}`; // release PRÓPRIA (padrão do 048): '2026-01' corrente deixada aqui quebrava o 048 (índice "no máximo um corrente")
const ICD_URI = 'http://id.who.int/icd/entity/e2e-pt-061';
const CAP06_URI = 'http://id.who.int/icd/entity/e2e-pt-061-cap06';
const ICD_TITLE = 'Trastorno sintético de prueba 061';

const CELULAS: [string, string][] = [
  ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'], ['patient_therapeutic_project', 'create'], ['patient_therapeutic_project', 'export'],
  ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_family', 'read'], ['patient_family', 'write'],
  ['patient_care_team', 'read'], ['patient_services', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_identity', 'read'],
  ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'], ['catalog_therapeutic_segments', 'read'],
  ['catalog_therapeutic_activities', 'create'], ['catalog_therapeutic_activities', 'update'],
];

/** Sem espaço nenhum: o PDF quebra linha em hífen/espaço, e o pdf-parse devolve a quebra como espaço. */
const semEspaco = (s: string): string => s.replace(/\s+/g, '');

function seedIcd(): void {
  runSQL(`INSERT INTO terminology.icd_releases (release, entity_count, is_current, promoted_at, promoted_by) VALUES ('${RELEASE}', 1, true, now(), 'e2e-061') ON CONFLICT (release) DO UPDATE SET is_current = true, promoted_at = now(), promoted_by = 'e2e-061'`);
  runSQL(`INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) VALUES ('${ICD_URI}', '${RELEASE}', '6E61', '${ICD_TITLE}', 'Synthetic disorder 061', '06', NULL, 'stem', true) ON CONFLICT (icd_uri, release) DO NOTHING`);
  runSQL(`INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) SELECT '${CAP06_URI}', '${RELEASE}', '06', 'Trastornos mentales (e2e 061)', NULL, '06', NULL, 'chapter', false WHERE NOT EXISTS (SELECT 1 FROM terminology.icd_entities WHERE release = '${RELEASE}' AND kind = 'chapter' AND code = '06')`);
}
function cleanupIcd(): void {
  runSQL(`DELETE FROM terminology.icd_entities WHERE icd_uri IN ('${ICD_URI}', '${CAP06_URI}')`);
  runSQL(`DELETE FROM terminology.icd_releases WHERE release = '${RELEASE}'`);
}

/** Clica como um humano, digita, devolve o que a TELA mostra. */
async function digitar(page: Page, selector: string, texto: string): Promise<string> {
  const campo = page.locator(selector);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
}

/** Multi-select do DS: marca as N primeiras opções pelo mouse e fecha pelo gatilho (o Escape chegaria ao drawer). */
async function marcarOpcoes(page: Page, id: string, n: number): Promise<void> {
  const gatilhoDoCampo = page.locator(`#${id}`); // o `id` do Combobox é do GATILHO
  const root = gatilhoDoCampo.locator('..'); // o painel mora no pai do gatilho
  const gatilho = gatilhoDoCampo;
  await gatilho.click();
  const opcoes = root.locator('[role="option"] button');
  await expect(opcoes.first()).toBeVisible();
  for (let i = 0; i < n; i++) await opcoes.nth(i).click();
  await gatilho.click();
  await expect(gatilho).toHaveAttribute('aria-expanded', 'false');
}

/** Baixa o PDF da versão aberta no drawer e devolve o texto sem espaços. */
async function baixarPdf(page: Page): Promise<string> {
  const download = page.waitForEvent('download');
  await page.getByTestId('therapeutic-project-export-btn').click();
  const file = await download;
  const path = await file.path();
  return semEspaco((await pdfParse(readFileSync(path!))).text);
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on', acceptDownloads: true });

test.describe('spec 061 — atividade do catálogo com título + descrição: do cadastro ao PDF, e congelada na versão @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let staff: { user: MockUser; groupId: string };
  let itemId = '';
  let versaoId = '';

  test.beforeAll(() => {
    runSQL(`DELETE FROM therapeutic_activities WHERE label LIKE 'Aaa TITULO-SINTETICO-%'`); // sobra de rodada interrompida
    seed = seedActivatablePatient(760000); // faixa própria (as vizinhas: 700000-756000)
    runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-061', 'e2e-061')`);
    seedIcd();
    const uid = `e2e-pt061-${RUN_ID}`;
    const user: MockUser = { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };
    const { groupId } = seedStaffInGroup({ uid, email: user.email, groupName: `PT061 ${RUN_ID}`, country: 'AR' });
    psql(`UPDATE users SET display_name = 'E2E PT061' WHERE firebase_uid = '${uid}'`);
    for (const [resource, action] of CELULAS) grantCell(groupId, resource, action);
    staff = { user, groupId };
  });
  test.afterAll(() => {
    // A versão é IMUTÁVEL (trigger 416): só sai por CASCADE do paciente.
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    runSQL(`DELETE FROM therapeutic_activities WHERE label LIKE 'Aaa TITULO-SINTETICO-%'`);
    cleanupIcd();
    cleanupStaffAndGroup(staff.user.uid, staff.groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'PT061 ${RUN_ID}'`);
  });

  test('1. catálogo: sem coluna "Orden"; cria com título + descrição digitados; a linha mostra os dois; lista A–Z com o "Aaa…" na frente', async ({ page }) => {
    await loginAs(page, staff.user);
    await page.goto(ROTA);
    const table = page.getByTestId('therapeutic-catalog-table');
    await expect(table).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('columnheader', { name: 'Orden' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Título' })).toBeVisible();

    await page.getByTestId('therapeutic-catalog-new-btn').click();
    const modal = page.getByTestId('therapeutic-catalog-form-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('therapeutic-catalog-order-input')).toHaveCount(0);
    await expect(page.getByTestId('therapeutic-catalog-form-save')).toBeDisabled();

    expect(await digitar(page, '[data-testid="therapeutic-catalog-label-input"]', TITULO)).toBe(TITULO);
    await expect(page.getByTestId('therapeutic-catalog-label-count')).toContainText(`${TITULO.length}/150`);
    expect(await digitar(page, '[data-testid="therapeutic-catalog-description-input"]', DESCRICAO)).toBe(DESCRICAO);
    await expect(page.getByTestId('therapeutic-catalog-description-count')).toContainText(`${DESCRICAO.length}/1000`);

    const criado = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-catalogs\/activities$/.test(r.url()));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    const resp = await criado;
    expect(resp.status(), await resp.text()).toBe(201);
    const body = (await resp.json()) as { data: { id: string; label: string; description: string | null } };
    expect(body.data).toMatchObject({ label: TITULO, description: DESCRICAO });
    itemId = body.data.id;
    await expect(modal).toHaveCount(0);

    await expect(page.getByTestId(`therapeutic-catalog-label-${itemId}`)).toHaveText(TITULO);
    await expect(page.getByTestId(`therapeutic-catalog-description-${itemId}`)).toHaveText(DESCRICAO);
    expect(runSQL(`SELECT label || '|' || description FROM therapeutic_activities WHERE id = '${itemId}'`).trim()).toBe(`${TITULO}|${DESCRICAO}`);

    // A–Z: a ordem LIDA DA TELA bate com o critério do idioma calculado aqui, e o "Aaa…" é a 1ª linha.
    const naTela = (await table.locator('[data-testid^="therapeutic-catalog-label-"]').allTextContents()).map((s) => s.trim());
    expect(naTela.length).toBeGreaterThanOrEqual(9); // controle de não-vacuidade: seed + o criado
    const es = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
    expect(naTela).toEqual([...naTela].sort((a, b) => es.compare(a, b)));
    expect(naTela[0]).toBe(TITULO);
  });

  test('2. PT: o item entra na versão (criada pela UI); a visão mostra título + descrição e o PDF BAIXADO contém os dois', async ({ page }) => {
    expect(itemId).toMatch(/^[0-9a-f-]{36}$/);
    await loginAs(page, staff.user);
    await page.goto(`/admin/patients/${seed.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tp-new-btn')).toBeEnabled();
    await page.getByTestId('tp-new-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });

    await escolherNoCombo(page, page.getByTestId('tp-modality'), 'Presencial'); // IN_PERSON = Presencial
    await expect(page.getByTestId('tp-modality')).toContainText('Presencial');
    const segmento = primeiroSegmento();
    expect(await escolherSegmento(page, segmento.label)).toBe(segmento.label);
    const search = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()));
    await page.getByTestId('tp-icd-input').click();
    await page.keyboard.type('sintetico');
    expect((await search).status()).toBe(200);
    const opcaoCid = page.getByTestId('tp-icd-option-0');
    await expect(opcaoCid).toBeVisible({ timeout: 10_000 });
    await opcaoCid.click();
    await expect(page.getByTestId('tp-diagnosis-chip')).toHaveCount(1);
    expect(await digitar(page, '#tp-clinicalContext', 'Sintesis clinica digitada por humano 061')).toBe('Sintesis clinica digitada por humano 061');
    expect(await digitar(page, '#tp-generalObjective', 'Objetivo general digitado por humano 061')).toBe('Objetivo general digitado por humano 061');
    await marcarOpcoes(page, 'tp-specificObjectives', 1);

    // A atividade do catálogo é achada pela busca do campo (digitando) e marcada pelo mouse.
    const gatilho = page.locator('#tp-activities');
    await gatilho.click();
    const busca = page.getByTestId('tp-activities-search');
    await busca.click();
    await expect(busca).toBeFocused();
    await page.keyboard.type(`SINTETICO-${SUFIXO}`);
    const opcoes = page.locator('#tp-activities').locator('..').locator('[role="option"]');
    await expect(opcoes).toHaveCount(1);
    expect(((await opcoes.first().textContent()) ?? '').trim()).toContain(TITULO);
    await opcoes.first().locator('button').click();
    await expect(opcoes.first()).toHaveAttribute('aria-selected', 'true');
    await gatilho.click();
    await expect(gatilho).toHaveAttribute('aria-expanded', 'false');
    await expect(gatilho).toContainText(TITULO);

    await page.locator('#tp-startDate').click();
    await page.keyboard.type('09012026');
    await page.locator('#tp-endDate').click();
    await page.keyboard.type('12312026');
    await expect(page.locator('#tp-endDate')).toHaveValue('2026-12-31');
    await expect(page.getByTestId('tp-save')).toBeEnabled();

    const criada = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const resp = await criada;
    expect(resp.status(), await resp.text()).toBe(201);
    const body = (await resp.json()) as { data: { id: string; version: string; activities: Array<{ id: string; label: string; description?: string }> } };
    expect(body.data.version).toBe('V.1.0');
    expect(body.data.activities).toEqual([expect.objectContaining({ id: itemId, label: TITULO, description: DESCRICAO })]);
    versaoId = body.data.id;
    await page.getByTestId('therapeutic-project-close').click();
    await expect(drawer).toHaveCount(0);

    // A visão da versão mostra a descrição congelada (lida da tela) e o PDF baixado a contém.
    await page.getByTestId(`tp-view-${versaoId}`).click();
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId('tpv-activities')).toContainText(TITULO);
    await expect(drawer.getByTestId(`tpv-activities-description-${itemId}`)).toHaveText(DESCRICAO);
    const pdf = await baixarPdf(page);
    expect(pdf).toContain(semEspaco(TITULO));
    expect(pdf).toContain(semEspaco(DESCRICAO));
    expect(Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`))).toBe(1);
  });

  test('3. o catálogo muda (nova descrição, só ela no PATCH): a versão antiga e o PDF antigo mantêm o texto de antes', async ({ page }) => {
    expect(versaoId).toMatch(/^[0-9a-f-]{36}$/);
    await loginAs(page, staff.user);
    await page.goto(ROTA);
    await expect(page.getByTestId(`therapeutic-catalog-description-${itemId}`)).toHaveText(DESCRICAO, { timeout: 30_000 });
    await page.getByTestId(`therapeutic-catalog-edit-${itemId}`).click();
    const modal = page.getByTestId('therapeutic-catalog-form-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('therapeutic-catalog-label-input')).toHaveValue(TITULO);
    await expect(page.getByTestId('therapeutic-catalog-description-input')).toHaveValue(DESCRICAO);
    await expect(page.getByTestId('therapeutic-catalog-form-save')).toBeDisabled(); // edição sem mudança não salva

    const campo = page.getByTestId('therapeutic-catalog-description-input');
    await campo.click();
    await expect(campo).toBeFocused();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(DESCRICAO_NOVA);
    expect(await campo.inputValue()).toBe(DESCRICAO_NOVA);
    await expect(page.getByTestId('therapeutic-catalog-description-count')).toContainText(`${DESCRICAO_NOVA.length}/1000`);
    await expect(page.getByTestId('therapeutic-catalog-form-save')).toBeEnabled();
    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/therapeutic-catalogs/activities/${itemId}`));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    const resp = await patched;
    expect(resp.status(), await resp.text()).toBe(200);
    expect(Object.keys(resp.request().postDataJSON())).toEqual(['description']); // título intacto não viaja (Merge Patch)
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId(`therapeutic-catalog-description-${itemId}`)).toHaveText(DESCRICAO_NOVA);
    expect(runSQL(`SELECT description FROM therapeutic_activities WHERE id = '${itemId}'`).trim()).toBe(DESCRICAO_NOVA);

    // A versão ANTIGA (única) e o PDF dela seguem com o texto de antes.
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`tp-view-${versaoId}`).click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId(`tpv-activities-description-${itemId}`)).toHaveText(DESCRICAO);
    await expect(drawer).not.toContainText(DESCRICAO_NOVA);
    const pdf = await baixarPdf(page);
    expect(pdf).toContain(semEspaco(TITULO));
    expect(pdf).toContain(semEspaco(DESCRICAO));
    expect(pdf).not.toContain(semEspaco(DESCRICAO_NOVA));
    // E no banco a coluna jsonb da versão não foi reescrita.
    expect(runSQL(`SELECT activities->0->>'description' FROM patient_therapeutic_projects WHERE id = '${versaoId}'`).trim()).toBe(DESCRICAO);
  });
});
