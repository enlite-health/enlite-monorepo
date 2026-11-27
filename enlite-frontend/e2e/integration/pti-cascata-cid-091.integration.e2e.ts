/**
 * Spec 091 (CA-14, §9.8/§9.11) — formulário em cascata do Projeto Terapêutico por um HUMANO contra o stack REAL (frontend + API +
 * Postgres), sem interceptar dado na rede. Régua humana (memória `e2e-humano-nao-e-fill`): click + `keyboard.type` + valor lido da TELA;
 * o banco confirma depois. O login é o do mock do CI (`loginComoStaffMock`, engine ABAC OFF).
 *
 * Dado: o catálogo da planilha (587) já está no banco. A terminologia é semeada por SQL (helper `catalogo-cid-091-seed`, sob o advisory
 * lock do release corrente) com 2 stems: `2A00` = categoria PRESENTE na planilha (conferida com `jq` no `catalogo-cid.normalizado.json`:
 * 6 objetivos AT e 6 CAREGIVER) e `ZE91` = AUSENTE do JSON (0 objetivos com essa categoria). Os títulos de objetivo/atividade vêm do
 * banco (quem lê é a cascata real), nunca de fixture. Paciente sintético com 2 serviços contratados (AT e CAREGIVER).
 *
 *   1. feliz: Nuevo → AT → diagnóstico 2A00 → 1 objetivo → 1 atividade → salvar → o card mostra o objetivo e a visão o bloco do
 *      diagnóstico; o PDF baixado contém o título do objetivo;
 *   2. alt 1: diagnóstico ZE91 → "sin catálogo" (nenhuma escolha) e a versão salva mesmo assim;
 *   3. alt 2: com seleção feita, trocar para CAREGIVER → nada marcado e os títulos passam a ser os de Cuidado.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { seedActivatablePatient, runSQL } from '../helpers/patient-detail-c-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';
import { escolherNoCombo } from '../helpers/combobox';
import { travarReleaseCorrente, semearRelease, restaurarRelease } from '../helpers/catalogo-cid-091-seed';
import { CATEGORIA_NA_PLANILHA, SERVICO_AT, SERVICO_CUIDADOR, semEspaco, primeiroPlano, escolherServico, escolherDiagnostico, abrirBloco, marcar } from '../helpers/pti-cascata-091';

const STAMP = Date.now().toString(36);
const STAFF: MockUser = { uid: `e2e-pti091-${Date.now()}`, email: `e2e.pti091.${Date.now()}@enlite.health`, role: 'admin', country: 'AR' };
const RELEASE = 'E2E091-PTI';
const URI_BASE = 'test://e2e091pti';
const CAT_NA_PLANILHA = CATEGORIA_NA_PLANILHA;
const CAT_FORA_DA_PLANILHA = 'ZE91';
const TITULO_COM_CATALOGO = 'Trastorno sintetico cascada 091';
const TITULO_SEM_CATALOGO = 'Trastorno sintetico ausente 091';
const URI_COM = `${URI_BASE}/${CAT_NA_PLANILHA}`;
const URI_SEM = `${URI_BASE}/${CAT_FORA_DA_PLANILHA}`;

async function entrar(page: Page): Promise<void> {
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${STAFF.uid}', '${STAFF.email}', 'E2E Pti091', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await loginComoStaffMock(page, STAFF, 'E2E Pti091');
}

function semearPaciente(faixa: number): { patientId: string; addressId: string } {
  const seed = seedActivatablePatient(faixa, { withDiagnosis: false }); // o form pré-preenche os diagnósticos ativos: o humano os escolhe pela busca
  for (const [servico, horas] of [['AT', 10], ['CAREGIVER', 20]] as const) {
    runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', '${servico}', ${horas}, '${seed.addressId}', 'e2e-pti091', 'e2e-pti091')`);
  }
  return seed;
}

async function digitar(page: Page, selector: string, texto: string): Promise<string> {
  const campo = page.locator(selector);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
}

/** Abre o drawer "Nuevo", escolhe o serviço pelo rótulo e o diagnóstico pela busca (digitando). */
async function abrirNuevo(page: Page, patientId: string, servico: string, tituloDiagnostico: string, busca: string): Promise<void> {
  await entrar(page);
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('tp-new-btn')).toBeEnabled();
  await page.getByTestId('tp-new-btn').click();
  await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
  await escolherServico(page, servico);
  await escolherDiagnostico(page, tituloDiagnostico, busca);
}

async function preencherRestoEDatas(page: Page): Promise<void> {
  await escolherNoCombo(page, page.getByTestId('tp-modality'), 'Presencial');
  expect(await digitar(page, '#tp-clinicalContext', 'Sintesis clinica digitada por humano 091')).toBe('Sintesis clinica digitada por humano 091');
  expect(await digitar(page, '#tp-generalObjective', 'Objetivo general digitado por humano 091')).toBe('Objetivo general digitado por humano 091');
  await page.locator('#tp-startDate').click();
  await page.keyboard.type('09012026');
  await page.locator('#tp-endDate').click();
  await page.keyboard.type('12312026');
  await expect(page.locator('#tp-endDate')).toHaveValue('2026-12-31');
}

async function baixarPdf(page: Page): Promise<string> {
  const download = page.waitForEvent('download');
  await page.getByTestId('therapeutic-project-export-btn').click();
  const file = await download;
  const path = await file.path();
  return semEspaco((await pdfParse(readFileSync(path!))).text);
}

test.use({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });

test.describe('spec 091 — formulário em cascata do PTI: um HUMANO escolhe serviço → diagnóstico → objetivo → atividade @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let soltarLock: () => void = () => undefined;
  let releaseAnterior = '';
  let pacienteA: { patientId: string; addressId: string };
  let pacienteB: { patientId: string; addressId: string };

  test.beforeAll(async () => {
    soltarLock = await travarReleaseCorrente();
    try {
      restaurarRelease(RELEASE, ''); // sobra de rodada interrompida (sem reativar nada)
      releaseAnterior = semearRelease(RELEASE, URI_BASE, [
        { code: CAT_NA_PLANILHA, title: TITULO_COM_CATALOGO },
        { code: CAT_FORA_DA_PLANILHA, title: TITULO_SEM_CATALOGO },
      ]);
      pacienteA = semearPaciente(770000);
      pacienteB = semearPaciente(772000);
      // controle de não-vacuidade: a categoria da planilha tem catálogo nos DOIS serviços e a ausente não tem nenhum vínculo
      for (const s of ['AT', 'CAREGIVER']) {
        expect(Number(runSQL(`SELECT count(*) FROM therapeutic_objective_icd_categories l JOIN therapeutic_specific_objectives o ON o.id = l.objective_id WHERE o.service_code = '${s}' AND l.category_code = '${CAT_NA_PLANILHA}'`))).toBeGreaterThan(0);
      }
      expect(Number(runSQL(`SELECT count(*) FROM therapeutic_objective_icd_categories WHERE category_code = '${CAT_FORA_DA_PLANILHA}'`))).toBe(0);
    } catch (e) {
      soltarLock();
      throw e;
    }
  });

  test.afterAll(() => {
    try {
      // A versão é IMUTÁVEL (trigger): só sai por CASCADE do paciente — apagar o PACIENTE primeiro.
      for (const p of [pacienteA, pacienteB]) {
        if (!p) continue;
        runSQL(`DELETE FROM patients WHERE id = '${p.patientId}'`);
        runSQL(`DELETE FROM patient_contracted_services WHERE patient_id = '${p.patientId}'`);
        runSQL(`DELETE FROM patient_addresses WHERE patient_id = '${p.patientId}'`);
      }
      restaurarRelease(RELEASE, releaseAnterior);
      runSQL(`DELETE FROM users WHERE email = '${STAFF.email}'`);
    } finally {
      soltarLock();
    }
  });

  test('feliz: Nuevo → AT → diagnóstico da planilha → 1 objetivo → 1 atividade → salvar; o card mostra o objetivo, a visão o bloco e o PDF baixado o título', async ({ page }) => {
    const { objetivo, atividade } = primeiroPlano('AT', CAT_NA_PLANILHA);
    expect(objetivo.label.length).toBeGreaterThan(0); // controle de não-vacuidade: o plano veio do banco
    await abrirNuevo(page, pacienteA.patientId, SERVICO_AT, TITULO_COM_CATALOGO, 'cascada 091');

    // Os 4 passos estão na tela e o bloco do diagnóstico nasce SEM seleção (DD-13).
    await expect(page.getByText('Paso 1 · Servicio')).toBeVisible();
    await expect(page.getByText('Paso 2 · Diagnósticos')).toBeVisible();
    const bloco = page.getByTestId(`tp-block-${URI_COM}`);
    await expect(bloco).toBeVisible();
    await expect(page.getByTestId(`tp-block-title-${URI_COM}`)).toHaveText(TITULO_COM_CATALOGO);
    // 099: Paso 3 único ("Objetivos y actividades"), o 1º acordeão nasce aberto, a pílula diz "Sin elegir" e nada vem marcado (DD-13).
    await expect(page.getByTestId('tp-step-objectives-title')).toHaveText('Paso 3 · Objetivos y actividades');
    await expect(page.getByTestId(`tp-block-toggle-${URI_COM}`)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId(`tp-block-pill-${URI_COM}`)).toHaveText('Sin elegir');
    await expect(page.getByTestId(`tp-obj-${URI_COM}-${objetivo.id}`)).toHaveAttribute('aria-pressed', 'false');
    await expect(bloco.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(page.getByTestId(`tp-activity-group-${URI_COM}-${objetivo.id}`)).toHaveCount(0); // as atividades só aparecem dentro do objetivo marcado
    await expect(page.getByTestId('tp-progress-footer')).toHaveText('0 de 1 diagnósticos con catálogo completos');
    await expect(page.getByTestId('tp-save')).toBeDisabled();

    await abrirBloco(page, URI_COM);
    await marcar(page, `tp-obj-${URI_COM}-${objetivo.id}`);
    await expect(page.getByTestId(`tp-block-pill-${URI_COM}`)).toHaveText('Falta una actividad');
    await expect(page.getByTestId(`tp-obj-${URI_COM}-${objetivo.id}`)).toContainText(objetivo.label);
    await expect(page.getByTestId(`tp-activity-group-${URI_COM}-${objetivo.id}`)).toContainText('Actividades de este objetivo');
    await marcar(page, `tp-act-${URI_COM}-${objetivo.id}-${atividade.id}`);
    await expect(page.getByTestId(`tp-block-pill-${URI_COM}`)).toHaveText('Completo');
    await expect(page.getByTestId('tp-progress-footer')).toHaveText('1 de 1 diagnósticos con catálogo completos');
    await preencherRestoEDatas(page);
    await expect(page.getByTestId('tp-save')).toBeEnabled();

    const criada = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const resp = await criada;
    expect(resp.status(), await resp.text()).toBe(201);
    const body = (await resp.json()) as { data: { id: string; version: string } };
    expect(body.data.version).toBe('V.1.0');
    await page.getByTestId('therapeutic-project-close').click();
    await expect(page.getByTestId('therapeutic-project-drawer')).toHaveCount(0);

    // O card (resumo compacto) mostra o objetivo escolhido; a visão (drawer) mostra o BLOCO do diagnóstico e o PDF baixado, o título.
    await expect(page.getByTestId('tp-current')).toContainText(objetivo.label);
    await page.getByTestId(`tp-view-${body.data.id}`).click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId(`tpv-specific-group-${URI_COM}`)).toContainText(objetivo.label);
    await expect(drawer.getByTestId(`tpv-specific-item-${objetivo.id}`)).toBeVisible();
    await expect(drawer.getByTestId(`tpv-activities-item-${atividade.id}`)).toContainText(atividade.label);
    const pdf = await baixarPdf(page);
    expect(pdf).toContain(semEspaco(objetivo.label));
    expect(pdf).toContain(semEspaco(atividade.label));
    expect(Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${pacienteA.patientId}'`))).toBe(1);
  });

  test('alt 1: diagnóstico ausente da planilha → "sin catálogo", nenhuma escolha, e a versão salva', async ({ page }) => {
    await abrirNuevo(page, pacienteB.patientId, SERVICO_AT, TITULO_SEM_CATALOGO, 'ausente 091');
    const bloco = page.getByTestId(`tp-block-${URI_SEM}`);
    await expect(bloco).toBeVisible();
    await expect(bloco).toHaveAttribute('data-status', /no_catalog|no_category/);
    await expect(page.getByTestId(`tp-no-catalog-${URI_SEM}`)).toHaveText('No hay catálogo para este diagnóstico y servicio. Usá Objetivo general y Contexto clínico.');
    await expect(page.getByTestId(`tp-block-pill-${URI_SEM}`)).toHaveText('Sin catálogo');
    await expect(bloco.locator('[aria-pressed]')).toHaveCount(0); // nenhum objetivo/atividade para escolher
    await preencherRestoEDatas(page);
    await expect(page.getByTestId('tp-save')).toBeEnabled();

    const criada = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const resp = await criada;
    expect(resp.status(), await resp.text()).toBe(201);
    const body = (await resp.json()) as { data: { id: string; version: string } };
    expect(body.data.version).toBe('V.1.0');
    await page.getByTestId('therapeutic-project-close').click();
    await expect(page.getByTestId('therapeutic-project-drawer')).toHaveCount(0);
    await page.getByTestId(`tp-view-${body.data.id}`).click();
    await expect(page.getByTestId('therapeutic-project-drawer').getByTestId(`tpv-specific-empty-${URI_SEM}`)).toContainText('Sin catálogo para este diagnóstico y servicio al');
    expect(Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${pacienteB.patientId}'`))).toBe(1);
  });

  test('alt 2: com seleção feita, trocar para CAREGIVER → nada marcado e os títulos são os de Cuidado', async ({ page }) => {
    const at = primeiroPlano('AT', CAT_NA_PLANILHA);
    const cuidado = primeiroPlano('CAREGIVER', CAT_NA_PLANILHA);
    expect(cuidado.objetivo.label).not.toBe(at.objetivo.label); // controle de não-vacuidade: os dois serviços têm títulos diferentes
    await abrirNuevo(page, pacienteB.patientId, SERVICO_AT, TITULO_COM_CATALOGO, 'cascada 091');
    await abrirBloco(page, URI_COM);
    await marcar(page, `tp-obj-${URI_COM}-${at.objetivo.id}`);
    await marcar(page, `tp-act-${URI_COM}-${at.objetivo.id}-${at.atividade.id}`);
    await expect(page.getByTestId(`tp-objectives-${URI_COM}`)).toContainText(at.objetivo.label);

    // Observação (só leitura, nenhum gesto): o bloco do diagnóstico SAI do DOM ao trocar o serviço, antes de a nova resposta chegar (DF-6, "zera"),
    // em vez de ficar na tela com os objetivos do serviço antigo. Sem isto a troca só é visível no estado final, que a poda por id também produz.
    await page.evaluate((seletor) => {
      const w = window as unknown as Record<string, boolean>;
      w.__blocoSaiu091 = false;
      new MutationObserver((muts) => {
        for (const m of muts) m.removedNodes.forEach((n) => { if (n instanceof Element && (n.matches(seletor) || n.querySelector(seletor))) w.__blocoSaiu091 = true; });
      }).observe(document.body, { childList: true, subtree: true });
    }, `[data-testid="tp-block-${URI_COM}"]`);
    const refez = page.waitForResponse((r) => r.request().method() === 'POST' && /therapeutic-catalogs\/cascade/.test(r.url()));
    await escolherServico(page, SERVICO_CUIDADOR);
    expect((await refez).status()).toBe(200);
    const objetivos = page.getByTestId(`tp-objectives-${URI_COM}`);
    await expect(objetivos).toContainText(cuidado.objetivo.label);
    await expect(objetivos).not.toContainText(at.objetivo.label);
    await expect(page.getByTestId(`tp-obj-${URI_COM}-${at.objetivo.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`tp-obj-${URI_COM}-${cuidado.objetivo.id}`)).toHaveAttribute('aria-pressed', 'false');
    await expect(objetivos.locator('[aria-pressed="true"]')).toHaveCount(0); // 0 marcados; sem objetivo marcado não há atividade na tela
    await expect(page.getByTestId(`tp-activity-group-${URI_COM}-${cuidado.objetivo.id}`)).toHaveCount(0);
    await preencherRestoEDatas(page);
    await expect(page.getByTestId('tp-save')).toBeDisabled(); // o salvar trava de novo: o plano do bloco está vazio
    expect(await page.evaluate(() => (window as unknown as Record<string, boolean>).__blocoSaiu091)).toBe(true); // o bloco antigo foi zerado, não reaproveitado
  });
});
