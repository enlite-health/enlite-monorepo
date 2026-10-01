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
 *      real (catálogo `terminology` semeado com UMA entidade sintética + o seu capítulo 06); os 2 multi-selects têm o seed
 *      da migration 415 (8/13/8 opções); salvar → POST devolve V.1.0 e a tabela mostra;
 *   3. "Editar" → V.1.1: o banco tem DUAS linhas e a V.1.0 mantém o texto original (imutável, lex C5);
 *   4. a versão antiga abre em leitura e "Exportar PDF" busca `?purpose=export` (trilha C13) e baixa um
 *      `.pdf` cujo texto (pdf-parse) contém o nome do paciente e o objetivo — e NÃO contém "ICHOM";
 *   5. foto do card e da modal (`toHaveScreenshot`);
 *   6. caminho alternativo: opção do catálogo desativada no meio do preenchimento → 422 na tela, nada gravado.
 *   7. spec 030 (bloco "030 —"): o segmento Ana Care — escolhido pelo teclado no "Nuevo", congelado na versão,
 *      visto na tela e no PDF; sem `patient_clinical:read` tela e PDF o redigem; versão anterior mostra "—".
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
import { escolherSegmentoPeloTeclado, primeiroSegmento } from '../helpers/pti-segmento-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const ICD_URI = 'http://id.who.int/icd/entity/e2e-tp-017';
/** Capítulo do stem acima: é o que o servidor DERIVA como "Tipo de patología" (D163/D164) — nada se escolhe na tela. */
const CAP06_URI = 'http://id.who.int/icd/entity/e2e-tp-017-cap06';
const CAP06_TITLE = 'Trastornos mentales, del comportamiento y del neurodesarrollo (e2e 017)';
const ICD_TITLE = 'Trastorno sintético de prueba 017';


/** Clica como um humano, digita, devolve o que a TELA mostra. */
async function digitar(page: Page, selector: string, texto: string): Promise<string> {
  const campo = page.locator(selector);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
}

/** Abre um multi-select do DS e marca as N primeiras opções pelo mouse; fecha a lista clicando no gatilho de novo
 * (o `Escape` do multi-select também chega ao drawer, que desde 15/09 abre o "¿Descartar los cambios?" e tapa a tela). */
async function marcarOpcoes(page: Page, id: string, n: number): Promise<void> {
  const root = page.locator(`#${id}`);
  const gatilho = root.locator('button[aria-haspopup="listbox"]');
  await gatilho.click();
  const opcoes = root.locator('[role="option"] button');
  await expect(opcoes.first()).toBeVisible();
  for (let i = 0; i < n; i++) await opcoes.nth(i).click();
  await gatilho.click();
  await expect(gatilho).toHaveAttribute('aria-expanded', 'false');
}

/** O catálogo CID-11 do stack de integração é vazio: UMA entidade sintética, no release corrente. */
function seedIcd(): void {
  runSQL(`INSERT INTO terminology.icd_releases (release, entity_count, is_current, promoted_at, promoted_by) VALUES ('2026-01', 1, true, now(), 'e2e-017') ON CONFLICT (release) DO UPDATE SET is_current = true, promoted_at = now(), promoted_by = 'e2e-017'`);
  runSQL(`INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) VALUES ('${ICD_URI}', '2026-01', '6E2E', '${ICD_TITLE}', 'Synthetic disorder 017', '06', NULL, 'stem', true) ON CONFLICT (icd_uri, release) DO NOTHING`);
  // Só quando a base não tem o capítulo 06 real (o CI do backend ingere o catálogo; o do front não): a derivação precisa da linha do capítulo.
  runSQL(`INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) SELECT '${CAP06_URI}', '2026-01', '06', '${CAP06_TITLE}', NULL, '06', NULL, 'chapter', false WHERE NOT EXISTS (SELECT 1 FROM terminology.icd_entities WHERE release = '2026-01' AND kind = 'chapter' AND code = '06')`);
}
function cleanupIcd(): void {
  runSQL(`DELETE FROM terminology.icd_entities WHERE icd_uri IN ('${ICD_URI}', '${CAP06_URI}')`);
}

/** Células do PTI de ponta a ponta (molde `projeto-terapeutico-contatos-humano`); a conta "sem clínica" perde só `patient_clinical:read`. */
const CELULAS_PTI: [string, string][] = [
  ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'], ['patient_therapeutic_project', 'create'], ['patient_therapeutic_project', 'export'],
  ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_family', 'read'], ['patient_family', 'write'],
  ['patient_care_team', 'read'], ['patient_services', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_identity', 'read'],
  ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'], ['catalog_therapeutic_segments', 'read'],
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

  test.beforeAll(() => {
    seed = seedActivatablePatient(700000); // faixa própria (700000–789999)
    seedIcd();
    staff = semearStaff('tp017');
  });
  test.afterAll(() => {
    // As versões são IMUTÁVEIS (trigger 416): só saem por CASCADE do paciente — e a versão aponta
    // para o serviço (FK sem cascade), então o serviço não pode sair antes. O purge real (D248) faz
    // o mesmo: apaga o pai. Depois, o helper limpa o que sobrar (idempotente).
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupIcd();
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
    await expect(page.getByTestId('tp-service')).toHaveValue(serviceId);
    // D301.3a (Ana): modalidade obrigatória — select nativo; o valor é lido de volta da tela.
    await expect(page.getByTestId('tp-modality')).toHaveValue('');
    await page.getByTestId('tp-modality').selectOption('HYBRID');
    await expect(page.getByTestId('tp-modality')).toHaveValue('HYBRID');
    // spec 030: o segmento é obrigatório no "Nuevo" — pelo teclado, valor lido da tela.
    const segmento = primeiroSegmento();
    expect(await escolherSegmentoPeloTeclado(page, segmento.label)).toBe(segmento.label);

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
    const body = (await (await created).json()) as { data: { id: string; version: string; specificObjectives: unknown[]; activities: unknown[]; pathologyTypes: { id: string; label: string }[]; diagnoses: { title: string }[] } };
    expect(body.data.version).toBe('V.1.0');
    expect(body.data.modality).toBe('HYBRID');
    expect(body.data.specificObjectives).toHaveLength(2);
    expect(body.data.activities).toHaveLength(3);
    // DERIVADO: o capítulo CID-11 do diagnóstico escolhido, resolvido no servidor (id = código do capítulo).
    expect(body.data.pathologyTypes).toHaveLength(1);
    expect(body.data.pathologyTypes[0].id).toBe('06');
    expect(body.data.diagnoses[0].title).toBe(ICD_TITLE);
    const v10 = body.data.id;

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
    // PR-7 (D328): editar a vigente trava os campos MACRO como TEXTO (objetivo geral, segmento…); só os MICRO mudam.
    await expect(page.getByTestId('tp-generalObjective-locked')).toHaveText('Objetivo general digitado por humano 017');
    await expect(page.getByTestId('tp-segment-locked')).toHaveText(segmento.label); // spec 030: o segmento herda da origem
    await expect(page.getByTestId('tp-modality')).toHaveValue('HYBRID'); // a edição parte da versão de origem
    await page.getByTestId('tp-modality').selectOption('ONLINE');
    await expect(page.getByTestId('tp-modality')).toHaveValue('ONLINE');
    const edited = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const body11 = (await (await edited).json()) as { data: { id: string; version: string; editedFromVersionId: string; generalObjective: string; modality: string; segment: { label: string } | null } };
    expect(body11.data.version).toBe('V.1.1');
    expect(body11.data.editedFromVersionId).toBe(v10);
    expect(body11.data.generalObjective).toBe('Objetivo general digitado por humano 017');
    expect(body11.data.modality).toBe('ONLINE');
    expect(body11.data.segment?.label).toBe(segmento.label); // herdado da origem (a chave `segmentId` nem viaja no "Editar")
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
    expect(texto).toContain('Versión V.1.0');
    expect(texto).toContain('Modalidad: Híbrida');
    // D301.1: o serviço é CAREGIVER → as seções fixas VIII/IX saem inteiras.
    expect(texto).toContain('El cuidador NO debe');
    expect(texto).not.toContain('no aplicable a este servicio');
    expect(texto).not.toContain('ICHOM');
    expect(texto).not.toContain('6E2E');
    // lex C13: a trilha do export existe, com o UUID do paciente e sem texto.
    const trilha = runSQL(`SELECT count(*) FROM resource_access_log WHERE resource_id = '${seed.patientId}' AND action LIKE 'export_pdf:%'`);
    expect(Number(trilha)).toBeGreaterThanOrEqual(1);
  });
  test('caminho alternativo: uma opção do catálogo é desativada no backoffice ENQUANTO o humano preenche → o servidor recusa (422), a tela diz por quê e NADA é gravado', async ({ page }) => {
    // O que se prova: o snapshot do catálogo é validado na hora de salvar (repositório: só ids ATIVOS
    // entram), a recusa vira frase na tela (`catalog_items_unknown`), e o banco não ganha versão.
    const antes = Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`));
    expect(antes).toBe(2);

    await loginAs(page, staff.user);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tp-new-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('tp-icd-input').click();
    await page.keyboard.type('sintetico');
    const opcao = page.getByTestId('tp-icd-option-0');
    await expect(opcao).toBeVisible({ timeout: 10_000 });
    await opcao.click();
    await digitar(page, '#tp-clinicalContext', 'Contexto que no debe persistir 017');
    await digitar(page, '#tp-generalObjective', 'Objetivo que no debe persistir 017');
    await page.getByTestId('tp-modality').selectOption('IN_PERSON');
    await escolherSegmentoPeloTeclado(page, primeiroSegmento().label);
    await marcarOpcoes(page, 'tp-specificObjectives', 1); // a PRIMEIRA da lista (ORDER BY sort_order, lower(label))
    await marcarOpcoes(page, 'tp-activities', 1);
    await page.locator('#tp-startDate').click();
    await page.keyboard.type('09012026');
    await page.locator('#tp-endDate').click();
    await page.keyboard.type('12312026');
    await expect(page.getByTestId('tp-save')).toBeEnabled();

    // Enquanto o formulário está aberto, o backoffice desativa exatamente a opção escolhida.
    const primeira = runSQL(`SELECT id FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order, lower(label) LIMIT 1`).split('\n')[0].trim();
    expect(primeira).toMatch(/^[0-9a-f-]{36}$/);
    runSQL(`UPDATE therapeutic_specific_objectives SET active = false, deactivated_at = now(), updated_by = 'e2e-017' WHERE id = '${primeira}'`);
    try {
      const recusa = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
      await page.getByTestId('tp-save').click();
      const resp = await recusa;
      expect(resp.status()).toBe(422);
      expect(((await resp.json()) as { code: string }).code).toBe('catalog_items_unknown');
      await expect(page.getByTestId('tp-form-error')).toContainText('ya no está activa en el catálogo');
      await expect(drawer).toHaveAttribute('data-mode', 'new'); // o formulário fica aberto para o humano corrigir
      await expect(page.getByTestId('tp-form-error')).toHaveScreenshot('tp-form-error-catalogo.png', { maxDiffPixelRatio: 0.02 });
    } finally {
      runSQL(`UPDATE therapeutic_specific_objectives SET active = true, deactivated_at = NULL, updated_by = 'seed:415' WHERE id = '${primeira}'`);
    }
    const depois = Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`));
    expect(depois).toBe(antes);
    expect(Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE general_objective LIKE '%no debe persistir%'`))).toBe(0);
  });
});

/** Semeia paciente + serviço CAREGIVER (pré-condição; o fluxo do serviço tem e2e próprio). */
function semearPacienteComServico(base: number): { patientId: string; serviceId: string } {
  const p = seedActivatablePatient(base);
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

test.describe('spec 030 — segmento Ana Care no PTI: escolhido pelo teclado, na tela e no PDF; redigido sem clínica; versão anterior "—" @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let completa: { user: MockUser; groupId: string };
  let semClinica: { user: MockUser; groupId: string };
  let feliz: { patientId: string; serviceId: string };
  let comSegmento: { patientId: string; serviceId: string };
  let anterior: { patientId: string; serviceId: string };
  let segmento: { id: string; label: string };

  test.beforeAll(() => {
    seedIcd();
    segmento = primeiroSegmento();
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
    cleanupIcd();
    limparStaff(completa);
    limparStaff(semClinica);
  });

  test('030 — feliz: Nuevo → CID pelo combobox → segmento pelo teclado (valor lido da tela) → salva → a visão mostra o segmento → o PDF o contém, sem requisição externa', async ({ page }, testInfo) => {
    await loginAs(page, completa.user);
    await page.goto(`/admin/patients/${feliz.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tp-new-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tp-save')).toBeDisabled();

    await page.getByTestId('tp-modality').selectOption('HYBRID');
    const search = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()));
    await page.getByTestId('tp-icd-input').click();
    await page.keyboard.type('sintetico');
    expect((await search).status()).toBe(200);
    await page.getByTestId('tp-icd-option-0').click();
    await expect(page.getByTestId('tp-diagnosis-chip')).toHaveCount(1);

    // O segmento fica logo abaixo do CID (FR-007) e, sem escolha, "Salvar" segue travado mesmo com o resto pronto.
    const caixaCid = await page.getByTestId('tp-diagnoses').boundingBox();
    const caixaSegmento = await page.getByTestId('tp-segment').boundingBox();
    expect(caixaSegmento!.y).toBeGreaterThan(caixaCid!.y);
    await digitar(page, '#tp-clinicalContext', 'Sintesis clinica 030 digitada por humano');
    await digitar(page, '#tp-generalObjective', 'Objetivo general 030 digitado por humano');
    await marcarOpcoes(page, 'tp-specificObjectives', 1);
    await marcarOpcoes(page, 'tp-activities', 1);
    await page.locator('#tp-startDate').click();
    await page.keyboard.type('09012026');
    await page.locator('#tp-endDate').click();
    await page.keyboard.type('12312026');
    await expect(page.locator('#tp-endDate')).toHaveValue('2026-12-31');
    await expect(page.getByTestId('tp-save')).toBeDisabled();

    const lido = await escolherSegmentoPeloTeclado(page, segmento.label);
    expect(lido).toBe(segmento.label);
    await expect(page.getByTestId('tp-segment')).toHaveAttribute('data-clarity-mask', 'True');
    await expect(page.getByTestId('tp-save')).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('030-form-com-segmento.png') });

    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const resp = await created;
    expect(resp.status()).toBe(201);
    const body = (await resp.json()) as { data: { id: string; version: string; segment: { id: string; label: string } | null } };
    expect(body.data.segment).toEqual({ id: segmento.id, label: lido });
    // Congelado na versão: está no banco, não só na resposta.
    expect(runSQL(`SELECT segment->>'label' FROM patient_therapeutic_projects WHERE id = '${body.data.id}'`).trim()).toBe(lido);

    // A visão (o drawer vira "ver" da criada) mostra a linha com o rótulo lido da tela.
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId('tpv-segment')).toContainText('Segmento (Ana Care)');
    await expect(drawer.getByTestId('tpv-segment')).toContainText(lido);
    await expect(drawer.getByTestId('tpv-segment')).toHaveAttribute('data-clarity-mask', 'True');
    await page.screenshot({ path: testInfo.outputPath('030-visao-com-segmento.png') });

    // PDF: o texto (pdf-parse) traz o rótulo; nenhuma requisição saiu de localhost/data:/blob: durante a geração.
    const { texto, externas } = await exportarPdf(page, testInfo, '030-feliz');
    expect(texto).toContain(`Segmento (Ana Care): ${lido}`);
    expect(texto).toContain('Tipo de patología (segmento)'); // a linha derivada do CID-11 segue como estava
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
