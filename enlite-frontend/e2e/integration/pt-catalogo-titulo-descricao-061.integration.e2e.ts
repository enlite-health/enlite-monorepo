/**
 * Spec 061 — catálogo de atividades com TÍTULO + DESCRIÇÃO, do cadastro ao PDF — stack REAL (frontend + API com o
 * engine ABAC LIGADO + Postgres), zero mock de dado. Régua humana (memória `e2e-humano-nao-e-fill`): click +
 * `keyboard.type`, valor LIDO DA TELA, nunca `fill`. Molde: `projeto-terapeutico-humano` (PT/PDF) e
 * `pt-atividades-az-e-busca-060` (staff em grupo com células + escolha da atividade pela busca).
 *
 * Spec 091: o "Nuevo" é em cascata (serviço → diagnóstico → objetivo → atividade); a atividade criada no catálogo ganha OBJETIVO (obrigatório) e
 * a ligação à categoria do diagnóstico entra por SQL (pré-condição, como o serviço contratado; o painel de CIE-11 tem e2e próprio).
 *
 * O que se prova (4 testes em série):
 *   1. `/admin/catalogos/actividades`: SEM coluna "Orden"; "Nueva opción" digita título e descrição (contadores lidos),
 *      salva, a linha mostra os dois e o banco tem os dois; a lista é A–Z (o item "Aaa…" é a 1ª linha e a ordem inteira
 *      lida da tela bate com o Intl.Collator calculado AQUI);
 *   2. o PT de um paciente sintético usa esse item (criado pela UI; só o serviço contratado é semeado por SQL); a versão
 *      mostra título + descrição congelada e o PDF BAIXADO (pdf-parse) contém título E descrição;
 *   3. o catálogo é editado (nova descrição, só ela viaja no PATCH): a versão antiga e o PDF antigo mantêm o texto de antes.
 *   4. DF-7: versão ANTIGA (formato plano, semeada por SQL) abre na visão com título + descrição congelados e o PDF baixado os contém, sem grupo
 *      por diagnóstico.
 * O teste que MORRE sem a descrição no PDF/na versão: o 2 (e o 3 sem o congelamento).
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  psql, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';
import { escolherNoCombo } from '../helpers/combobox';
import { CATEGORIA_NA_PLANILHA, primeiroPlano, escolherDiagnostico, marcar, semEspaco, semearCatalogoSintetico, type Plano } from '../helpers/pti-cascata-091';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
/** Só letras: sequência longa de dígitos é lida como documento/telefone e recusada (guarda de PII do servidor). */
const LETRAS = (): string => Math.random().toString(36).replace(/[0-9.]/g, '').slice(0, 8).padEnd(4, 'x');
const SUFIXO = LETRAS();
/** "Aaa" no começo: tem de ser a 1ª linha da lista A–Z (nenhum item do seed começa assim). */
const TITULO = `Aaa TITULO-SINTETICO-${SUFIXO}`;
const DESCRICAO = `DESCRIPCION-SINTETICA-${SUFIXO} original`;
const DESCRICAO_NOVA = `DESCRIPCION-SINTETICA-${SUFIXO} reescrita`;
const ROTA = '/admin/catalogos/actividades';

const RELEASE = 'E2E091-P61'; // release PRÓPRIA corrente sob o advisory lock (`is_current` é global)
const URI_BASE = 'test://e2e091p61';
const ICD_URI = `${URI_BASE}/${CATEGORIA_NA_PLANILHA}`;
const ICD_TITLE = 'Trastorno sintético de prueba 061';

const CELULAS: [string, string][] = [
  ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'], ['patient_therapeutic_project', 'create'], ['patient_therapeutic_project', 'export'],
  ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_family', 'read'], ['patient_family', 'write'],
  ['patient_care_team', 'read'], ['patient_services', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_identity', 'read'],
  ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'],
  ['catalog_therapeutic_activities', 'create'], ['catalog_therapeutic_activities', 'update'],
];

/** Clica como um humano, digita, devolve o que a TELA mostra. */
async function digitar(page: Page, selector: string, texto: string): Promise<string> {
  const campo = page.locator(selector);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
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
  let antigo: { patientId: string; addressId: string; stamp: string };
  let plano: Plano;
  let soltarCatalogo: () => void = () => undefined;

  test.beforeAll(async () => {
    runSQL(`DELETE FROM therapeutic_activities WHERE label LIKE 'Aaa TITULO-SINTETICO-%'`); // sobra de rodada interrompida
    seed = seedActivatablePatient(760000, { withDiagnosis: false }); // faixa própria (as vizinhas: 700000-756000)
    runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-061', 'e2e-061')`);
    antigo = seedActivatablePatient(761000, { withDiagnosis: false });
    runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${antigo.patientId}', 'CAREGIVER', 20, '${antigo.addressId}', 'e2e-061', 'e2e-061')`);
    soltarCatalogo = await semearCatalogoSintetico(RELEASE, URI_BASE, [{ code: CATEGORIA_NA_PLANILHA, title: ICD_TITLE }]);
    plano = primeiroPlano('CAREGIVER'); // objetivo da categoria no serviço do paciente (ids/títulos lidos do banco)
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
    runSQL(`DELETE FROM patients WHERE id = '${antigo.patientId}'`);
    cleanupPatientDeep(antigo.patientId);
    runSQL(`DELETE FROM therapeutic_activity_icd_categories WHERE activity_id IN (SELECT id FROM therapeutic_activities WHERE label LIKE 'Aaa TITULO-SINTETICO-%')`);
    runSQL(`DELETE FROM therapeutic_activities WHERE label LIKE 'Aaa TITULO-SINTETICO-%'`);
    soltarCatalogo();
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
    // 091: a atividade pertence a um OBJETIVO (obrigatório) — escolhido pelo teclado/mouse, valor lido da tela.
    await escolherNoCombo(page, page.getByTestId('therapeutic-catalog-objective-select'), plano.objetivo.label);
    await expect(page.getByTestId('therapeutic-catalog-form-save')).toBeDisabled(); // sem título o salvar segue travado

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
    expect(runSQL(`SELECT objective_id FROM therapeutic_activities WHERE id = '${itemId}'`).trim()).toBe(plano.objetivo.id);
    // Pré-condição do PT: a atividade nova entra na categoria do diagnóstico (a do objetivo já está ligada: FK composta).
    runSQL(`INSERT INTO therapeutic_activity_icd_categories (activity_id, objective_id, category_code, sort_order, created_by) VALUES ('${itemId}', '${plano.objetivo.id}', '${CATEGORIA_NA_PLANILHA}', 0, 'e2e-061')`);

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
    await escolherDiagnostico(page, ICD_TITLE, 'sintetico');
    expect(await digitar(page, '#tp-clinicalContext', 'Sintesis clinica digitada por humano 061')).toBe('Sintesis clinica digitada por humano 061');
    expect(await digitar(page, '#tp-generalObjective', 'Objetivo general digitado por humano 061')).toBe('Objetivo general digitado por humano 061');

    // Paso 3 e 4: o objetivo do plano e a atividade NOVA do catálogo (a ligação por categoria foi semeada no teste 1) — marcados pelo mouse.
    await marcar(page, `tp-obj-${ICD_URI}-${plano.objetivo.id}`);
    const atividade = page.getByTestId(`tp-act-${ICD_URI}-${plano.objetivo.id}-${itemId}`);
    await expect(page.getByTestId(`tp-activity-group-${ICD_URI}-${plano.objetivo.id}`)).toContainText(TITULO);
    await expect(page.locator('label', { has: atividade })).toContainText(DESCRICAO); // o Paso 4 mostra título + descrição
    await marcar(page, `tp-act-${ICD_URI}-${plano.objetivo.id}-${itemId}`);

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

    // A visão da versão mostra título + descrição congelados (lidos da tela) e o PDF baixado os contém.
    await page.getByTestId(`tp-view-${versaoId}`).click();
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId(`tpv-activities-item-${itemId}`)).toContainText(`${TITULO} — ${DESCRICAO}`);
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
    await expect(drawer.getByTestId(`tpv-activities-item-${itemId}`)).toContainText(`${TITULO} — ${DESCRICAO}`);
    await expect(drawer).not.toContainText(DESCRICAO_NOVA);
    const pdf = await baixarPdf(page);
    expect(pdf).toContain(semEspaco(TITULO));
    expect(pdf).toContain(semEspaco(DESCRICAO));
    expect(pdf).not.toContain(semEspaco(DESCRICAO_NOVA));
    // E no banco a coluna jsonb da versão não foi reescrita.
    expect(runSQL(`SELECT a->>'description' FROM patient_therapeutic_projects, jsonb_array_elements(diagnosis_plans) p, jsonb_array_elements(p->'activities') a WHERE id = '${versaoId}' AND a->>'id' = '${itemId}'`).trim()).toBe(DESCRICAO);
  });

  test('4. DF-7: versão ANTIGA (formato plano, por SQL) abre na visão com título + descrição congelados e o PDF baixado os contém, sem grupo por diagnóstico', async ({ page }) => {
    expect(itemId).toMatch(/^[0-9a-f-]{36}$/);
    const descricaoAntiga = `DESCRIPCION-ANTIGUA-${SUFIXO} plana`;
    const serviceId = runSQL(`SELECT id FROM patient_contracted_services WHERE patient_id = '${antigo.patientId}' LIMIT 1`).trim();
    const objetivo = runSQL(`SELECT jsonb_build_array(jsonb_build_object('id', id, 'label', label)) FROM therapeutic_specific_objectives WHERE id = '${plano.objetivo.id}'`).trim();
    const atividades = `[{"id":"${itemId}","label":"${TITULO}","description":"${descricaoAntiga}"}]`;
    const id = runSQL(`INSERT INTO patient_therapeutic_projects (patient_id, major, minor, contracted_service_id, modality, diagnoses, clinical_context, general_objective, specific_objectives, activities, pathology_types, start_date, end_date, created_by)
      VALUES ('${antigo.patientId}', 1, 0, '${serviceId}', 'IN_PERSON', '[{"uri":"http://id.who.int/icd/entity/e2e-061-antiga","title":"Diagnóstico sintético antiguo 061"}]', 'Contexto sintético 061', 'Objetivo sintético 061',
        '${objetivo}'::jsonb, '${atividades}'::jsonb, '[{"id":"06","label":"Capítulo 06 sintético 061"}]', '2026-09-01', '2026-12-31', 'e2e-061') RETURNING id`).split('\n')[0].trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    await loginAs(page, staff.user);
    await page.goto(`/admin/patients/${antigo.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`tp-view-${id}`).click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId('tpv-activities')).toContainText(TITULO);
    await expect(drawer.getByTestId(`tpv-activities-description-${itemId}`)).toHaveText(descricaoAntiga); // leitura do formato antigo
    await expect(drawer.getByTestId(`tpv-activities-group-${ICD_URI}`)).toHaveCount(0); // sem grupo por diagnóstico
    const pdf = await baixarPdf(page);
    expect(pdf).toContain(semEspaco(TITULO));
    expect(pdf).toContain(semEspaco(descricaoAntiga));
    expect(pdf).not.toContain(semEspaco('Diagnóstico: '));
  });
});
