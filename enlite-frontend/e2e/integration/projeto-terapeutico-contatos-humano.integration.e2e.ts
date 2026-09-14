/**
 * projeto-terapeutico-contatos-humano.integration.e2e.ts — spec 018, PR-7 (task 7.8; `lex` #7;
 * ADR-4; D328/SUP-25 — sem gatilho automático de versão).
 *
 * Um HUMANO, contra o stack REAL (frontend + API + Postgres, engine ABAC LIGADO), zero mock de
 * dado. Régua humana (memória `e2e-humano-nao-e-fill`): click + `keyboard.type` + `selectOption`
 * nativo, valor sempre lido da TELA. Molde: `projeto-terapeutico-humano.integration.e2e.ts` (CID +
 * PDF) + `rede-de-apoio-humano.integration.e2e.ts`/`abac-stack-helper.ts` (login ABAC + células) —
 * login aqui é o `loginAs` de mock-token (ABAC), NUNCA o `loginComoHumano` do emulador Firebase.
 *
 * O que se prova:
 *   feliz — cria V1.0 selecionando 1 familiar (contato externo) e 1 profissional (equipe tratante)
 *     pela TELA; exporta o PDF; `pdf-parse` contém os dois nomes;
 *   alt 1 — editar a vigente: os campos MACRO (`fieldClass.macro`, dono único no backend) renderizam
 *     como TEXTO — nenhum `input`/`textarea`/`select` desabilitado/readonly no drawer; tentar mudar
 *     `generalObjective` (MACRO) direto na API devolve 422 `ptp_macro_locked`;
 *   alt 2 — desativar o familiar pela tela da Rede de Apoio: NENHUMA versão nova nasce (D328/SUP-25:
 *     sem gatilho automático), a V1.0 fica intacta linha a linha, o card/versão mostra o contato
 *     inativo, e o PDF não imprime "Familiar QA" — imprime "Contacto dado de baja" (lex #7 C5);
 *   alt 3 — escrever numa versão que deixou de ser a vigente, direto na API, devolve 409
 *     `ptp_not_current` (prova de R4 no BACKEND, não só na tela);
 *   extra — sem `patient_therapeutic_project:export`, o botão de exportar não existe no DOM (D269).
 */
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, ABAC_API_URL, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const ICD_URI = `http://id.who.int/icd/entity/e2e-pr7-${RUN_ID}`;
const CAP06_URI = `http://id.who.int/icd/entity/e2e-pr7-cap06-${RUN_ID}`;
const CAP06_TITLE = `Trastornos mentales, del comportamiento y del neurodesarrollo (e2e pr7 ${RUN_ID})`;
const ICD_TITLE = `Trastorno sintético PR-7 ${RUN_ID}`;
const RELEASE = `pr7-${RUN_ID}`;
const FAMILIAR_NOME = 'Familiar QA';
const PROFISSIONAL_NOME = 'Profesional QA';

/** Clica como um humano, digita, devolve o que a TELA mostra. */
async function digitar(page: Page, selector: string, texto: string): Promise<string> {
  const campo = page.locator(selector);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
}

/** Abre um multi-select do DS e marca as N primeiras opções (catálogo de objetivos/atividades). */
async function marcarPrimeiras(page: Page, id: string, n: number): Promise<void> {
  const root = page.locator(`#${id}`);
  await root.locator('button[aria-haspopup="listbox"]').click();
  const opcoes = root.locator('[role="option"] button');
  await expect(opcoes.first()).toBeVisible();
  for (let i = 0; i < n; i++) await opcoes.nth(i).click();
  await page.keyboard.press('Escape');
}

/** Abre um multi-select do DS e marca a opção CUJO TEXTO contém `texto` (contatos/equipe — nunca "os N primeiros"). */
async function marcarPorTexto(page: Page, id: string, texto: string): Promise<void> {
  const root = page.locator(`#${id}`);
  await root.locator('button[aria-haspopup="listbox"]').click();
  const opcao = root.locator('li[role="option"]', { hasText: texto });
  await expect(opcao).toBeVisible({ timeout: 10_000 });
  await opcao.locator('button').click();
  await page.keyboard.press('Escape');
}

function seedIcd(): void {
  runSQL(`INSERT INTO terminology.icd_releases (release, entity_count, is_current, promoted_at, promoted_by) VALUES ('${RELEASE}', 1, true, now(), 'e2e-018-pr7') ON CONFLICT (release) DO UPDATE SET is_current = true, promoted_at = now(), promoted_by = 'e2e-018-pr7'`);
  runSQL(`INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) VALUES ('${ICD_URI}', '${RELEASE}', '6EP7', '${ICD_TITLE}', 'Synthetic disorder PR-7', '06', NULL, 'stem', true) ON CONFLICT (icd_uri, release) DO NOTHING`);
  runSQL(`INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) SELECT '${CAP06_URI}', '${RELEASE}', '06', '${CAP06_TITLE}', NULL, '06', NULL, 'chapter', false WHERE NOT EXISTS (SELECT 1 FROM terminology.icd_entities WHERE release = '${RELEASE}' AND kind = 'chapter' AND code = '06')`);
}
function cleanupIcd(): void {
  runSQL(`DELETE FROM terminology.icd_entities WHERE icd_uri IN ('${ICD_URI}', '${CAP06_URI}')`);
  safeSql(`DELETE FROM terminology.icd_releases WHERE release = '${RELEASE}'`);
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on', acceptDownloads: true });

test.describe('spec 018/PR-7 — projeto terapêutico: contatos por seleção, MACRO travado, inativo no PDF, versão antiga @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let serviceId: string;
  let familiarId = '';
  let profissionalId = '';
  let v10 = '';

  const completaUid = `e2e-pr7-completa-${RUN_ID}`;
  const completaEmail = `${completaUid}@e2e.test`;
  const semExportUid = `e2e-pr7-semexport-${RUN_ID}`;
  const semExportEmail = `${semExportUid}@e2e.test`;
  let completaGroupId = '';
  let semExportGroupId = '';

  test.beforeAll(() => {
    seed = seedActivatablePatient(710000); // faixa própria — 700000-709999 é do 017 humano
    seedIcd();
    serviceId = runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-018-pr7', 'e2e-018-pr7') RETURNING id`).split('\n')[0].trim();
    expect(serviceId).toMatch(/^[0-9a-f-]{36}$/);

    familiarId = runSQL(`INSERT INTO patient_external_contacts (patient_id, relation, name, active, created_by) VALUES ('${seed.patientId}', 'OTHER', '${FAMILIAR_NOME}', true, 'e2e-018-pr7') RETURNING id`).split('\n')[0].trim();
    expect(familiarId).toMatch(/^[0-9a-f-]{36}$/);

    profissionalId = runSQL(`INSERT INTO patient_professionals (patient_id, name, source, active, created_by, specialty) VALUES ('${seed.patientId}', '${PROFISSIONAL_NOME}', 'admin_manual', true, 'e2e-018-pr7', 'PHYSIOTHERAPIST') RETURNING id`).split('\n')[0].trim();
    expect(profissionalId).toMatch(/^[0-9a-f-]{36}$/);

    // Catálogo: as células precisam existir em iam.permissions antes de conceder a um grupo.
    psql(`INSERT INTO iam.permissions (resource, action, description, category) VALUES
            ('patient', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_therapeutic_project', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_therapeutic_project', 'write', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_therapeutic_project', 'export', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_clinical', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_clinical', 'write', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_family', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_family', 'write', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_care_team', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_services', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_coverage', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_address', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('patient_identity', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('catalog_therapeutic_objectives', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('catalog_therapeutic_activities', 'read', 'e2e PR-7 humano', 'Pacientes'),
            ('catalog_therapeutic_segments', 'read', 'e2e PR-7 humano', 'Pacientes')
          ON CONFLICT DO NOTHING`);

    completaGroupId = seedStaffInGroup({ uid: completaUid, email: completaEmail, groupName: `PR7 Completa ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [resource, action] of [
      ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'], ['patient_therapeutic_project', 'export'],
      ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_family', 'read'], ['patient_family', 'write'],
      ['patient_care_team', 'read'], ['patient_services', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_identity', 'read'],
      ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'], ['catalog_therapeutic_segments', 'read'],
    ]) grantCell(completaGroupId, resource, action);

    // Mesmo conjunto amplo do `completa`, MENOS `patient_therapeutic_project:export` — é a ÚNICA
    // ausência que o teste "extra" prova; com célula de menos em qualquer OUTRO container a ficha
    // do paciente (outros cards, fora do projeto terapêutico) quebra a página inteira por redação
    // incompleta em componente não tocado por esta task — achado registrado em ACHADOS, fora do
    // escopo do PR-7 consertar aqui.
    semExportGroupId = seedStaffInGroup({ uid: semExportUid, email: semExportEmail, groupName: `PR7 SemExport ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [resource, action] of [
      ['patient', 'read'], ['patient_therapeutic_project', 'read'],
      ['patient_clinical', 'read'], ['patient_family', 'read'], ['patient_care_team', 'read'],
      ['patient_services', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_identity', 'read'],
      ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'], ['catalog_therapeutic_segments', 'read'],
    ]) grantCell(semExportGroupId, resource, action); // SEM `:export` — é o que o teste "extra" prova
  });

  test.afterAll(() => {
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupIcd();
    cleanupStaffAndGroup(completaUid, completaGroupId);
    cleanupStaffAndGroup(semExportUid, semExportGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'PR7 % ${RUN_ID}'`);
  });

  test('feliz: cria V1.0 selecionando 1 familiar e 1 profissional pela tela; exporta PDF com os dois nomes', async ({ page }) => {
    await loginAs(page, { uid: completaUid, email: completaEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${seed.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tp-empty')).toContainText('todavía no tiene proyecto');
    await expect(page.getByTestId('tp-new-btn')).toBeEnabled();

    await page.getByTestId('tp-new-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tp-save')).toBeDisabled();

    await expect(page.getByTestId('tp-service')).toHaveValue(serviceId);
    await page.getByTestId('tp-modality').selectOption('HYBRID');
    await expect(page.getByTestId('tp-modality')).toHaveValue('HYBRID');

    const search = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()));
    await page.getByTestId('tp-icd-input').click();
    await page.keyboard.type('sintetico pr-7');
    expect((await search).status()).toBe(200);
    const opcaoIcd = page.getByTestId('tp-icd-option-0');
    await expect(opcaoIcd).toBeVisible({ timeout: 10_000 });
    await expect(opcaoIcd).toContainText(ICD_TITLE);
    await opcaoIcd.click();
    await expect(page.getByTestId('tp-diagnosis-chip')).toHaveCount(1);

    expect(await digitar(page, '#tp-clinicalContext', 'Sintesis clinica PR-7 digitada por humano')).toBe('Sintesis clinica PR-7 digitada por humano');
    expect(await digitar(page, '#tp-generalObjective', 'Objetivo general PR-7 digitado por humano')).toBe('Objetivo general PR-7 digitado por humano');
    await marcarPrimeiras(page, 'tp-specificObjectives', 2);
    await marcarPrimeiras(page, 'tp-activities', 3);
    await page.locator('#tp-startDate').click();
    await page.keyboard.type('09012026');
    await page.locator('#tp-endDate').click();
    await page.keyboard.type('12312026');
    await expect(page.locator('#tp-endDate')).toHaveValue('2026-12-31');

    // Contatos por seleção (PR-7, MICRO): 1 familiar (contato externo) + 1 profissional (equipe), por TEXTO — nunca "os N primeiros".
    await marcarPorTexto(page, 'tp-externalContacts', FAMILIAR_NOME);
    await marcarPorTexto(page, 'tp-careTeam', PROFISSIONAL_NOME);
    await expect(page.locator('#tp-externalContacts')).toContainText(FAMILIAR_NOME);
    await expect(page.locator('#tp-careTeam')).toContainText(PROFISSIONAL_NOME);

    await expect(page.getByTestId('tp-save')).toBeEnabled();
    await expect(drawer).toHaveScreenshot('tp-pr7-drawer-nuevo-preenchido.png', { mask: [page.locator('.firebase-emulator-warning')], maxDiffPixelRatio: 0.02 });

    // POST cria a versão JÁ com `contacts` resolvidos (conserto 14/09, contract §POST — mesma
    // `resolveContacts` de `list`/`get`); logo em seguida o card recarrega a LISTA (`onSaved` →
    // `refetch`), que resolve os mesmos contatos pela MESMA célula de origem (lex #7 C5).
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    const listAfterSave = page.waitForResponse((r) => r.request().method() === 'GET' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const body = (await (await created).json()) as { data: { id: string; version: string } };
    expect(body.data.version).toBe('V.1.0');
    v10 = body.data.id;

    const listBody = (await (await listAfterSave).json()) as {
      data: { versions: Array<{ id: string; contacts: Array<{ kind: string; id: string; name?: string }> }> };
    };
    const v10NaLista = listBody.data.versions.find((v) => v.id === v10);
    expect(v10NaLista?.contacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'EXTERNAL', id: familiarId, name: FAMILIAR_NOME }),
      expect.objectContaining({ kind: 'CARE_TEAM', id: profissionalId, name: PROFISSIONAL_NOME }),
    ]));

    await page.getByTestId('therapeutic-project-close').click();
    await expect(drawer).toHaveCount(0); // desmonta depois da animação (300 ms)
    await expect(page.getByTestId(`tp-row-${v10}`)).toContainText('V.1.0');
    await expect(card).toHaveScreenshot('tp-pr7-card-v1-0.png', {
      mask: [page.locator('.firebase-emulator-warning'), page.getByTestId(`tp-row-${v10}`).locator('td').nth(2), page.getByTestId(`tp-row-${v10}`).locator('td').nth(3), page.getByTestId(`tp-row-${v10}`).locator('td').nth(4)],
      maxDiffPixelRatio: 0.02,
    });

    // Abre a V1.0 em leitura (dado já carregado da lista — sem novo GET) e confere na TELA.
    await page.getByTestId(`tp-view-${v10}`).click();
    await expect(page.getByTestId('therapeutic-project-drawer')).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId('tpv-contacts')).toContainText(FAMILIAR_NOME);
    await expect(drawer.getByTestId('tpv-contacts')).toContainText(PROFISSIONAL_NOME);

    // Exporta o PDF da V1.0 — os dois nomes têm de aparecer (lex #7: resolvido pela célula de origem).
    const exportFetch = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes(`/therapeutic-projects/${v10}?purpose=export`));
    const download = page.waitForEvent('download');
    await page.getByTestId('therapeutic-project-export-btn').click();
    expect((await exportFetch).status()).toBe(200);
    const file = await download;
    const pdfPath = await file.path();
    const parsedFeliz = await pdfParse(readFileSync(pdfPath!));
    const textoFeliz = parsedFeliz.text.replace(/\s+/g, ' ');
    expect(textoFeliz).toContain(FAMILIAR_NOME);
    expect(textoFeliz).toContain(PROFISSIONAL_NOME);
    expect(textoFeliz).toContain('Objetivo general PR-7 digitado por humano');
    await page.getByTestId('therapeutic-project-close').click();
    await expect(page.getByTestId('therapeutic-project-drawer')).toHaveCount(0);
  });

  test('alt 1: editando a vigente, MACRO renderiza como TEXTO (nenhum input/textarea/select desabilitado); mudar objetivo pela API dá 422 ptp_macro_locked', async ({ page, request }) => {
    await loginAs(page, { uid: completaUid, email: completaEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${seed.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('tp-edit-btn').click(); // card-level: edita a versão em andamento (V1.0)
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('data-mode', 'edit');
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });

    // MACRO como TEXTO: os 5 campos travados existem como `Text`/`ul`, nunca como controle editável.
    await expect(page.getByTestId('tp-service-locked')).toBeVisible();
    await expect(page.getByTestId('tp-clinicalContext-locked')).toContainText('Sintesis clinica PR-7 digitada por humano');
    await expect(page.getByTestId('tp-generalObjective-locked')).toContainText('Objetivo general PR-7 digitado por humano');
    await expect(page.getByTestId('tp-specificObjectives-locked')).toBeVisible();
    await expect(page.getByTestId('tp-activities-locked')).toBeVisible();
    // D328/R5, régua dura: NENHUM input/textarea/select desabilitado ou readonly no drawer inteiro.
    await expect(drawer.locator('input:disabled, textarea:disabled, select:disabled, [readonly]')).toHaveCount(0);
    // MICRO continua editável: modalidade é um <select> normal, sem trava.
    await expect(page.getByTestId('tp-modality')).toBeEnabled();

    await page.getByTestId('therapeutic-project-close').click();
    await expect(drawer).toHaveCount(0);

    // Prova de R4 no BACKEND (não só na tela): mesmo corpo MACRO da V1.0, só `generalObjective` muda.
    const res = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/therapeutic-projects`, {
      headers: { Authorization: `Bearer ${tokenFor({ uid: completaUid, email: completaEmail, role: 'admin', country: 'AR' })}` },
      data: {
        mode: 'edit',
        fromVersionId: v10,
        version: {
          contractedServiceId: serviceId,
          modality: 'HYBRID',
          diagnoses: [{ uri: ICD_URI, title: ICD_TITLE }],
          clinicalContext: 'Sintesis clinica PR-7 digitada por humano',
          generalObjective: 'Objetivo general PR-7 digitado por humano — TENTATIVA DE FRAUDE',
          specificObjectiveIds: await specificObjectiveIdsDaV10(),
          activityIds: await activityIdsDaV10(),
          startDate: '2026-01-09',
          endDate: '2026-12-31',
          contactRefs: [],
          careTeamIds: [],
        },
      },
    });
    expect(res.status()).toBe(422);
    const errBody = (await res.json()) as { code: string; details: { fields: string[] } };
    expect(errBody.code).toBe('ptp_macro_locked');
    expect(errBody.details.fields).toContain('generalObjective');

    // Nenhuma versão nova nasceu da tentativa.
    const total = Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`));
    expect(total).toBe(1);
  });

  test('alt 2: desativar o familiar pela Rede de Apoio — NENHUMA versão nova, V1.0 intacta, card mostra inativo, PDF sem o nome (imprime "Contacto dado de baja")', async ({ page }) => {
    const antesLinhas = runSQL(`SELECT id || '|' || general_objective || '|' || created_at FROM patient_therapeutic_projects WHERE id = '${v10}'`).trim();
    const antesCount = Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`));
    expect(antesCount).toBe(1);

    await loginAs(page, { uid: completaUid, email: completaEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /Red de Apoyo/i }).click();
    const extCard = page.getByTestId('external-contacts-card');
    await expect(extCard).toBeVisible({ timeout: 30_000 });
    await expect(extCard).toContainText(FAMILIAR_NOME);

    await page.getByTestId('edit-external-contacts-btn').click();
    const pxcDrawer = page.getByTestId('patient-external-contacts-edit-drawer');
    await expect(pxcDrawer).toBeVisible();
    await expect(page.getByTestId('pxc-name-0')).toHaveValue(FAMILIAR_NOME);
    await page.getByTestId('pxc-remove-0').click(); // marca para desativar (a linha some da lista do form)
    const deactivateReq = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/patients/${seed.patientId}/external-contacts/${familiarId}/deactivate`));
    await page.getByTestId('pxc-save').click();
    expect((await deactivateReq).status()).toBe(200);
    await expect(pxcDrawer).toHaveCount(0, { timeout: 15_000 });

    const inativo = scalar(`SELECT active FROM patient_external_contacts WHERE id = '${familiarId}'`);
    expect(inativo).toBe('f');

    // NENHUMA versão nova (D328/SUP-25) e a V1.0 fica byte-a-byte a mesma linha.
    const depoisCount = Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`));
    expect(depoisCount).toBe(1);
    const depoisLinhas = runSQL(`SELECT id || '|' || general_objective || '|' || created_at FROM patient_therapeutic_projects WHERE id = '${v10}'`).trim();
    expect(depoisLinhas).toBe(antesLinhas);

    // O card/versão mostra o contato inativo — abre a V1.0 no drawer e olha o bloco de contatos.
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`tp-view-${v10}`).click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('tpv-contacts')).toBeVisible();
    await expect(drawer.getByTestId('tpv-contacts')).not.toContainText(FAMILIAR_NOME);
    await expect(drawer.getByTestId('tpv-contacts')).toContainText(PROFISSIONAL_NOME); // o profissional NÃO foi tocado

    // Exporta o PDF de novo: sem o nome do familiar, com "Contacto dado de baja".
    const exportFetch = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes(`/therapeutic-projects/${v10}?purpose=export`));
    const download = page.waitForEvent('download');
    await page.getByTestId('therapeutic-project-export-btn').click();
    expect((await exportFetch).status()).toBe(200);
    const file = await download;
    const parsedAlt2 = await pdfParse(readFileSync((await file.path())!));
    const textoAlt2 = parsedAlt2.text.replace(/\s+/g, ' ');
    expect(textoAlt2).not.toContain(FAMILIAR_NOME);
    expect(textoAlt2).toContain('Contacto dado de baja');
    expect(textoAlt2).toContain(PROFISSIONAL_NOME);
  });

  test('alt 3: escrever direto na API numa versão que deixou de ser a vigente devolve 409 ptp_not_current', async ({ request }) => {
    const auth = { Authorization: `Bearer ${tokenFor({ uid: completaUid, email: completaEmail, role: 'admin', country: 'AR' })}` };
    // Edição MICRO válida (só `modality`) na V1.0 (ainda vigente) — cria V1.1 e torna a V1.0 "antiga".
    const okRes = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/therapeutic-projects`, {
      headers: auth,
      data: {
        mode: 'edit',
        fromVersionId: v10,
        version: {
          contractedServiceId: serviceId,
          modality: 'ONLINE',
          diagnoses: [{ uri: ICD_URI, title: ICD_TITLE }],
          clinicalContext: 'Sintesis clinica PR-7 digitada por humano',
          generalObjective: 'Objetivo general PR-7 digitado por humano',
          specificObjectiveIds: await specificObjectiveIdsDaV10(),
          activityIds: await activityIdsDaV10(),
          startDate: '2026-01-09',
          endDate: '2026-12-31',
          contactRefs: [],
          careTeamIds: [],
        },
      },
    });
    expect(okRes.status()).toBe(201);
    const v11 = ((await okRes.json()) as { data: { id: string; version: string } }).data;
    expect(v11.version).toBe('V.1.1');

    // Agora a V1.0 NÃO é mais a vigente: escrever nela (mesmo corpo válido) tem de ser recusado.
    const res409 = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/therapeutic-projects`, {
      headers: auth,
      data: {
        mode: 'edit',
        fromVersionId: v10,
        version: {
          contractedServiceId: serviceId,
          modality: 'IN_PERSON',
          diagnoses: [{ uri: ICD_URI, title: ICD_TITLE }],
          clinicalContext: 'Sintesis clinica PR-7 digitada por humano',
          generalObjective: 'Objetivo general PR-7 digitado por humano',
          specificObjectiveIds: await specificObjectiveIdsDaV10(),
          activityIds: await activityIdsDaV10(),
          startDate: '2026-01-09',
          endDate: '2026-12-31',
          contactRefs: [],
          careTeamIds: [],
        },
      },
    });
    expect(res409.status()).toBe(409);
    const err409 = (await res409.json()) as { code: string };
    expect(err409.code).toBe('ptp_not_current');

    // Banco: continua só 2 versões — nenhuma terceira nasceu da tentativa recusada.
    const total = Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`));
    expect(total).toBe(2);
  });

  test('extra: sem `patient_therapeutic_project:export`, o botão de exportar não existe no DOM (D269)', async ({ page }) => {
    await loginAs(page, { uid: semExportUid, email: semExportEmail, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${seed.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`tp-view-${v10}`).click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('therapeutic-project-export-btn')).toHaveCount(0);
  });

  // ── Helpers de dados (lidos do banco para reconstruir o corpo MACRO exato da V1.0 — `specific_objectives`/
  // `activities` são snapshot JSONB `[{id,label}]` na própria linha, migration 416, não tabela de junção) ──
  async function specificObjectiveIdsDaV10(): Promise<string[]> {
    const out = runSQL(`SELECT string_agg(elem->>'id', ',') FROM patient_therapeutic_projects, jsonb_array_elements(specific_objectives) elem WHERE id = '${v10}'`).trim();
    return out ? out.split(',') : [];
  }
  async function activityIdsDaV10(): Promise<string[]> {
    const out = runSQL(`SELECT string_agg(elem->>'id', ',') FROM patient_therapeutic_projects, jsonb_array_elements(activities) elem WHERE id = '${v10}'`).trim();
    return out ? out.split(',') : [];
  }
});

/**
 * Conserto 14/09 (achado do gate, decisão do Gabriel): dois cenários próprios, self-contained
 * (patient/contatos/grupo dedicados — não entram na cadeia serial do describe acima):
 *   1. "editar a vigente pela tela mudando só a modalidade mantém os 2 contatos na 1.1" — prova
 *      que `GET .../therapeutic-projects` devolve `contactRefs`/`careTeamIds` e que o form os usa
 *      pra reconstruir a seleção (não parte de vazio).
 *   2. "editar depois de desativar o familiar" — aviso `tp-form-contact-removed` visível, a minor
 *      nova (1.x) salva SEM o familiar (equipe intacta), e as versões de origem (1.0/1.1) ficam
 *      byte-a-byte as mesmas linhas (imutabilidade).
 * V1.0 nasce por API (setup, não o comportamento sob teste — mesmo molde do `alt 1`/`alt 3` acima,
 * que já fazem `request.post` direto); a EDIÇÃO em si (o que se prova) é 100% humana.
 */
test.describe('spec 018/PR-7 — conserto 14/09: editar a vigente mantém contatos; contato inativo sai com aviso @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let serviceId: string;
  let familiarId = '';
  let profissionalId = '';
  let objId = '';
  let actId = '';
  let v10 = '';
  let v10CreatedAt = '';
  let v11 = '';
  let v11CreatedAt = '';

  const FAMILIAR = 'Familiar Conserto14';
  const PROFISSIONAL = 'Profesional Conserto14';
  const uid = `e2e-pr7-c14-${RUN_ID}`;
  const email = `${uid}@e2e.test`;
  let groupId = '';

  const auth = () => ({ Authorization: `Bearer ${tokenFor({ uid, email, role: 'admin', country: 'AR' })}` });
  const corpoBase = (over: Record<string, unknown> = {}) => ({
    contractedServiceId: serviceId,
    modality: 'IN_PERSON',
    diagnoses: [{ uri: ICD_URI, title: ICD_TITLE }],
    clinicalContext: 'Sintesis clinica conserto 14/09',
    generalObjective: 'Objetivo general conserto 14/09',
    specificObjectiveIds: [objId],
    activityIds: [actId],
    startDate: '2026-01-09',
    endDate: '2026-12-31',
    contactRefs: [{ kind: 'EXTERNAL', id: familiarId }],
    careTeamIds: [profissionalId],
    ...over,
  });

  test.beforeAll(async ({ request }) => {
    seed = seedActivatablePatient(711000); // faixa própria — 700000-709999 e 710000-719999 são de outros arquivos
    seedIcd(); // idempotente (ON CONFLICT) — reaproveita ICD_URI/RELEASE já seedados pelo describe acima
    serviceId = runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-018-pr7', 'e2e-018-pr7') RETURNING id`).split('\n')[0].trim();
    expect(serviceId).toMatch(/^[0-9a-f-]{36}$/);
    familiarId = runSQL(`INSERT INTO patient_external_contacts (patient_id, relation, name, active, created_by) VALUES ('${seed.patientId}', 'OTHER', '${FAMILIAR}', true, 'e2e-018-pr7') RETURNING id`).split('\n')[0].trim();
    profissionalId = runSQL(`INSERT INTO patient_professionals (patient_id, name, source, active, created_by, specialty) VALUES ('${seed.patientId}', '${PROFISSIONAL}', 'admin_manual', true, 'e2e-018-pr7', 'PHYSIOTHERAPIST') RETURNING id`).split('\n')[0].trim();
    // Catálogo GLOBAL (não por paciente) — qualquer item ATIVO serve; os outros describes deste
    // arquivo já provam a seleção de catálogo em si.
    objId = scalar(`SELECT id FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order LIMIT 1`);
    actId = scalar(`SELECT id FROM therapeutic_activities WHERE active ORDER BY sort_order LIMIT 1`);
    expect(objId).toMatch(/^[0-9a-f-]{36}$/);
    expect(actId).toMatch(/^[0-9a-f-]{36}$/);

    psql(`INSERT INTO iam.permissions (resource, action, description, category) VALUES
            ('patient', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_therapeutic_project', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_therapeutic_project', 'write', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_clinical', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_clinical', 'write', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_family', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_family', 'write', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_care_team', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_services', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_coverage', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_address', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('patient_identity', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('catalog_therapeutic_objectives', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('catalog_therapeutic_activities', 'read', 'e2e PR-7 c14', 'Pacientes'),
            ('catalog_therapeutic_segments', 'read', 'e2e PR-7 c14', 'Pacientes')
          ON CONFLICT DO NOTHING`);
    groupId = seedStaffInGroup({ uid, email, groupName: `PR7 Conserto14 ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [resource, action] of [
      ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'],
      ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_family', 'read'], ['patient_family', 'write'],
      ['patient_care_team', 'read'], ['patient_services', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_identity', 'read'],
      ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'], ['catalog_therapeutic_segments', 'read'],
    ]) grantCell(groupId, resource, action);

    // V1.0 por API — setup (mesmo molde do `alt 1`/`alt 3` do describe acima), com os 2 contatos.
    const criado = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/therapeutic-projects`, {
      headers: auth(),
      data: { mode: 'new', version: corpoBase() },
    });
    expect(criado.status()).toBe(201);
    const bodyCriado = (await criado.json()) as { data: { id: string; version: string; createdAt: string } };
    expect(bodyCriado.data.version).toBe('V.1.0');
    v10 = bodyCriado.data.id;
    v10CreatedAt = bodyCriado.data.createdAt;
  });

  test.afterAll(() => {
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupIcd();
    cleanupStaffAndGroup(uid, groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name = 'PR7 Conserto14 ${RUN_ID}'`);
  });

  test('editar a vigente pela tela mudando só a modalidade mantém os 2 contatos na 1.1 (banco e card)', async ({ page }) => {
    await loginAs(page, { uid, email, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${seed.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('tp-edit-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('data-mode', 'edit');
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });

    // Nasce com os 2 contatos JÁ selecionados (lidos de `contactRefs`/`careTeamIds` do GET) — sem
    // aviso de contato removido (nenhum está inativo).
    await expect(page.locator('#tp-externalContacts')).toContainText(FAMILIAR);
    await expect(page.locator('#tp-careTeam')).toContainText(PROFISSIONAL);
    await expect(page.getByTestId('tp-form-contact-removed')).toHaveCount(0);

    // Muda SÓ a modalidade (MICRO) — não toca nos multi-selects de contato.
    await page.getByTestId('tp-modality').selectOption('ONLINE');
    await expect(page.getByTestId('tp-modality')).toHaveValue('ONLINE');
    await expect(page.getByTestId('tp-save')).toBeEnabled();

    const salvo = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const bodySalvo = (await (await salvo).json()) as { data: { id: string; version: string; createdAt: string } };
    expect(bodySalvo.data.version).toBe('V.1.1');
    v11 = bodySalvo.data.id;
    v11CreatedAt = bodySalvo.data.createdAt;

    // Banco: a 1.1 leva as MESMAS 2 ligações (kind/id) da 1.0.
    const ligacoes = runSQL(
      `SELECT contact_kind || ':' || COALESCE(external_contact_id::text, professional_id::text)
         FROM patient_therapeutic_project_contacts WHERE version_id = '${v11}' ORDER BY sort_order`,
    ).trim().split('\n').filter(Boolean);
    expect(ligacoes).toEqual([`EXTERNAL:${familiarId}`, `CARE_TEAM:${profissionalId}`]);

    // Salvar não fecha o drawer — troca pra `mode:'view'` com a versão recém-criada (mesmo molde
    // do `handleSubmit` do drawer: `setTarget({ mode: 'view', ... })`). Fecha explicitamente antes
    // de reabrir pela linha do card, como o `feliz` acima faz.
    await page.getByTestId('therapeutic-project-close').click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`tp-view-${v11}`).click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('tpv-contacts')).toContainText(FAMILIAR);
    await expect(drawer.getByTestId('tpv-contacts')).toContainText(PROFISSIONAL);
    await page.getByTestId('therapeutic-project-close').click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
  });

  test('editar depois de desativar o familiar: aviso visível, a minor nova salva sem o familiar, 1.0/1.1 ficam intactas', async ({ page, request }) => {
    // Desativa o familiar por API (setup — o comportamento "não gera versão" já está provado no
    // `alt 2` do describe acima, pela tela; aqui o foco é o EDITAR que vem depois).
    const desativado = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/external-contacts/${familiarId}/deactivate`, { headers: auth() });
    expect(desativado.status()).toBe(200);
    const inativo = scalar(`SELECT active FROM patient_external_contacts WHERE id = '${familiarId}'`);
    expect(inativo).toBe('f');

    await loginAs(page, { uid, email, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${seed.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('tp-edit-btn').click(); // edita a vigente (V1.1)
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });

    // Aviso visível, nomeando o container (sem nome do contato — lex #7 C7) e a contagem.
    const aviso = page.getByTestId('tp-form-contact-removed');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('Contactos externos');
    await expect(aviso).toContainText('(1)');
    // O familiar SOME da seleção; a equipe (não tocada) continua.
    await expect(page.locator('#tp-externalContacts')).not.toContainText(FAMILIAR);
    await expect(page.locator('#tp-careTeam')).toContainText(PROFISSIONAL);

    await expect(page.getByTestId('tp-save')).toBeEnabled();
    const salvo = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const bodySalvo = (await (await salvo).json()) as { data: { id: string; version: string } };
    expect(bodySalvo.data.version).toBe('V.1.2');
    const v12 = bodySalvo.data.id;

    // Banco: a 1.2 leva SÓ a ligação da equipe — nenhuma do familiar (inativo).
    const ligacoes = runSQL(
      `SELECT contact_kind || ':' || COALESCE(external_contact_id::text, professional_id::text)
         FROM patient_therapeutic_project_contacts WHERE version_id = '${v12}' ORDER BY sort_order`,
    ).trim().split('\n').filter(Boolean);
    expect(ligacoes).toEqual([`CARE_TEAM:${profissionalId}`]);

    // 1.0 e 1.1 ficam byte-a-byte as mesmas linhas (imutabilidade) — mesmo `created_at` capturado
    // na criação de cada uma, e as duas ligações ORIGINAIS da 1.1 continuam intactas.
    const v10Depois = runSQL(`SELECT created_at FROM patient_therapeutic_projects WHERE id = '${v10}'`).trim();
    const v11Depois = runSQL(`SELECT created_at FROM patient_therapeutic_projects WHERE id = '${v11}'`).trim();
    expect(new Date(v10Depois).toISOString()).toBe(new Date(v10CreatedAt).toISOString());
    expect(new Date(v11Depois).toISOString()).toBe(new Date(v11CreatedAt).toISOString());
    const ligacoesV11Depois = runSQL(
      `SELECT contact_kind || ':' || COALESCE(external_contact_id::text, professional_id::text)
         FROM patient_therapeutic_project_contacts WHERE version_id = '${v11}' ORDER BY sort_order`,
    ).trim().split('\n').filter(Boolean);
    expect(ligacoesV11Depois).toEqual([`EXTERNAL:${familiarId}`, `CARE_TEAM:${profissionalId}`]);

    const total = Number(runSQL(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`));
    expect(total).toBe(3); // v10, v11, v12
  });
});

/**
 * Conserto 14/09 (achado do gate, Gabriel 14/09): cenário PRÓPRIO, self-contained — cria a V1.0
 * PELA TELA com 2 contatos e clica "Editar" IMEDIATAMENTE (drawer nunca fecha, sem `page.goto` nem
 * reload), o exato caminho que quebrava antes do conserto: o form nascia de `created.contacts ?? []`
 * (a resposta CRUA do POST) em vez de esperar o refetch. Prova que hoje `created` já vem completo
 * (`contactRefs`/`careTeamIds`/`contacts` resolvidos, contract §POST) — o form de edição nasce com
 * os 2 já selecionados, e salvar grava a 1.1 no banco com os DOIS.
 */
test.describe('spec 018/PR-7 — conserto 14/09: criar com 2 contatos e clicar Editar IMEDIATAMENTE (sem recarregar) mantém a seleção @integration', () => {
  test.setTimeout(300_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let serviceId: string;
  let familiarId = '';
  let profissionalId = '';
  let v10 = '';
  let v11 = '';

  const FAMILIAR = 'Familiar Imediato14';
  const PROFISSIONAL = 'Profesional Imediato14';
  const uid = `e2e-pr7-imediato14-${RUN_ID}`;
  const email = `${uid}@e2e.test`;
  let groupId = '';

  test.beforeAll(() => {
    seed = seedActivatablePatient(712000); // faixa própria — 710000/711000 já usadas neste arquivo
    seedIcd(); // idempotente (ON CONFLICT) — reaproveita ICD_URI/RELEASE já seedados acima
    serviceId = runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-018-pr7', 'e2e-018-pr7') RETURNING id`).split('\n')[0].trim();
    expect(serviceId).toMatch(/^[0-9a-f-]{36}$/);
    familiarId = runSQL(`INSERT INTO patient_external_contacts (patient_id, relation, name, active, created_by) VALUES ('${seed.patientId}', 'OTHER', '${FAMILIAR}', true, 'e2e-018-pr7') RETURNING id`).split('\n')[0].trim();
    profissionalId = runSQL(`INSERT INTO patient_professionals (patient_id, name, source, active, created_by, specialty) VALUES ('${seed.patientId}', '${PROFISSIONAL}', 'admin_manual', true, 'e2e-018-pr7', 'PHYSIOTHERAPIST') RETURNING id`).split('\n')[0].trim();
    expect(profissionalId).toMatch(/^[0-9a-f-]{36}$/);

    psql(`INSERT INTO iam.permissions (resource, action, description, category) VALUES
            ('patient', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_therapeutic_project', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_therapeutic_project', 'write', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_clinical', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_clinical', 'write', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_family', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_family', 'write', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_care_team', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_services', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_coverage', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_address', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('patient_identity', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('catalog_therapeutic_objectives', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('catalog_therapeutic_activities', 'read', 'e2e PR-7 imediato14', 'Pacientes'),
            ('catalog_therapeutic_segments', 'read', 'e2e PR-7 imediato14', 'Pacientes')
          ON CONFLICT DO NOTHING`);
    groupId = seedStaffInGroup({ uid, email, groupName: `PR7 Imediato14 ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [resource, action] of [
      ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'],
      ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_family', 'read'], ['patient_family', 'write'],
      ['patient_care_team', 'read'], ['patient_services', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_identity', 'read'],
      ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'], ['catalog_therapeutic_segments', 'read'],
    ]) grantCell(groupId, resource, action);
  });

  test.afterAll(() => {
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupIcd();
    cleanupStaffAndGroup(uid, groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name = 'PR7 Imediato14 ${RUN_ID}'`);
  });

  test('criar com 2 contatos e clicar Editar IMEDIATAMENTE (sem recarregar) → os 2 contatos estão selecionados → salvar modalidade → 1.1 no banco com os 2 contatos', async ({ page }) => {
    await loginAs(page, { uid, email, role: 'admin', country: 'AR' });
    await page.goto(`/admin/patients/${seed.patientId}`);
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tp-new-btn').click();

    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tp-save')).toBeDisabled();

    await expect(page.getByTestId('tp-service')).toHaveValue(serviceId);
    await page.getByTestId('tp-modality').selectOption('IN_PERSON');

    const search = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()));
    await page.getByTestId('tp-icd-input').click();
    await page.keyboard.type('sintetico pr-7');
    expect((await search).status()).toBe(200);
    const opcaoIcd = page.getByTestId('tp-icd-option-0');
    await expect(opcaoIcd).toBeVisible({ timeout: 10_000 });
    await opcaoIcd.click();
    await expect(page.getByTestId('tp-diagnosis-chip')).toHaveCount(1);

    expect(await digitar(page, '#tp-clinicalContext', 'Sintesis clinica imediato14')).toBe('Sintesis clinica imediato14');
    expect(await digitar(page, '#tp-generalObjective', 'Objetivo general imediato14')).toBe('Objetivo general imediato14');
    await marcarPrimeiras(page, 'tp-specificObjectives', 1);
    await marcarPrimeiras(page, 'tp-activities', 1);
    await page.locator('#tp-startDate').click();
    await page.keyboard.type('09012026');
    await page.locator('#tp-endDate').click();
    await page.keyboard.type('12312026');
    await expect(page.locator('#tp-endDate')).toHaveValue('2026-12-31');

    // Os 2 contatos, pela tela.
    await marcarPorTexto(page, 'tp-externalContacts', FAMILIAR);
    await marcarPorTexto(page, 'tp-careTeam', PROFISSIONAL);
    await expect(page.locator('#tp-externalContacts')).toContainText(FAMILIAR);
    await expect(page.locator('#tp-careTeam')).toContainText(PROFISSIONAL);
    await expect(page.getByTestId('tp-save')).toBeEnabled();

    const criado = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const bodyCriado = (await (await criado).json()) as {
      data: { id: string; version: string; contacts: Array<{ kind: string; id: string; name?: string }> };
    };
    expect(bodyCriado.data.version).toBe('V.1.0');
    v10 = bodyCriado.data.id;
    // O 201 já vem com os 2 contatos resolvidos (conserto 14/09) — sem isso o `TherapeuticProjectDrawer`
    // partia de `created.contacts ?? []` (vazio) ao entrar em modo "Editar" logo a seguir.
    expect(bodyCriado.data.contacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'EXTERNAL', id: familiarId, name: FAMILIAR }),
      expect.objectContaining({ kind: 'CARE_TEAM', id: profissionalId, name: PROFISSIONAL }),
    ]));

    // O drawer troca para `mode:'view'` da MESMA versão — sem fechar, sem `page.goto`, sem reload.
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    await expect(drawer.getByTestId('tpv-contacts')).toContainText(FAMILIAR);
    await expect(drawer.getByTestId('tpv-contacts')).toContainText(PROFISSIONAL);

    // Clica "Editar" IMEDIATAMENTE — é o gatilho exato do achado do gate.
    await page.getByTestId('therapeutic-project-edit-btn').click();
    await expect(drawer).toHaveAttribute('data-mode', 'edit');
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });

    // Os 2 contatos JÁ estão selecionados no form de edição — nascidos da resposta do POST, sem
    // nenhum refetch/GET intermediário (nenhum aviso de "contato removido", nenhum vazio).
    await expect(page.locator('#tp-externalContacts')).toContainText(FAMILIAR);
    await expect(page.locator('#tp-careTeam')).toContainText(PROFISSIONAL);
    await expect(page.getByTestId('tp-form-contact-removed')).toHaveCount(0);

    // Muda só a modalidade (MICRO) e salva — a minor nova tem de levar os DOIS contatos.
    await page.getByTestId('tp-modality').selectOption('ONLINE');
    await expect(page.getByTestId('tp-modality')).toHaveValue('ONLINE');
    await expect(page.getByTestId('tp-save')).toBeEnabled();
    const salvo = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-projects$/.test(r.url()));
    await page.getByTestId('tp-save').click();
    const bodySalvo = (await (await salvo).json()) as { data: { id: string; version: string; editedFromVersionId: string | null } };
    expect(bodySalvo.data.version).toBe('V.1.1');
    expect(bodySalvo.data.editedFromVersionId).toBe(v10); // a minor nasce da MESMA major criada pela tela
    v11 = bodySalvo.data.id;

    // Banco: a 1.1 leva as DUAS ligações (kind/id) — nunca gravada "sem eles" (o defeito original).
    const ligacoes = runSQL(
      `SELECT contact_kind || ':' || COALESCE(external_contact_id::text, professional_id::text)
         FROM patient_therapeutic_project_contacts WHERE version_id = '${v11}' ORDER BY sort_order`,
    ).trim().split('\n').filter(Boolean);
    expect(ligacoes).toEqual([`EXTERNAL:${familiarId}`, `CARE_TEAM:${profissionalId}`]);
  });
});
