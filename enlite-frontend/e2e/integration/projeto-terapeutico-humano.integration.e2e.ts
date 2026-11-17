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
 *      real (catálogo `terminology` semeado com UMA entidade sintética cuja categoria está no catálogo da planilha, spec 091 + o seu
 *      capítulo 06); a cascata (§9.8) traz objetivos e atividades DESSA categoria para o serviço (ids lidos do banco); o humano marca 1
 *      objetivo e 1 atividade; salvar → POST devolve V.1.0 (formato por diagnóstico) e a tabela mostra;
 *   3. "Editar" → V.1.1: o banco tem DUAS linhas e a V.1.0 mantém o texto original (imutável, lex C5);
 *   4. a versão antiga abre em leitura e "Exportar PDF" busca `?purpose=export` (trilha C13) e baixa um
 *      `.pdf` cujo texto (pdf-parse) contém o nome do paciente e o objetivo — e NÃO contém "ICHOM";
 *   5. foto do card e da modal (`toHaveScreenshot`);
 *   6. caminho alternativo: opção do catálogo desativada no meio do preenchimento → 422 na tela, nada gravado.
 *   7. spec 030 (bloco "030 —"): o segmento Ana Care só existe em versão ANTIGA (formato plano, semeada por SQL; DF-7): a visão e o PDF
 *      o mostram; sem `patient_clinical:read` tela e PDF o redigem; versão sem segmento mostra "—"; no "Nuevo" em cascata o segmento
 *      nem aparece (091: sai o campo, o servidor não o recebe) e a versão nasce sem segmento.
 *
 * Auth: staff com GRUPO e células no stack com o engine ABAC LIGADO + token `mock_*` (`loginAs`, molde de
 * `projeto-terapeutico-contatos-humano`) — o `loginComoHumano` (emulador Firebase) não roda nesse stack.
 */
import { test, expect, type Page, type Request, type TestInfo } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  psql, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';
import { escolherNoCombo } from '../helpers/combobox';
import {
  CATEGORIA_NA_PLANILHA, primeiroPlano, escolherDiagnostico, marcarPlano, semearCatalogoSintetico, diagnosisPlansDaVersao,
} from '../helpers/pti-cascata-091';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
/** Release de teste (corrente sob o advisory lock) com UM stem da planilha: o servidor DERIVA o capítulo 06 do release como "Tipo de patología" (D163/D164) — nada se escolhe na tela. */
const RELEASE = 'E2E091-PTH';
const URI_BASE = 'test://e2e091pth';
const ICD_URI = `${URI_BASE}/${CATEGORIA_NA_PLANILHA}`;
const ICD_TITLE = 'Trastorno sintético de prueba 017';
const ICD_CODE = CATEGORIA_NA_PLANILHA; // o código nunca aparece na tela (REQ-21)


/** Clica como um humano, digita, devolve o que a TELA mostra. */
async function digitar(page: Page, selector: string, texto: string): Promise<string> {
  const campo = page.locator(selector);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
}

/** Semeia o release sintético (lock do release corrente) e devolve o encerramento que restaura o anterior e solta o lock. */
const seedIcd = (): Promise<() => void> => semearCatalogoSintetico(RELEASE, URI_BASE, [{ code: ICD_CODE, title: ICD_TITLE }]);

/** Células do PTI de ponta a ponta (molde `projeto-terapeutico-contatos-humano`); a conta "sem clínica" perde só `patient_clinical:read`. */
const CELULAS_PTI: [string, string][] = [
  ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'], ['patient_therapeutic_project', 'create'], ['patient_therapeutic_project', 'export'],
  ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_family', 'read'], ['patient_family', 'write'],
  ['patient_care_team', 'read'], ['patient_services', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_identity', 'read'],
  ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'],
];

/** Staff + grupo + células; o nome da tela ("Creado por") é o `display_name` combinado. */
function semearStaff(prefixo: string, semCelulas: string[] = []): { user: MockUser; groupId: string } {
  const uid = `e2e-${prefixo}-${RUN_ID}`;
  const user: MockUser = { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };
  const { groupId } = seedStaffInGroup({ uid, email: user.email, groupName: `PTI ${prefixo} ${RUN_ID}`, country: 'AR' });
  psql(`UPDATE users SET display_name = 'E2E Proyecto' WHERE firebase_uid = '${uid}'`);
  for (const [resource, action] of CELULAS_PTI) if (!semCelulas.includes(`${resource}:${action}`)) grantCell(groupId, resource, action);
  return { user, groupId };
}
function limparStaff(s: { user: MockUser; groupId: string }): void {
  cleanupStaffAndGroup(s.user.uid, s.groupId);
  safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'PTI % ${RUN_ID}'`);
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on', acceptDownloads: true });

test.describe('spec 017 — projeto terapêutico: um HUMANO cria, edita (minor), lê a antiga e exporta o PDF @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let serviceId: string;
  let staff: { user: MockUser; groupId: string };
  let soltarCatalogo: () => void = () => undefined;

  test.beforeAll(async () => {
    seed = seedActivatablePatient(700000, { withDiagnosis: false }); // faixa própria (700000–789999)
    soltarCatalogo = await seedIcd();
    staff = semearStaff('tp017');
  });
  test.afterAll(() => {
    // As versões são IMUTÁVEIS (trigger 416): só saem por CASCADE do paciente — e a versão aponta
    // para o serviço (FK sem cascade), então o serviço não pode sair antes. O purge real (D248) faz
    // o mesmo: apaga o pai. Depois, o helper limpa o que sobrar (idempotente).
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    soltarCatalogo();
    limparStaff(staff);
  });

  test('sem serviço contratado ativo, o card diz por quê e "Nuevo" fica desabilitado', async ({ page }) => {
    await loginAs(page, staff.user);
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

    await loginAs(page, staff.user);
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
    await expect(page.getByTestId('tp-service')).toHaveText('Cuidador'); // Paso 1: o único serviço contratado já vem escolhido (a faixa de horas só aparece com `serviceHours` no catálogo)
    // D301.3a (Ana): modalidade obrigatória — select nativo; o valor é lido de volta da tela.
    await expect(page.getByTestId('tp-modality')).toContainText('Elegí la modalidad');
    await escolherNoCombo(page, page.getByTestId('tp-modality'), 'Híbrida'); // HYBRID = Híbrida
    await expect(page.getByTestId('tp-modality')).toContainText('Híbrida');
    // 091: o campo Segmento saiu do "Nuevo" (o catálogo agora é por serviço e CID).
    await expect(page.getByTestId('tp-segment')).toHaveCount(0);

    // CID pelo combobox REAL: digita como humano, escolhe a opção; a cascata traz o catálogo do serviço para essa categoria.
    const plano = primeiroPlano('CAREGIVER');
    await escolherDiagnostico(page, ICD_TITLE, 'sintetico');
    // REQ-21: o código nunca aparece na tela.
    await expect(drawer).not.toContainText(ICD_CODE);

    expect(await digitar(page, '#tp-clinicalContext', 'Sintesis clinica digitada por humano 017')).toBe('Sintesis clinica digitada por humano 017');
    expect(await digitar(page, '#tp-generalObjective', 'Objetivo general digitado por humano 017')).toBe('Objetivo general digitado por humano 017');
    await marcarPlano(page, ICD_URI, plano); // Paso 3 e 4: 1 objetivo e 1 atividade do bloco (sem seleção prévia, DD-13)
    // Não existe campo de tipo de patologia (Gabriel 08/09): deriva do CID-11 no servidor; DEC-09 — nem na tela.
    await expect(page.getByTestId('tp-pathologyTypes')).toHaveCount(0);
    await expect(drawer).not.toContainText('Tipo de patología');
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
    const body = (await (await created).json()) as { data: { id: string; version: string; modality: string; specificObjectives: Array<{ id: string }>; activities: Array<{ id: string }>; segment: unknown; pathologyTypes: { id: string; label: string }[]; diagnoses: { title: string }[] } };
    expect(body.data.version).toBe('V.1.0');
    expect(body.data.modality).toBe('HYBRID');
    // Formato por diagnóstico: a lista plana da resposta é a união dos blocos; a versão nasce sem segmento.
    expect(body.data.specificObjectives.map((o) => o.id)).toEqual([plano.objetivo.id]);
    expect(body.data.activities.map((a) => a.id)).toEqual([plano.atividade.id]);
    expect(body.data.segment ?? null).toBeNull();
    // DERIVADO: o capítulo CID-11 do diagnóstico escolhido, resolvido no servidor (id = código do capítulo).
    expect(body.data.pathologyTypes).toHaveLength(1);
    expect(body.data.pathologyTypes[0].id).toBe('06');
    expect(body.data.diagnoses[0].title).toBe(ICD_TITLE);
    const v10 = body.data.id;
    expect(diagnosisPlansDaVersao(v10)).toEqual([{ diagnosisUri: ICD_URI, specificObjectiveIds: [plano.objetivo.id], activityIds: [plano.atividade.id] }]);

    // A modal vira "ver" da criada; fecha; o card mostra a V.1.0 no topo e na tabela.
    await expect(page.getByTestId('therapeutic-project-subtitle')).toContainText('V.1.0 - Creado por: E2E Proyecto');
    await page.getByTestId('therapeutic-project-close').click();
    await expect(drawer).toHaveCount(0); // desmonta depois da animação (300 ms) — só então o próximo clique
    await expect(page.getByTestId(`tp-row-${v10}`)).toContainText('V.1.0');
    await expect(card.getByTestId('tpv-objective-text')).toContainText('Objetivo general digitado por humano 017');
    await expect(card.getByTestId('tpv-modality')).toContainText('Híbrida');
    await expect(card).toHaveScreenshot('tp-card-v1-0.png', { mask: [page.locator('.firebase-emulator-warning'), page.getByTestId(`tp-row-${v10}`).locator('td').nth(3), page.getByTestId(`tp-row-${v10}`).locator('td').nth(4)], maxDiffPixelRatio: 0.02 });

    // ── Editar → V.1.1 ─────────────────────────────────────────────────────────────────────
    await page.getByTestId('tp-edit-btn').click();
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('therapeutic-project-subtitle')).toContainText('V.1.0');
    // PR-7 (D328): editar a vigente trava os campos MACRO como TEXTO (objetivo geral, blocos do diagnóstico…); só os MICRO mudam.
    await expect(page.getByTestId('tp-generalObjective-locked')).toHaveText('Objetivo general digitado por humano 017');
    // 091 (§9.8): "Editar" de versão por diagnóstico mostra os blocos SÓ LEITURA, com o plano da origem.
    await expect(page.getByTestId(`tp-objectives-locked-${ICD_URI}`)).toContainText(plano.objetivo.label);
    await expect(page.getByTestId(`tp-activities-locked-${ICD_URI}`)).toContainText(plano.atividade.label);
    await expect(page.getByTestId('tp-segment-locked')).toHaveCount(0);
    await expect(page.getByTestId('tp-modality')).toContainText('Híbrida'); // a edição parte da versão de origem
    await escolherNoCombo(page, page.getByTestId('tp-modality'), 'On-line'); // ONLINE = On-line
    await expect(page.getByTestId('tp-modality')).toContainText('On-line');
    const edited = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const body11 = (await (await edited).json()) as { data: { id: string; version: string; editedFromVersionId: string; generalObjective: string; modality: string; segment: { label: string } | null; specificObjectives: Array<{ id: string }>; activities: Array<{ id: string }> } };
    expect(body11.data.version).toBe('V.1.1');
    expect(body11.data.editedFromVersionId).toBe(v10);
    expect(body11.data.generalObjective).toBe('Objetivo general digitado por humano 017');
    expect(body11.data.modality).toBe('ONLINE');
    expect(body11.data.segment ?? null).toBeNull(); // a origem não tem segmento
    expect(body11.data.specificObjectives.map((o) => o.id)).toEqual([plano.objetivo.id]); // o plano é COPIADO da origem (DD-6)
    expect(diagnosisPlansDaVersao(body11.data.id)).toEqual(diagnosisPlansDaVersao(v10));
    await page.getByTestId('therapeutic-project-close').click();
    await expect(drawer).toHaveCount(0);

    // O banco tem DUAS linhas e a V.1.0 NÃO mudou (imutável, lex C5).
    const linhas = runSQL(`SELECT string_agg(major || '.' || minor || ':' || modality, '|' ORDER BY created_at) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`);
    expect(linhas).toBe('1.0:HYBRID|1.1:ONLINE');
    await expect(page.getByTestId(`tp-row-${body11.data.id}`)).toContainText('V.1.1');
    // A lista é por data de criação, mais recente primeiro.
    const versoes = await page.locator('[data-testid^="tp-row-"] td:nth-child(2)').allInnerTexts();
    expect(versoes).toEqual(['V.1.1', 'V.1.0']);

    // ── A antiga em leitura + Exportar PDF ─────────────────────────────────────────────────
    await page.getByTestId(`tp-view-${v10}`).click();
    await expect(page.getByTestId('therapeutic-project-drawer')).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId('tpv-objective-text')).toContainText('Objetivo general digitado por humano 017');
    await expect(drawer.getByTestId('tpv-modality')).toContainText('Híbrida'); // a V.1.0 segue com a modalidade original
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
    expect(texto).toContain(`Diagnóstico: ${ICD_TITLE}`); // §9.9: grupo por diagnóstico nas seções de objetivos/atividades
    expect(texto).toContain(plano.objetivo.label);
    expect(texto).toContain(plano.atividade.label);
    expect(texto).not.toContain('Segmento (Ana Care)'); // byDiagnosis não mostra o campo Segmento
    expect(texto).toContain('Versión V.1.0');
    expect(texto).toContain('Modalidad: Híbrida');
    // D301.1: o serviço é CAREGIVER → as seções fixas VIII/IX saem inteiras.
    expect(texto).toContain('El cuidador NO debe');
    expect(texto).not.toContain('no aplicable a este servicio');
    expect(texto).not.toContain('ICHOM');
    expect(texto).not.toContain(ICD_CODE);
    // lex C13: a trilha do export existe, com o UUID do paciente e sem texto.
    const trilha = runSQL(`SELECT count(*) FROM resource_access_log WHERE resource_id = '${seed.patientId}' AND action LIKE 'export_pdf:%'`);
    expect(Number(trilha)).toBeGreaterThanOrEqual(1);
  });
  test('caminho alternativo: o objetivo marcado é desativado no backoffice ENQUANTO o humano preenche → o servidor recusa (422), a tela mostra a recusa e NADA é gravado', async ({ page }) => {
    // O que se prova: o plano do bloco é validado na hora de salvar (091/DF-7: o objetivo tem de estar ATIVO, ser do serviço e da categoria do
    // bloco), a recusa aparece na tela com o formulário aberto, e o banco não ganha versão.
    const antes = Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`));
    expect(antes).toBe(2);
    const plano = primeiroPlano('CAREGIVER');

    await loginAs(page, staff.user);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tp-new-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });

    await escolherDiagnostico(page, ICD_TITLE, 'sintetico');
    await marcarPlano(page, ICD_URI, plano);
    await digitar(page, '#tp-clinicalContext', 'Contexto que no debe persistir 017');
    await digitar(page, '#tp-generalObjective', 'Objetivo que no debe persistir 017');
    await escolherNoCombo(page, page.getByTestId('tp-modality'), 'Presencial'); // IN_PERSON = Presencial
    await page.locator('#tp-startDate').click();
    await page.keyboard.type('09012026');
    await page.locator('#tp-endDate').click();
    await page.keyboard.type('12312026');
    await expect(page.getByTestId('tp-save')).toBeEnabled();

    // Enquanto o formulário está aberto, o backoffice desativa exatamente o objetivo marcado (e devolve o `updated_by` original no fim).
    const autorOriginal = runSQL(`SELECT updated_by FROM therapeutic_specific_objectives WHERE id = '${plano.objetivo.id}'`).split('\n')[0].trim();
    runSQL(`UPDATE therapeutic_specific_objectives SET active = false, deactivated_at = now(), updated_by = 'e2e-017' WHERE id = '${plano.objetivo.id}'`);
    try {
      const recusa = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
      await page.getByTestId('tp-save').click();
      const resp = await recusa;
      expect(resp.status()).toBe(422);
      expect(((await resp.json()) as { code: string }).code).toBe('ptp_plan_objective_invalid');
      await expect(page.getByTestId('tp-form-error')).toBeVisible();
      await expect(drawer).toHaveAttribute('data-mode', 'new'); // o formulário fica aberto para o humano corrigir
      await expect(page.getByTestId('tp-form-error')).toHaveScreenshot('tp-form-error-catalogo.png', { maxDiffPixelRatio: 0.02 });
    } finally {
      runSQL(`UPDATE therapeutic_specific_objectives SET active = true, deactivated_at = NULL, updated_by = '${autorOriginal}' WHERE id = '${plano.objetivo.id}'`);
    }
    const depois = Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`));
    expect(depois).toBe(antes);
    expect(Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE general_objective LIKE '%no debe persistir%'`))).toBe(0);
  });
});

/** Semeia paciente + serviço CAREGIVER (pré-condição; o fluxo do serviço tem e2e próprio). */
function semearPacienteComServico(base: number): { patientId: string; serviceId: string } {
  const p = seedActivatablePatient(base, { withDiagnosis: false });
  const serviceId = runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${p.patientId}', 'CAREGIVER', 20, '${p.addressId}', 'e2e-030', 'e2e-030') RETURNING id`).split('\n')[0].trim();
  expect(serviceId).toMatch(/^[0-9a-f-]{36}$/);
  return { patientId: p.patientId, serviceId };
}

/** Versão anterior entrando por SQL (o fluxo humano de criar tem o caso feliz); `segment` NULL = anterior à 496. */
function inserirVersaoSql(patientId: string, serviceId: string, segment: { id: string; label: string } | null): string {
  const obj = runSQL(`SELECT id FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order LIMIT 1`).trim();
  const act = runSQL(`SELECT id FROM therapeutic_activities WHERE active ORDER BY sort_order LIMIT 1`).trim();
  const seg = segment ? `'${JSON.stringify(segment)}'::jsonb` : 'NULL';
  return runSQL(`INSERT INTO patient_therapeutic_projects (patient_id, major, minor, contracted_service_id, modality, diagnoses, clinical_context, general_objective, specific_objectives, activities, pathology_types, segment, start_date, end_date, created_by)
    VALUES ('${patientId}', 1, 0, '${serviceId}', 'IN_PERSON', '[{"uri":"http://id.who.int/icd/entity/e2e-030","title":"Diagnóstico sintético 030"}]', 'Contexto sintético 030', 'Objetivo sintético 030',
      (SELECT jsonb_build_array(jsonb_build_object('id', id, 'label', label)) FROM therapeutic_specific_objectives WHERE id = '${obj}'),
      (SELECT jsonb_build_array(jsonb_build_object('id', id, 'label', label)) FROM therapeutic_activities WHERE id = '${act}'),
      '[{"id":"06","label":"Capítulo 06 sintético 030"}]', ${seg}, '2026-09-01', '2026-12-31', 'e2e-030') RETURNING id`).split('\n')[0].trim();
}

/** Exporta o PDF da versão aberta no drawer: devolve o texto (pdf-parse) e as requisições FORA de localhost/`data:`/`blob:` feitas durante a geração. */
async function exportarPdf(page: Page, testInfo: TestInfo, nome: string): Promise<{ texto: string; externas: string[] }> {
  const externas: string[] = [];
  const observa = (r: Request): void => {
    const u = r.url();
    if (!/^(data:|blob:)/.test(u) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(u)) externas.push(u);
  };
  page.on('request', observa);
  const download = page.waitForEvent('download');
  await page.getByTestId('therapeutic-project-export-btn').click();
  const file = await download;
  const path = await file.path();
  page.off('request', observa);
  const buf = readFileSync(path!);
  writeFileSync(testInfo.outputPath(`${nome}.pdf`), buf);
  return { texto: (await pdfParse(buf)).text.replace(/\s+/g, ' '), externas };
}

test.describe('spec 030/091 — segmento Ana Care: só em versão ANTIGA (plana), na tela e no PDF; redigido sem clínica; sem segmento "—"; o "Nuevo" em cascata não tem segmento @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let completa: { user: MockUser; groupId: string };
  let semClinica: { user: MockUser; groupId: string };
  let feliz: { patientId: string; serviceId: string };
  let comSegmento: { patientId: string; serviceId: string };
  let anterior: { patientId: string; serviceId: string };
  let soltarCatalogo: () => void = () => undefined;
  /** Segmento SINTÉTICO congelado na versão antiga (a coluna `segment` é só `{id,label}`; o catálogo de segmentos saiu na 091). */
  const segmento = { id: '00000000-0000-4000-8000-000000000091', label: `Segmento sintetico 030 ${RUN_ID}` };

  test.beforeAll(async () => {
    soltarCatalogo = await seedIcd();
    completa = semearStaff('tp030-completa');
    semClinica = semearStaff('tp030-semclinica', ['patient_clinical:read']);
    feliz = semearPacienteComServico(730000);
    comSegmento = semearPacienteComServico(740000);
    anterior = semearPacienteComServico(750000);
    inserirVersaoSql(comSegmento.patientId, comSegmento.serviceId, segmento);
    inserirVersaoSql(anterior.patientId, anterior.serviceId, null);
  });
  test.afterAll(() => {
    for (const p of [feliz, comSegmento, anterior]) {
      runSQL(`DELETE FROM patients WHERE id = '${p.patientId}'`);
      cleanupPatientDeep(p.patientId);
    }
    soltarCatalogo();
    limparStaff(completa);
    limparStaff(semClinica);
  });

  test('030 — feliz: Nuevo em cascata → sem campo de segmento → salva → a visão e o PDF NÃO têm "Segmento (Ana Care)" e nenhuma requisição externa sai', async ({ page }, testInfo) => {
    const plano = primeiroPlano('CAREGIVER');
    await loginAs(page, completa.user);
    await page.goto(`/admin/patients/${feliz.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tp-new-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tp-save')).toBeDisabled();
    await expect(page.getByTestId('tp-segment')).toHaveCount(0); // o campo saiu do formulário (§9.8)

    await escolherNoCombo(page, page.getByTestId('tp-modality'), 'Híbrida'); // HYBRID = Híbrida
    await escolherDiagnostico(page, ICD_TITLE, 'sintetico');
    await digitar(page, '#tp-clinicalContext', 'Sintesis clinica 030 digitada por humano');
    await digitar(page, '#tp-generalObjective', 'Objetivo general 030 digitado por humano');
    await expect(page.getByTestId('tp-save')).toBeDisabled(); // sem objetivo/atividade marcados o plano do bloco está incompleto
    await marcarPlano(page, ICD_URI, plano);
    await page.locator('#tp-startDate').click();
    await page.keyboard.type('09012026');
    await page.locator('#tp-endDate').click();
    await page.keyboard.type('12312026');
    await expect(page.locator('#tp-endDate')).toHaveValue('2026-12-31');
    await expect(page.getByTestId('tp-save')).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('030-form-em-cascata.png') });

    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const resp = await created;
    expect(resp.status()).toBe(201);
    const body = (await resp.json()) as { data: { id: string; segment: unknown } };
    expect(body.data.segment ?? null).toBeNull();
    // Não há segmento congelado na versão: está no banco, não só na resposta.
    expect(runSQL(`SELECT segment IS NULL FROM patient_therapeutic_projects WHERE id = '${body.data.id}'`).trim()).toBe('t');

    // A visão (o drawer vira "ver" da criada) não mostra a linha do segmento (byDiagnosis).
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId('tpv-segment')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('030-visao-em-cascata.png') });

    // PDF: o texto (pdf-parse) não traz o segmento; nenhuma requisição saiu de localhost/data:/blob: durante a geração.
    const { texto, externas } = await exportarPdf(page, testInfo, '030-feliz');
    expect(texto).not.toContain('Segmento (Ana Care)');
    expect(texto).toContain('Tipo de patología (segmento)'); // a linha derivada do CID-11 segue como estava
    expect(texto).toContain(plano.objetivo.label);
    expect(externas).toEqual([]);
  });

  test('030 — versão ANTIGA (plana) com segmento: a visão mostra o rótulo e o PDF imprime "Segmento (Ana Care): <rótulo>" (flat idêntico a hoje, DF-7), sem requisição externa', async ({ page }, testInfo) => {
    await loginAs(page, completa.user);
    await page.goto(`/admin/patients/${comSegmento.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('tpv-segment')).toContainText(segmento.label);
    await page.locator('[data-testid^="tp-view-"]').first().click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId('tpv-segment')).toContainText('Segmento (Ana Care)');
    await expect(drawer.getByTestId('tpv-segment')).toContainText(segmento.label);
    await expect(drawer.getByTestId('tpv-segment')).toHaveAttribute('data-clarity-mask', 'True');
    await page.screenshot({ path: testInfo.outputPath('030-visao-com-segmento.png') });

    const { texto, externas } = await exportarPdf(page, testInfo, '030-flat-com-segmento');
    expect(texto).toContain(`Segmento (Ana Care): ${segmento.label}`);
    expect(texto).not.toContain('Diagnóstico: '); // flat não agrupa por diagnóstico
    expect(externas).toEqual([]);
  });

  test('030 — alt 1: conta SEM patient_clinical:read — a tela diz "Sin permiso para ver este dato" e o PDF sai com o rótulo de seção redigida, SEM o segmento', async ({ page }, testInfo) => {
    await loginAs(page, semClinica.user);
    await page.goto(`/admin/patients/${comSegmento.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('tpv-segment')).toContainText('Sin permiso para ver este dato');
    await expect(card).not.toContainText(segmento.label);

    await page.locator('[data-testid^="tp-view-"]').first().click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId('tpv-segment')).toContainText('Sin permiso para ver este dato');
    await expect(drawer).not.toContainText(segmento.label);

    const { texto, externas } = await exportarPdf(page, testInfo, '030-sem-clinica');
    expect(texto).toContain('Sección no incluida');
    expect(texto).not.toContain(segmento.label);
    expect(texto).not.toContain('Segmento (Ana Care)');
    expect(externas).toEqual([]);
  });

  test('030 — alt 2: versão anterior à 496 (segmento NULL) — a visão mostra "—" e o PDF imprime "Segmento (Ana Care): —"', async ({ page }, testInfo) => {
    await loginAs(page, completa.user);
    await page.goto(`/admin/patients/${anterior.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('tpv-segment')).toContainText('—');
    await expect(card.getByTestId('tpv-segment')).not.toContainText('Sin permiso');

    await page.locator('[data-testid^="tp-view-"]').first().click();
    await expect(page.getByTestId('therapeutic-project-drawer')).toHaveAttribute('data-mode', 'view');
    const { texto } = await exportarPdf(page, testInfo, '030-versao-anterior');
    expect(texto).toContain('Segmento (Ana Care): —');
  });
});
