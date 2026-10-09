/**
 * pt-todavia-no-hay-048.integration.e2e.ts @integration — spec 048: "Todavía no hay registro" / "No necesita" nos
 * 4 campos de contato do Projeto Terapêutico + lembrete no sino.
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo
 * (células concedidas por SQL), clique/teclado de humano (`loginAs`, `keyboard.type`, `selectOption`).
 *
 *  feliz — operador marca "Todavía no hay registro" em Responsables e Equipo tratante -> o aviso de 15 dias aparece
 *          sob o campo -> Guardar -> a confirmação DENTRO do drawer lista os 2 campos e as datas -> "Crear igual" ->
 *          a leitura mostra "Todavía no hay registro — vence el DD/MM". Depois o lembrete do dia 2 é adiantado no
 *          banco, a varredura é disparada pelo endpoint interno (segredo do compose) e o sino mostra "Caso EN…"
 *          e NUNCA o nome do paciente.
 *  alt 1 — "No necesita": quem NÃO tem `patient_therapeutic_project:waive_contact` não vê a opção (0 no DOM) e,
 *          forçando pela API, leva 403 nomeando a célula; o Master vê as 4 opções, marca e a leitura mostra "No necesita".
 *  alt 2 — em versão nova, preencher o campo pendente (escolher um profissional) tira o pendente daquele campo,
 *          enquanto o outro continua "Todavía no hay registro" com o MESMO vencimento (o prazo não reinicia).
 *
 * ⚠️ Precisa do engine ABAC LIGADO (alt 1 mede AUSÊNCIA por falta de célula; com o engine OFF `cells===null` mostra
 * tudo) — por isso o nome entra no `--grep` do job `integration-e2e-group-simulation` do `_frontend-integration.yml`
 * (e NÃO no `grep:` do `pr-gate.yml`, que roda com o engine OFF).
 *
 * Nenhum canal real: só Postgres (o "aviso" é uma linha em `notifications`, o sino). Sem e-mail, sem WhatsApp, sem
 * Google, sem Ana Care. Rodar local = o job do CI: `ABAC_API_URL`, `ABAC_TEST_DB_URL`, `E2E_PG_CONTAINER`, `E2E_BACKEND_URL`.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, ABAC_API_URL, ABAC_TENANT,
} from '../helpers/abac-stack-helper';
import { primeiroSegmento } from '../helpers/pti-segmento-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const ICD_URI = `http://id.who.int/icd/entity/e2e-048-${RUN_ID}`;
const CAP06_URI = `http://id.who.int/icd/entity/e2e-048-cap06-${RUN_ID}`;
const CAP06_TITLE = `Trastornos mentales, del comportamiento y del neurodesarrollo (e2e 048 ${RUN_ID})`;
const ICD_TITLE = `Trastorno sintético 048 ${RUN_ID}`;
const RELEASE = `e048-${RUN_ID}`;
const PROFISSIONAL_NOME = 'Profesional QA 048';
const CASE_NUMBER = 1048;
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET ?? 'test-secret-for-e2e-only';
const OPEN_ROUTE = /\/therapeutic-projects$/;

const LABEL_PENDING = 'Todavía no hay registro';
const LABEL_WAIVED = 'No necesita';

/** Dia civil de Buenos Aires (a régua do formulário) + N dias, em DD/MM — o que a tela mostra. */
function ddmmEmDias(n: number): string {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = hoje.split('-').map(Number);
  const alvo = new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  return `${alvo.slice(8, 10)}/${alvo.slice(5, 7)}`;
}

async function digitar(page: Page, selector: string, texto: string): Promise<void> {
  const campo = page.locator(selector);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
}

async function marcarPrimeiras(page: Page, id: string, n: number): Promise<void> {
  const root = page.locator(`#${id}`);
  await root.locator('button[aria-haspopup="listbox"]').click();
  const opcoes = root.locator('[role="option"] button');
  await expect(opcoes.first()).toBeVisible();
  for (let i = 0; i < n; i++) await opcoes.nth(i).click();
  await fecharLista(page);
}

/**
 * Fecha a lista aberta clicando FORA dela (o `MultiSelect` fecha no mousedown externo). NUNCA `Escape`: o drawer escuta
 * Esc no `document` e, com o formulário sujo, abre o "descartar alterações" por cima de tudo (medido nesta spec).
 */
async function fecharLista(page: Page): Promise<void> {
  await page.getByTestId('therapeutic-project-subtitle').click();
}

async function marcarPorTexto(page: Page, id: string, texto: string): Promise<void> {
  const root = page.locator(`#${id}`);
  await root.locator('button[aria-haspopup="listbox"]').click();
  const opcao = root.locator('li[role="option"]', { hasText: texto });
  await expect(opcao).toBeVisible({ timeout: 10_000 });
  await opcao.locator('button').click();
  await fecharLista(page);
}

/** O container de UM campo de contato (`tp-field-<chave>`) — as 4 caixas têm o mesmo rótulo, o escopo é obrigatório. */
const campo = (page: Page, chave: string) => page.getByTestId(`tp-field-${chave}`);

/**
 * Clica no RÓTULO da caixa (o gesto de uma pessoa): o `<input>` real é `sr-only` e a caixa desenhada por cima
 * intercepta o ponteiro, então `.check()` no input não é o que o operador faz. O estado é lido da TELA depois.
 */
async function alternar(escopo: ReturnType<typeof campo>, rotulo: string): Promise<void> {
  // Só dentro do <label>: travado, o select também mostra o estado como texto (não é alvo de clique).
  await escopo.locator('label').getByText(rotulo, { exact: true }).click();
}

/** Preenche o "Nuevo" até só faltar o que o teste decide (contatos). */
async function preencherNuevo(page: Page, serviceId: string): Promise<void> {
  await page.getByTestId('tp-new-btn').click();
  await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('tp-service')).toHaveValue(serviceId);
  await page.getByTestId('tp-modality').selectOption('HYBRID');
  // Segmento (MACRO, obrigatório no "Nuevo"): `selectOption` pelo rótulo — o type-ahead do select nativo não é confiável no
  // Chromium/Linux do CI (medido: o valor ficou vazio no runner), e o segmento não é o que esta spec mede.
  const segmento = primeiroSegmento().label;
  await page.locator('#tp-segment').selectOption({ label: segmento });
  await expect(page.locator('#tp-segment').locator('option:checked')).toHaveText(segmento);
  const search = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()));
  await page.getByTestId('tp-icd-input').click();
  await page.keyboard.type('sintetico 048');
  expect((await search).status()).toBe(200);
  await page.getByTestId('tp-icd-option-0').click();
  await digitar(page, '#tp-clinicalContext', 'Sintesis clinica 048 digitada por humano');
  await digitar(page, '#tp-generalObjective', 'Objetivo general 048 digitado por humano');
  await marcarPrimeiras(page, 'tp-specificObjectives', 1);
  await marcarPrimeiras(page, 'tp-activities', 1);
  await page.locator('#tp-startDate').click();
  await page.keyboard.type('09012026');
  await page.locator('#tp-endDate').click();
  await page.keyboard.type('12312026');
  await expect(page.locator('#tp-endDate')).toHaveValue('2026-12-31');
}

test.use({ viewport: { width: 1600, height: 1100 } });

test.describe('PT — "Todavía no hay registro" / "No necesita" nos contatos + lembrete no sino (spec 048) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let serviceId: string;
  let profissionalId = '';
  const operadorUid = `e2e-048-operador-${RUN_ID}`;
  const operadorEmail = `${operadorUid}@e2e.test`;
  const masterUid = `e2e-048-master-${RUN_ID}`;
  const masterEmail = `${masterUid}@e2e.test`;
  let operadorGroupId = '';
  let masterGroupId = '';
  let v10 = '';
  const operador = { uid: operadorUid, email: operadorEmail, role: 'admin', country: 'AR' };
  const master = { uid: masterUid, email: masterEmail, role: 'admin', country: 'AR' };

  const CELULAS_BASE: Array<[string, string]> = [
    ['patient', 'read'], ['patient_identity', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'],
    ['patient_services', 'read'], ['patient_family', 'read'], ['patient_care_team', 'read'],
    ['patient_clinical', 'read'], ['patient_clinical', 'write'],
    ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'create'], ['patient_therapeutic_project', 'update'],
    ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'], ['catalog_therapeutic_segments', 'read'],
    ['own_notifications', 'read'], ['own_notifications', 'update'],
  ];

  test.beforeAll(() => {
    seed = seedActivatablePatient(720000);
    safeSql(`UPDATE patients SET case_number = ${CASE_NUMBER} WHERE id = '${seed.patientId}'`);
    runSQL(`INSERT INTO terminology.icd_releases (release, entity_count, is_current, promoted_at, promoted_by) VALUES ('${RELEASE}', 1, true, now(), 'e2e-048') ON CONFLICT (release) DO UPDATE SET is_current = true, promoted_at = now(), promoted_by = 'e2e-048'`);
    runSQL(`INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) VALUES ('${ICD_URI}', '${RELEASE}', '6E48', '${ICD_TITLE}', 'Synthetic disorder 048', '06', NULL, 'stem', true) ON CONFLICT (icd_uri, release) DO NOTHING`);
    runSQL(`INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) SELECT '${CAP06_URI}', '${RELEASE}', '06', '${CAP06_TITLE}', NULL, '06', NULL, 'chapter', false WHERE NOT EXISTS (SELECT 1 FROM terminology.icd_entities WHERE release = '${RELEASE}' AND kind = 'chapter' AND code = '06')`);
    serviceId = runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-048', 'e2e-048') RETURNING id`).split('\n')[0].trim();
    profissionalId = runSQL(`INSERT INTO patient_professionals (patient_id, name, source, active, created_by, specialty) VALUES ('${seed.patientId}', '${PROFISSIONAL_NOME}', 'admin_manual', true, 'e2e-048', 'PHYSIOTHERAPIST') RETURNING id`).split('\n')[0].trim();
    expect(profissionalId).toMatch(/^[0-9a-f-]{36}$/);

    operadorGroupId = seedStaffInGroup({ uid: operadorUid, email: operadorEmail, groupName: `PT048 Operador ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of CELULAS_BASE) grantCell(operadorGroupId, r, a);
    masterGroupId = seedStaffInGroup({ uid: masterUid, email: masterEmail, groupName: `PT048 Master ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of CELULAS_BASE) grantCell(masterGroupId, r, a);
    grantCell(masterGroupId, 'patient_therapeutic_project', 'waive_contact');
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM notification_events WHERE patient_id = '${seed.patientId}'`);
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    safeSql(`DELETE FROM terminology.icd_entities WHERE icd_uri IN ('${ICD_URI}', '${CAP06_URI}')`);
    safeSql(`DELETE FROM terminology.icd_releases WHERE release = '${RELEASE}'`);
    cleanupStaffAndGroup(operadorUid, operadorGroupId);
    cleanupStaffAndGroup(masterUid, masterGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'PT048 % ${RUN_ID}'`);
  });

  test('feliz: marca "Todavía no hay registro" em 2 campos -> aviso de 15 dias -> confirma no drawer -> cria -> a leitura mostra o vencimento; o lembrete chega ao sino com o Caso (nunca o nome)', async ({ page, request }) => {
    await loginAs(page, operador);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await preencherNuevo(page, serviceId);

    // Responsables: marca -> o select desabilita e o aviso aparece SOB o campo.
    const responsables = campo(page, 'responsibles');
    await alternar(responsables, LABEL_PENDING);
    await expect(responsables.getByLabel(LABEL_PENDING, { exact: true })).toBeChecked();
    await expect(responsables.getByTestId('tp-responsibles-deadline')).toHaveText('Tenés 15 días para completar este campo.');
    await expect(page.locator('#tp-responsibles button[aria-haspopup="listbox"]')).toBeDisabled();
    const equipo = campo(page, 'careTeam');
    await alternar(equipo, LABEL_PENDING);
    await expect(equipo.getByLabel(LABEL_PENDING, { exact: true })).toBeChecked();
    await expect(equipo.getByTestId('tp-careTeam-deadline')).toBeVisible();
    // Sem a célula `waive_contact` a outra opção nem existe no DOM.
    await expect(page.getByTestId('therapeutic-project-drawer').getByLabel(LABEL_WAIVED, { exact: true })).toHaveCount(0);

    // Guardar abre a confirmação DENTRO do drawer (não `window.confirm`) e NADA foi enviado ainda.
    let postsAntes = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && OPEN_ROUTE.test(r.url())) postsAntes += 1; });
    page.on('dialog', () => { throw new Error('window.confirm/alert não pode ser usado'); });
    await page.getByTestId('tp-save').click();
    const confirmacao = page.getByTestId('pending-contacts-confirm');
    await expect(confirmacao).toBeVisible();
    const vence = ddmmEmDias(15);
    await expect(confirmacao.getByTestId('pending-contacts-list')).toContainText(`Responsables — vence el ${vence}`);
    await expect(confirmacao.getByTestId('pending-contacts-list')).toContainText(`Equipo tratante — vence el ${vence}`);
    await expect(confirmacao.getByTestId('pending-contacts-reminders')).toContainText([ddmmEmDias(2), ddmmEmDias(5), ddmmEmDias(12)].join(', '));
    expect(postsAntes, 'a API não foi chamada antes do "Crear igual"').toBe(0);

    const created = page.waitForResponse((r) => r.request().method() === 'POST' && OPEN_ROUTE.test(r.url()));
    await confirmacao.getByRole('button', { name: 'Crear igual', exact: true }).click();
    const resposta = await created;
    expect(resposta.status()).toBe(201);
    const corpo = (await resposta.json()) as { data: { id: string; version: string; contactStatus: Array<{ kind: string; status: string; deadlineDate: string }> } };
    expect(corpo.data.version).toBe('V.1.0');
    expect(corpo.data.contactStatus.map((c) => c.kind)).toEqual(['RESPONSIBLE', 'CARE_TEAM']);
    v10 = corpo.data.id;

    // A leitura (modo view, no mesmo drawer) mostra o estado e o vencimento no lugar da lista vazia.
    await expect(page.getByTestId('therapeutic-project-drawer')).toHaveAttribute('data-mode', 'view');
    await expect(page.getByTestId('tpv-contact-status-RESPONSIBLE')).toContainText(`${LABEL_PENDING} — vence el ${vence}`);
    await expect(page.getByTestId('tpv-contact-status-CARE_TEAM')).toContainText(`${LABEL_PENDING} — vence el ${vence}`);
    expect(scalar(`SELECT count(*) FROM patient_tp_contact_reminders r JOIN patient_tp_contact_reminder_cycles c ON c.id = r.cycle_id WHERE c.patient_id = '${seed.patientId}'`)).toBe('3');
    await page.getByTestId('therapeutic-project-close').click();
    await expect(page.getByTestId('therapeutic-project-drawer')).toHaveCount(0);

    // Lembrete do dia 2: sem relógio real — adianta o `due_at` e dispara a varredura pelo endpoint interno.
    psql(`UPDATE patient_tp_contact_reminders SET due_at = now() - interval '1 hour'
          WHERE day_offset = 2 AND cycle_id IN (SELECT id FROM patient_tp_contact_reminder_cycles WHERE patient_id = '${seed.patientId}')`);
    const sweep = await request.post(`${ABAC_API_URL}/api/internal/therapeutic-projects/contact-reminders/sweep`, { headers: { 'X-Internal-Secret': INTERNAL_SECRET } });
    expect(sweep.status()).toBe(200);
    expect(await sweep.json()).toMatchObject({ sent: expect.any(Number), failed: 0 });

    await page.reload();
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('notification-bell-btn').click();
    const cartao = page.locator('[data-testid^="notification-item-"]').first();
    await expect(cartao).toBeVisible({ timeout: 15_000 });
    await expect(cartao).toContainText(`Caso EN${CASE_NUMBER}`);
    await expect(cartao).toContainText('Proyecto terapéutico: faltan Responsables, Equipo tratante');
    await expect(cartao).not.toContainText('BlocoC'); // nunca o nome do paciente
    await expect(cartao).not.toContainText('system:pt-contact-reminders');
  });

  test('alt 1: "No necesita" só com a célula — o operador não vê a opção e leva 403 se forçar; o Master vê, marca e a leitura mostra "No necesita"', async ({ page: paginaOperador, request, browser }) => {
    let page = paginaOperador;
    // Operador SEM waive_contact: 0 opções "No necesita" nos 4 campos.
    await loginAs(page, operador);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tp-new-btn').click();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('therapeutic-project-drawer').getByLabel(LABEL_WAIVED, { exact: true })).toHaveCount(0);
    // Controle positivo: a outra opção do MESMO campo existe (o teste enxerga a caixa que deveria ter).
    await expect(campo(page, 'coverageContacts').getByLabel(LABEL_PENDING, { exact: true })).toHaveCount(1);

    // Forçando pela API: 403 nomeando a célula, e nada é gravado.
    const antes = scalar(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`);
    // O corpo é VÁLIDO (objetivos/atividades da V1.0, texto igual): o 403 vem da CÉLULA, não do schema.
    const objetivos = scalar(`SELECT jsonb_path_query_array(specific_objectives, '$[*].id') #>> '{}' FROM patient_therapeutic_projects WHERE id = '${v10}'`);
    const atividades = scalar(`SELECT jsonb_path_query_array(activities, '$[*].id') #>> '{}' FROM patient_therapeutic_projects WHERE id = '${v10}'`);
    const forcadoValido = await request.post(`${ABAC_API_URL}/api/admin/patients/${seed.patientId}/therapeutic-projects`, {
      headers: { Authorization: `Bearer ${tokenFor(operador)}` },
      data: {
        mode: 'edit', fromVersionId: v10,
        version: {
          contractedServiceId: serviceId, modality: 'ONLINE', diagnoses: [{ uri: ICD_URI, title: ICD_TITLE }],
          clinicalContext: 'Sintesis clinica 048 digitada por humano', generalObjective: 'Objetivo general 048 digitado por humano',
          specificObjectiveIds: JSON.parse(objetivos), activityIds: JSON.parse(atividades), startDate: '2026-01-09', endDate: '2026-12-31',
          contactRefs: [], careTeamIds: [], contactStatus: { RESPONSIBLE: 'PENDING', CARE_TEAM: 'PENDING', COVERAGE: 'NOT_NEEDED' },
        },
      },
    });
    expect(forcadoValido.status()).toBe(403);
    expect(((await forcadoValido.json()) as { details: { cell: string } }).details.cell).toBe('patient_therapeutic_project:waive_contact');
    expect(scalar(`SELECT count(*) FROM patient_therapeutic_projects WHERE patient_id = '${seed.patientId}'`)).toBe(antes);

    // Master COM a célula: OUTRA sessão de navegador (o operador continua logado na primeira), mesma ficha.
    const contextoMaster = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    page = await contextoMaster.newPage();
    await loginAs(page, master);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tp-edit-btn').click();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('therapeutic-project-drawer').getByLabel(LABEL_WAIVED, { exact: true })).toHaveCount(4);
    const cobertura = campo(page, 'coverageContacts');
    await alternar(cobertura, LABEL_WAIVED);
    await expect(cobertura.getByLabel(LABEL_WAIVED, { exact: true })).toBeChecked();
    await expect(cobertura.getByLabel(LABEL_PENDING, { exact: true })).not.toBeChecked();
    await expect(page.locator('#tp-coverageContacts button[aria-haspopup="listbox"]')).toBeDisabled();
    await page.getByTestId('tp-modality').selectOption('ONLINE');

    // Já havia campos pendentes (Responsables, Equipo): a confirmação aparece e traz os vencimentos REAIS (herdados).
    await page.getByTestId('tp-save').click();
    const confirmacao = page.getByTestId('pending-contacts-confirm');
    await expect(confirmacao).toBeVisible();
    await expect(confirmacao.getByTestId('pending-contacts-list')).not.toContainText('Contactos de la cobertura');
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && OPEN_ROUTE.test(r.url()));
    await confirmacao.getByRole('button', { name: 'Crear igual', exact: true }).click();
    expect((await created).status()).toBe(201);
    await expect(page.getByTestId('tpv-contact-status-COVERAGE')).toContainText(`Contactos de la cobertura: ${LABEL_WAIVED}`);
    // "No necesita" não abre ciclo novo: continua 1 só (os campos pendentes herdaram o dele).
    expect(scalar(`SELECT count(*) FROM patient_tp_contact_reminder_cycles WHERE patient_id = '${seed.patientId}'`)).toBe('1');
    await contextoMaster.close();
  });

  test('alt 2: em versão nova, preencher o campo pendente tira o pendente dele; o outro mantém o MESMO vencimento (o prazo não reinicia)', async ({ page }) => {
    await loginAs(page, operador);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tp-edit-btn').click();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });

    // O estado da vigente veio pré-marcado; o "No necesita" do Master (herdado) aparece como texto para quem não tem a célula.
    const responsables = campo(page, 'responsibles');
    const equipo = campo(page, 'careTeam');
    await expect(responsables.getByLabel(LABEL_PENDING, { exact: true })).toBeChecked();
    await expect(equipo.getByLabel(LABEL_PENDING, { exact: true })).toBeChecked();
    await expect(responsables.getByTestId('tp-responsibles-deadline')).toContainText(ddmmEmDias(15)); // vencimento original, não "15 días" novos
    await expect(campo(page, 'coverageContacts').getByTestId('tp-coverageContacts-waived-text')).toHaveText(LABEL_WAIVED);

    // Preenche Equipo tratante: desmarca o pendente e escolhe o profissional.
    await alternar(equipo, LABEL_PENDING);
    await expect(equipo.getByLabel(LABEL_PENDING, { exact: true })).not.toBeChecked();
    await marcarPorTexto(page, 'tp-careTeam', PROFISSIONAL_NOME);
    await expect(page.locator('#tp-careTeam')).toContainText(PROFISSIONAL_NOME);
    await page.getByTestId('tp-modality').selectOption('IN_PERSON');

    await page.getByTestId('tp-save').click();
    const confirmacao = page.getByTestId('pending-contacts-confirm');
    await expect(confirmacao.getByTestId('pending-contacts-list')).toContainText(`Responsables — vence el ${ddmmEmDias(15)}`);
    await expect(confirmacao.getByTestId('pending-contacts-list')).not.toContainText('Equipo tratante');
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && OPEN_ROUTE.test(r.url()));
    await confirmacao.getByRole('button', { name: 'Crear igual', exact: true }).click();
    expect((await created).status()).toBe(201);

    // Leitura da versão nova: Equipo tratante tem o profissional e NÃO "Todavía no hay registro"; Responsables mantém.
    await expect(page.getByTestId('tpv-contact-status-CARE_TEAM')).toHaveCount(0);
    await expect(page.getByTestId('tpv-contacts')).toContainText(PROFISSIONAL_NOME);
    await expect(page.getByTestId('tpv-contact-status-RESPONSIBLE')).toContainText(`${LABEL_PENDING} — vence el ${ddmmEmDias(15)}`);
    // Um ciclo só (o campo preenchido saiu do aviso; nada reiniciou).
    expect(scalar(`SELECT count(*) FROM patient_tp_contact_reminder_cycles WHERE patient_id = '${seed.patientId}'`)).toBe('1');
  });
});
