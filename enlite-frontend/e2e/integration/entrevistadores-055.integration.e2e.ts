/**
 * entrevistadores-055.integration.e2e.ts @integration — spec 055 (tela "Entrevistadores": quem atende enquadre e admissão).
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL),
 * clique/teclado de humano (`loginAs`, `keyboard.type`, valor lido da tela). As fronteiras externas são DUBLÊS dentro da API
 * (`ADMISSION_EXTERNALS=fake`): NENHUM canal real. Dados SINTÉTICOS (@example.test).
 *
 *  feliz  — operadora abre /admin/entrevistadores, "Agregar entrevistador", busca a Florencia (staff ativa) pelo teclado, marca SÓ
 *           Encuadre e salva -> a linha aparece com Encuadre ligado e Admisión desligada (banco concorda) -> no DRAWER do enquadre
 *           da vaga ela aparece; no MODAL de "Nueva agenda" da admissão NÃO aparece (controle positivo: uma entrevistadora com os
 *           dois fluxos aparece nos dois).
 *  alt 1  — a busca NÃO acha prestador (worker) nem usuário desativado (mensagem "Ningún usuario…"); controle positivo: um staff
 *           ativo do mesmo prefixo é achado; forçando o POST pela API com o uid do prestador o servidor recusa com 400 e nada é gravado.
 *  alt 2  — desligar os DOIS interruptores = Quitar: pede confirmação (Cancelar não muda nada), confirma e a pessoa SAI da lista da
 *           tela, do drawer do enquadre e do modal da admissão; a linha fica inativa no banco (não é apagada).
 *
 * ⚠️ Precisa do engine ABAC LIGADO e da API com `ADMISSION_EXTERNALS=fake` — por isso o token `entrevistadores-055` entra no `--grep`
 * do job `integration-e2e-group-simulation` do `_frontend-integration.yml`. Rodar local = o job do CI: `ABAC_API_URL`,
 * `ABAC_TEST_DB_URL`, `E2E_PG_CONTAINER`. Escrito sem rodar local (stack de integração é do CI); quem prova que PASSA é o CI.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep } from '../helpers/patient-detail-c-helper';
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient } from '../helpers/db-test-helper';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, ABAC_API_URL, ABAC_TENANT,
} from '../helpers/abac-stack-helper';
import { seedInterviewHost, cleanupInterviewHosts } from '../helpers/interview-host-seed';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
/** Token único na busca: nenhum outro usuário do banco casa com ele. */
const TOKEN = `e055${RUN_ID}`;

const FLOR = { uid: `e2e055-flor-${RUN_ID}`, email: `flor.${TOKEN}@example.test`, name: `Florencia ${TOKEN}` };
const CONTROLE = { uid: `e2e055-ctrl-${RUN_ID}`, email: `ctrl.${TOKEN}@example.test`, name: `Controle ${TOKEN}` };
const PRESTADOR = { uid: `e2e055-prest-${RUN_ID}`, email: `prest.${TOKEN}@example.test`, name: `Prestador ${TOKEN}` };
const INATIVO = { uid: `e2e055-inat-${RUN_ID}`, email: `inat.${TOKEN}@example.test`, name: `Inactivo ${TOKEN}` };
const LIGA = { email: `liga.${TOKEN}@example.test`, name: `Liga ${TOKEN}` }; // entrevistadora com os DOIS fluxos (controle positivo e alt 2)

const operadoraUid = `e2e-055-operadora-${RUN_ID}`;
const operadora = { uid: operadoraUid, email: `${operadoraUid}@e2e.test`, role: 'admin', country: 'AR' };
const SAVE_ROUTE = /\/api\/admin\/interview-hosts(\/[0-9a-f-]+)?$/;

let operadoraGroupId = '';
let seed: { patientId: string; addressId: string; stamp: string };
let vacancy: { patientId: string; vacancyId: string; workerId: string };
let ligaId = '';
let florId = '';

const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64');

function insertUser(u: { uid: string; email: string; name: string }, opts: { role?: string; active?: boolean } = {}): void {
  psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
        VALUES ('${u.uid}', '${u.email}', '${u.name}', '${opts.role ?? 'recruiter'}', ${opts.active ?? true}, 'ACTIVE', '${ABAC_TENANT}')`);
}

/** Digita como uma pessoa (clique no campo + teclado) e LÊ o valor da tela. */
async function digitar(page: Page, testId: string, texto: string): Promise<void> {
  const campo = page.locator(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  await expect(campo).toHaveValue(texto);
}

const linhaDe = (page: Page, email: string) => page.getByRole('row').filter({ hasText: email });

async function abrirTela(page: Page): Promise<void> {
  await page.goto('/admin/entrevistadores');
  await expect(page.getByRole('heading', { name: 'Entrevistadores de encuadre y admisión' })).toBeVisible({ timeout: 30_000 });
  await expect(linhaDe(page, LIGA.email)).toBeVisible({ timeout: 15_000 }); // controle positivo: a lista carregou
}

async function abrirDrawerDoEnquadre(page: Page): Promise<void> {
  await page.goto(`/admin/vacancies/${vacancy.vacancyId}`);
  await expect(page.getByTestId('vacancy-tab-enquadre')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('vacancy-tab-enquadre').click();
  await expect(page.getByTestId('enquadre-tab')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('enquadre-create-button').or(page.getByTestId('enquadre-empty-create-button')).first().click();
  await expect(page.getByTestId('enquadre-create-drawer')).toBeVisible();
}

async function abrirModalDaAdmissao(page: Page): Promise<void> {
  await page.goto(`/admin/patients/${seed.patientId}`);
  await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Admisión', exact: true }).click();
  await expect(page.getByTestId('admission-tab')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('admission-new-button').click();
  await expect(page.getByTestId('admission-new-modal')).toBeVisible();
  await expect(page.getByTestId('admission-hosts-loading')).toHaveCount(0, { timeout: 15_000 });
}

const hostLinhaNoBanco = (email: string): string =>
  scalar(`SELECT does_enquadre || '|' || does_admission || '|' || active || '|' || countries::text FROM interview_hosts WHERE email = '${email}'`);

test.use({ viewport: { width: 1600, height: 1100 } });

test.describe('entrevistadores-055 — tela Entrevistadores: agregar, busca, Quitar e as duas listas (spec 055) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeAll(() => {
    seed = seedActivatablePatient(755000);
    safeSql(`UPDATE patients SET has_consent = true WHERE id = '${seed.patientId}'`);

    const { patientId, addressId } = insertTestPatient({ withAddress: true, firstName: 'Ficticio', lastName: `Ent055${RUN_ID}` });
    const vacancyId = insertBaseVacancy({
      patientId, patientAddressId: addressId!, caseNumber: 955_000 + Math.floor(Math.random() * 30_000), status: 'SEARCHING', isDraft: false,
    });
    const workerId = scalar(`INSERT INTO workers (auth_uid, email, country, timezone, status, first_name_encrypted, last_name_encrypted)
      VALUES ('e2e055-${RUN_ID}', 'prestador.e2e055-${RUN_ID}@example.test', 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED',
              '${b64('Ficticio 01')}', '${b64('E2E055')}') RETURNING id`);
    psql(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ('${workerId}', '${vacancyId}', 'COMPLETED', 'talentum')`);
    vacancy = { patientId, vacancyId, workerId };

    insertUser(FLOR);
    insertUser(CONTROLE);
    insertUser(PRESTADOR, { role: 'worker' });
    insertUser(INATIVO, { active: false });
    ligaId = seedInterviewHost({ email: LIGA.email, displayName: LIGA.name });

    // Células ANTES do 1º request. A tela + as leituras das duas telas onde a lista aparece (drawer do enquadre e modal da admissão).
    operadoraGroupId = seedStaffInGroup({ uid: operadoraUid, email: operadora.email, groupName: `Ent055 Operadora ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of [
      ['interview_host', 'read'], ['interview_host', 'update'],
      ['vacancy', 'read'], ['patient_identity', 'read'], ['funnel', 'read'], ['match', 'read'], ['enquadre_event', 'read'], ['enquadre_event', 'create'],
      ['patient', 'read'], ['patient_admission', 'read'], ['patient_admission', 'create'],
    ] as Array<[string, string]>) grantCell(operadoraGroupId, r, a);
  });

  test.afterAll(() => {
    cleanupInterviewHosts([FLOR.email, LIGA.email, CONTROLE.email, PRESTADOR.email, INATIVO.email]);
    for (const u of [FLOR, CONTROLE, PRESTADOR, INATIVO]) safeSql(`DELETE FROM users WHERE firebase_uid = '${u.uid}'`);
    safeSql(`DELETE FROM enquadre_events WHERE job_posting_id = '${vacancy?.vacancyId}'`);
    safeSql(`DELETE FROM worker_job_applications WHERE job_posting_id = '${vacancy?.vacancyId}'`);
    safeSql(`DELETE FROM encuadres WHERE job_posting_id = '${vacancy?.vacancyId}'`);
    safeSql(`DELETE FROM workers WHERE id = '${vacancy?.workerId}'`);
    try { cleanupTestPatient(vacancy.patientId); } catch (err) { console.error('[cleanup] paciente/vaga falhou (seguindo)', err); }
    safeSql(`DELETE FROM admission_appointments WHERE patient_id = '${seed?.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupStaffAndGroup(operadoraUid, operadoraGroupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Ent055 Operadora ${RUN_ID}'`);
  });

  test('feliz: agrega a Florencia só em Encuadre -> aparece na lista da tela e no drawer do enquadre, NÃO no modal da admissão', async ({ page }, testInfo) => {
    await loginAs(page, operadora);
    await abrirTela(page);
    expect(scalar(`SELECT count(*) FROM interview_hosts WHERE email = '${FLOR.email}'`), 'começa sem a Florencia').toBe('0');

    await page.getByTestId('agregar-entrevistador').click();
    await expect(page.getByTestId('interview-host-panel')).toBeVisible();
    await expect(page.getByTestId('panel-save')).toBeDisabled();
    await expect(page.getByTestId('no-flow-help'), 'aviso só depois da 1ª interação').toHaveCount(0);

    await digitar(page, '#ih-user', FLOR.name);
    await page.getByTestId(`candidate-${FLOR.uid}`).click();
    await expect(page.getByTestId('picked-user')).toContainText(FLOR.email);
    await expect(page.getByRole('button', { name: /Argentina/ })).toHaveAttribute('aria-pressed', 'true'); // país padrão, lido da tela
    await page.getByLabel('Encuadre').check();
    await expect(page.getByLabel('Encuadre')).toBeChecked();
    await expect(page.getByLabel('Admisión')).not.toBeChecked();
    await expect(page.getByTestId('panel-save')).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('1-feliz-painel-preenchido.png') });

    const salvou = page.waitForResponse((r) => r.request().method() === 'POST' && SAVE_ROUTE.test(r.url()));
    await page.getByTestId('panel-save').click();
    expect((await salvou).status()).toBe(201);
    await expect(page.getByTestId('interview-host-panel')).toHaveCount(0);

    const linha = linhaDe(page, FLOR.email);
    await expect(linha).toBeVisible({ timeout: 15_000 });
    await expect(linha.getByRole('switch', { name: /^Encuadre/ })).toHaveAttribute('aria-checked', 'true');
    await expect(linha.getByRole('switch', { name: /^Admisión/ })).toHaveAttribute('aria-checked', 'false');
    expect(hostLinhaNoBanco(FLOR.email)).toBe('true|false|true|{AR}');
    florId = scalar(`SELECT id FROM interview_hosts WHERE email = '${FLOR.email}'`);
    await page.screenshot({ path: testInfo.outputPath('2-feliz-lista-com-florencia.png'), fullPage: true });

    // Drawer do enquadre: a Florencia está lá (e a Liga, que atende os dois, também).
    await abrirDrawerDoEnquadre(page);
    await expect(page.getByTestId(`enquadre-create-host-${ligaId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`enquadre-create-host-${florId}`)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('3-feliz-drawer-enquadre.png') });

    // Modal da admissão: a Liga está (controle positivo), a Florencia NÃO.
    await abrirModalDaAdmissao(page);
    await expect(page.getByTestId(`admission-host-${LIGA.email.toLowerCase()}`)).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId(`admission-host-${FLOR.email.toLowerCase()}`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('4-feliz-modal-admissao-sem-florencia.png') });
  });

  test('alt 1: a busca não acha prestador nem usuário desativado; o POST direto com o uid do prestador leva 400 e nada é gravado', async ({ page, request }, testInfo) => {
    await loginAs(page, operadora);
    await abrirTela(page);
    await page.getByTestId('agregar-entrevistador').click();
    await expect(page.getByTestId('interview-host-panel')).toBeVisible();

    // Controle positivo: um staff ativo do MESMO prefixo é achado (a ausência abaixo não é busca quebrada).
    await digitar(page, '#ih-user', CONTROLE.name);
    await expect(page.getByTestId(`candidate-${CONTROLE.uid}`)).toBeVisible({ timeout: 15_000 });

    for (const alvo of [PRESTADOR, INATIVO]) {
      await page.locator('#ih-user').fill('');
      await digitar(page, '#ih-user', alvo.name);
      await expect(page.getByTestId('no-results')).toContainText('Ningún usuario del equipo coincide', { timeout: 15_000 });
      await expect(page.getByTestId(`candidate-${alvo.uid}`)).toHaveCount(0);
    }
    await expect(page.getByTestId('panel-save')).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('5-alt1-busca-sem-resultado.png') });

    const direto = await request.post(`${ABAC_API_URL}/api/admin/interview-hosts`, {
      headers: { Authorization: `Bearer ${tokenFor(operadora)}` },
      data: { userUid: PRESTADOR.uid, countries: ['AR'], doesEnquadre: true, doesAdmission: true },
    });
    expect(direto.status()).toBe(400);
    expect(await direto.json()).toMatchObject({ code: 'INTERVIEW_HOST_USER_NOT_ELIGIBLE' });
    expect(scalar(`SELECT count(*) FROM interview_hosts WHERE email = ANY(ARRAY['${PRESTADOR.email}','${INATIVO.email}'])`)).toBe('0');
  });

  test('alt 2: desligar os dois interruptores = Quitar (com confirmação) -> some da tela, do drawer do enquadre e do modal da admissão; a linha fica inativa', async ({ page }, testInfo) => {
    await loginAs(page, operadora);
    await abrirTela(page);
    const linha = linhaDe(page, LIGA.email);
    const enquadre = linha.getByRole('switch', { name: /^Encuadre/ });
    const admision = linha.getByRole('switch', { name: /^Admisión/ });
    await expect(enquadre).toHaveAttribute('aria-checked', 'true');
    await expect(admision).toHaveAttribute('aria-checked', 'true');

    // Desligar UM fluxo é só PATCH: continua na lista.
    const patch1 = page.waitForResponse((r) => r.request().method() === 'PATCH' && SAVE_ROUTE.test(r.url()));
    await enquadre.click();
    expect((await patch1).status()).toBe(200);
    await expect(linhaDe(page, LIGA.email).getByRole('switch', { name: /^Encuadre/ })).toHaveAttribute('aria-checked', 'false');
    expect(hostLinhaNoBanco(LIGA.email)).toBe('false|true|true|{AR}');

    // Desligar o ÚLTIMO pede confirmação: Cancelar não muda nada.
    await linhaDe(page, LIGA.email).getByRole('switch', { name: /^Admisión/ }).click();
    await expect(page.getByTestId('quitar-modal')).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByTestId('quitar-modal')).toHaveCount(0);
    expect(hostLinhaNoBanco(LIGA.email)).toBe('false|true|true|{AR}');

    await linhaDe(page, LIGA.email).getByRole('switch', { name: /^Admisión/ }).click();
    await page.screenshot({ path: testInfo.outputPath('6-alt2-confirmar-quitar.png') });
    const patch2 = page.waitForResponse((r) => r.request().method() === 'PATCH' && SAVE_ROUTE.test(r.url()));
    await page.getByTestId('quitar-confirm').click();
    expect((await patch2).status()).toBe(200);
    await expect(linhaDe(page, LIGA.email)).toHaveCount(0, { timeout: 15_000 });
    await expect(linhaDe(page, FLOR.email), 'controle: a outra linha segue na tela').toBeVisible();
    expect(hostLinhaNoBanco(LIGA.email)).toBe('false|false|false|{AR}'); // inativa, NÃO apagada

    await abrirDrawerDoEnquadre(page);
    await expect(page.getByTestId(`enquadre-create-host-${florId}`), 'controle: a Florencia segue no drawer').toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`enquadre-create-host-${ligaId}`)).toHaveCount(0);

    await abrirModalDaAdmissao(page);
    await expect(page.getByTestId(`admission-host-${LIGA.email.toLowerCase()}`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('7-alt2-modal-admissao-sem-liga.png') });
  });
});
