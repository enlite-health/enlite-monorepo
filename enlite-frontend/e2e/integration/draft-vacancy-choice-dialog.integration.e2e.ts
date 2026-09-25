/**
 * draft-vacancy-choice-dialog.integration.e2e.ts @integration — fase 3,
 * `openspec/changes/completar-vacante-em-rascunho/fase-3.md`.
 *
 * Clique numa linha em rascunho na LISTA (`AdminVacanciesPage`) bifurca por permissão
 * (F25/D425/D426): ator com `talentum:update` + `vacancy:update` vê o modal
 * `DraftVacancyChoiceDialog` ("¿Qué querés hacer con este borrador?"); ator sem as células
 * vai direto para `/borrador`, sem modal nenhum. Só é PROVÁVEL com o engine ABAC ligado
 * (memória `stack-e2e-abac-ligado`) — o stack padrão tem enforcement off, e `useActionGate`
 * devolve `allowed: true` sempre, mascarando a bifurcação.
 *
 * Roda contra um stack ISOLADO (projeto docker `cv-fase3-abac`, Postgres `5452`, API `8102`,
 * Vite `5188`) — não mexe no stack padrão 8080/5432/5173 desta worktree, nem no stack da
 * Fase 2 (`cv-fase2-abac`, 5442/8092/5178), que pode estar rodando ao mesmo tempo em OUTRA
 * worktree.
 *
 * COMO SUBIR (molde: `vacancy-draft-page.integration.e2e.ts`, Fase 2). O bloco de ENGINE
 * (`PERMISSION_ENGINE_ENABLED`/`_ENFORCED_ROUTES`/`_CATALOG_SYNC_ENABLED`) já vive VERSIONADO
 * em `docker-compose.group-simulation.yml` — nunca duplicar; o override desta task é só porta/
 * container_name/CORS, LOCAL desta máquina (gitignorado, `docker-compose.*.local.yml`, gate
 * parcial 25/09: o arquivo antigo duplicava o bloco de engine e saiu do repo, achado #1).
 * `worker-functions/docker-compose.fase3-abac.local.yml` — não existe no git; recriar com este
 * conteúdo (colado aqui pra quem não tem esta máquina não precisar adivinhar):
 *   services:
 *     postgres:
 *       container_name: cv-fase3-abac-postgres
 *       ports: !override
 *         - "5452:5432"
 *     api:
 *       image: worker-functions-api
 *       container_name: cv-fase3-abac-api
 *       ports: !override
 *         - "8102:8080"
 *       environment:
 *         CORS_ALLOWED_ORIGINS: "http://localhost:5188"
 *
 *   cd worker-functions
 *   docker compose -p cv-fase3-abac -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.group-simulation.yml -f docker-compose.fase3-abac.local.yml \
 *     up -d postgres api
 *   # engine recusa subir sem o marcador da migração de grupos (D117, fail-closed) — hoje uma
 *   # migration já semeia 'done' em banco novo; se subir vazio (versão antiga da imagem):
 *   psql postgresql://enlite_admin:enlite_password@localhost:5452/enlite_e2e -c \
 *     "INSERT INTO iam.rollout_state (key,value,note,updated_by) VALUES \
 *      ('permission_groups_migrated','done','e2e fase-3','e2e:local') ON CONFLICT (key) DO UPDATE SET value='done'"
 *   cd ../enlite-frontend && VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8102 <demais VITE_FIREBASE_*> \
 *     npx vite --port 5188 --strictPort
 *   E2E_PG_CONTAINER=cv-fase3-abac-postgres ABAC_TEST_DB_URL=postgresql://enlite_admin:enlite_password@localhost:5452/enlite_e2e \
 *     ABAC_API_URL=http://localhost:8102 PW_BASE_URL=http://localhost:5188 \
 *     npx playwright test --project=integration --grep "draft-vacancy-choice"
 *
 * O stack IRMÃO desta change (engine ABAC OFF, usado por
 * `admin-vacancies-edit-routing.integration.e2e.ts`) segue o MESMO padrão —
 * `worker-functions/docker-compose.fase3-standard.local.yml`, local, não existe no git:
 *   services:
 *     postgres:
 *       container_name: cv-fase3-standard-postgres
 *       ports: !override
 *         - "5472:5432"
 *     api:
 *       image: worker-functions-api
 *       container_name: cv-fase3-standard-api
 *       ports: !override
 *         - "8122:8080"
 *       environment:
 *         CORS_ALLOWED_ORIGINS: "http://localhost:5193"
 *   Esse aqui NÃO usa `docker-compose.group-simulation.yml` (engine fica OFF, o padrão do
 *   stack quando nenhuma `PERMISSION_*` é setada) — ver o cabeçalho de
 *   `admin-vacancies-edit-routing.integration.e2e.ts` para o comando de subida completo.
 *
 * Auth: `loginAs`/`installAuthInterceptors` de `abac-stack-helper.ts` — humano (click +
 * keyboard.type). Setup de fixture (paciente/serviço/foguete) por um TERCEIRO ator, com só
 * as células que o setup precisa — os dois atores do teste nunca escrevem nada, só leem.
 */
import { test, expect } from '@playwright/test';
import {
  ABAC_API_URL,
  grantCell,
  seedStaffInGroup,
  cleanupStaffAndGroup,
  loginAs,
  psql,
  type MockUser,
} from '../helpers/abac-stack-helper';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const SETUP: MockUser = { uid: `e2e-choice-setup-${RUN_ID}`, email: `choice-setup-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };
const COM_CELULA: MockUser = { uid: `e2e-choice-com-${RUN_ID}`, email: `choice-com-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };
const SEM_CELULA: MockUser = { uid: `e2e-choice-sem-${RUN_ID}`, email: `choice-sem-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };

const mockToken = (u: MockUser): string => 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');
const AUTH_HEADERS = (u: MockUser) => ({ Authorization: `Bearer ${mockToken(u)}`, 'Content-Type': 'application/json' });

test.describe('draft-vacancy-choice — fase 3 (completar-vacante-em-rascunho, F25/D425/D426) @integration', () => {
  // Fixture compartilhada (1 paciente, 1 vaga em rascunho) entre os testes — serial evita a
  // corrida de `fullyParallel` sobre a mesma linha da lista (mesmo achado da Fase 1/2).
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  let patientId = '';
  let addressId = '';
  let draftVacancyId = '';
  let setupGroupId = '';
  let comCelulaGroupId = '';
  let semCelulaGroupId = '';

  test.beforeAll(async ({ request }) => {
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION',
      firstName: 'ChoiceDialog',
      lastName: `Patient${RUN_ID}`,
      withAddress: true,
      hasConsent: true,
      insuranceInformed: 'OSDE',
    });
    patientId = seeded.patientId;
    addressId = seeded.addressId ?? '';
    expect(addressId, 'insertTestPatient não devolveu addressId').toBeTruthy();

    // `insertTestPatient` não atribui `case_number` — sem ele, `buildListVacanciesQuery`
    // (`vacancyListHelpers.ts:112`, `WHERE jp.case_number IS NOT NULL`) filtra a vaga pra
    // FORA da lista incondicionalmente, mesmo com a permissão certa (achado medido ao rodar
    // este arquivo: a vaga existia no banco, `/v1/me/authz` tinha as células, e
    // `GET /api/admin/vacancies` mesmo assim devolvia `total: 0` — nenhum teste anterior
    // desta change batia nesse endpoint, só no detalhe direto por URL).
    const caseNumber = 990_000 + Math.floor(Math.random() * 9999);
    psql(`UPDATE patients SET case_number = ${caseNumber} WHERE id = '${patientId}'`);

    // Ator de SETUP: só as 3 células que criar serviço + disparar o foguete exigem.
    setupGroupId = seedStaffInGroup({ uid: SETUP.uid, email: SETUP.email, groupName: `E2E Choice Setup ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(setupGroupId, 'patient_services', 'create');
    grantCell(setupGroupId, 'patient_services', 'update');
    grantCell(setupGroupId, 'vacancy', 'update');

    // Ator COM as duas células de D426 — vê o modal de escolha; precisa também de
    // `vacancy:read`/`patient*:read` pra listagem carregar (mesmo conjunto da Fase 2).
    // `talentum:create` a mais (item 5, "Nueva fora"): controle positivo do teste 5 é
    // `sync-talentum-btn`, que exige talentum:create E talentum:update JUNTAS
    // (AdminVacanciesPage.tsx `podeSyncTalentum`) — sem essa célula o botão nunca apareceria,
    // e o teste provaria menos do que promete.
    comCelulaGroupId = seedStaffInGroup({ uid: COM_CELULA.uid, email: COM_CELULA.email, groupName: `E2E Choice ComCelula ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [resource, action] of [
      ['vacancy', 'read'], ['vacancy', 'update'], ['talentum', 'create'], ['talentum', 'update'],
      ['patient', 'read'], ['patient_identity', 'read'], ['patient_services', 'read'],
    ] as const) grantCell(comCelulaGroupId, resource, action);

    // Ator SEM as duas células de D426 — vai direto pra /borrador, sem modal.
    semCelulaGroupId = seedStaffInGroup({ uid: SEM_CELULA.uid, email: SEM_CELULA.email, groupName: `E2E Choice SemCelula ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [resource, action] of [
      ['vacancy', 'read'],
      ['patient', 'read'], ['patient_identity', 'read'], ['patient_services', 'read'],
    ] as const) grantCell(semCelulaGroupId, resource, action);

    // Serviço contratado + foguete (o MESMO caminho de produção) — fica em rascunho.
    const svcRes = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/contracted-services`, {
      headers: AUTH_HEADERS(SETUP),
      data: { serviceCode: 'CAREGIVER', providersNeeded: 2, weeklyHours: 32, careLocation: 'HOME', addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '14:00' }] },
    });
    expect(svcRes.ok(), `POST contracted-services falhou: ${svcRes.status()} ${await svcRes.text()}`).toBe(true);
    const draftServiceId = (await svcRes.json()).data.id as string;
    const activateRes = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/contracted-services/${draftServiceId}/activate-recruitment`, { headers: AUTH_HEADERS(SETUP) });
    expect(activateRes.ok(), `activate-recruitment falhou: ${activateRes.status()} ${await activateRes.text()}`).toBe(true);
    draftVacancyId = (await activateRes.json()).data.vacancyId as string;
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(SETUP.uid, setupGroupId);
    cleanupStaffAndGroup(COM_CELULA.uid, comCelulaGroupId);
    cleanupStaffAndGroup(SEM_CELULA.uid, semCelulaGroupId);
    cleanupTestPatient(patientId);
  });

  test('1. feliz — ator com talentum:update + vacancy:update: clique na linha em rascunho abre o modal com exatamente 2 ações; "Completar vacante" → /edit', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await page.goto('/admin/vacancies');
    await expect(page.getByTestId(`vacancy-draft-badge-${draftVacancyId}`)).toBeVisible({ timeout: 20_000 });

    await page.getByTestId(`vacancy-row-${draftVacancyId}`).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const complete = page.getByTestId('choice-complete');
    const viewOnly = page.getByTestId('choice-view');
    await expect(complete).toBeVisible();
    await expect(viewOnly).toBeVisible();
    // Exatamente 2 ações — nenhum terceiro botão de ação dentro do dialog (o "Cancelar" não conta
    // como "ação" no sentido do spec: leva a lugar nenhum, só fecha).
    await expect(dialog.getByTestId(/^choice-/)).toHaveCount(2);

    await complete.click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${draftVacancyId}/edit$`));
  });

  test('2. alternativo 1 — "Solo visualizar" no mesmo modal → /borrador', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await page.goto('/admin/vacancies');
    await expect(page.getByTestId(`vacancy-draft-badge-${draftVacancyId}`)).toBeVisible({ timeout: 20_000 });

    await page.getByTestId(`vacancy-row-${draftVacancyId}`).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('choice-view').click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${draftVacancyId}/borrador$`));
  });

  test('3. alternativo 2 — ator sem as células: clique na mesma linha NÃO abre modal, navega direto a /borrador', async ({ page }) => {
    await loginAs(page, SEM_CELULA);
    await page.goto('/admin/vacancies');
    await expect(page.getByTestId(`vacancy-draft-badge-${draftVacancyId}`)).toBeVisible({ timeout: 20_000 });

    await page.getByTestId(`vacancy-row-${draftVacancyId}`).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${draftVacancyId}/borrador$`));
  });

  test('4. lápis e modal antigo sumiram da lista; o badge de rascunho (controle positivo) continua', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await page.goto('/admin/vacancies');
    await expect(page.getByTestId(`vacancy-draft-badge-${draftVacancyId}`)).toBeVisible({ timeout: 20_000 });

    const oldControls = await page.locator('[data-testid^="edit-vacancy-"], [data-testid="vacancy-modal"]').count();
    const badges = await page.locator('[data-testid^="vacancy-draft-badge-"]').count();
    expect(oldControls).toBe(0);
    expect(badges).toBeGreaterThanOrEqual(1);
  });

  test('5. "Nueva" fora — botão sumiu incondicionalmente (controle positivo: sync-talentum-btn aparece pra quem tem célula), /new redireciona', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await page.goto('/admin/vacancies');
    await expect(page.getByTestId(`vacancy-draft-badge-${draftVacancyId}`)).toBeVisible({ timeout: 20_000 });

    const newBtnCount = await page.getByTestId('new-vacancy-btn').count();
    const syncBtnCount = await page.getByTestId('sync-talentum-btn').count();
    console.log(`[prova] new-vacancy-btn=${newBtnCount} sync-talentum-btn=${syncBtnCount}`);
    expect(newBtnCount).toBe(0);
    // Controle positivo: COM_CELULA TEM as células de outro botão da mesma tela — prova que a
    // ausência do "Nueva" é sobre o "Nueva" (D425 item 4), não sobre a tela inteira estar
    // escondendo botão por falta de contrato/permissão.
    expect(syncBtnCount).toBe(1);

    await page.goto('/admin/vacancies/new');
    await expect(page).toHaveURL(/\/admin\/vacancies$/, { timeout: 15_000 });
    console.log(`[prova] URL final após /new: ${page.url()}`);
  });
});
