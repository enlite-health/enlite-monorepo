/**
 * vacancy-draft-page.integration.e2e.ts @integration — fase 2,
 * `openspec/changes/completar-vacante-em-rascunho/fase-2.md`.
 *
 * A tela própria do rascunho (D426): precisa diferenciar ator COM as células `talentum:update` +
 * `vacancy:update` de ator SEM elas — o que só é PROVÁVEL com o engine ABAC ligado (memória
 * `stack-e2e-abac-ligado`). Roda contra um stack ISOLADO (projeto docker `cv-fase2-abac`,
 * Postgres `5442`, API `8092`, Vite `5178`) — não mexe no stack padrão 8080/5432/5173 desta
 * worktree, que a Fase 1 e outras tasks continuam usando.
 *
 * COMO SUBIR (molde: `admin-access-cells-visual.integration.e2e.ts`). O bloco de ENGINE
 * (`PERMISSION_ENGINE_ENABLED`/`_ENFORCED_ROUTES`/`_CATALOG_SYNC_ENABLED`) já vive VERSIONADO
 * em `docker-compose.group-simulation.yml` — nunca duplicar; o override desta task é só porta/
 * container_name/CORS, LOCAL desta máquina (gitignorado, `docker-compose.*.local.yml`, gate
 * parcial 25/09: o arquivo antigo duplicava o bloco de engine e saiu do repo, achado #1).
 * `worker-functions/docker-compose.fase2-abac.local.yml` — não existe no git; recriar com este
 * conteúdo (rodada 2 do gate, 25/09: colado aqui para quem não tem esta máquina não precisar
 * adivinhar):
 *   services:
 *     postgres:
 *       container_name: cv-fase2-abac-postgres
 *       ports: !override
 *         - "5442:5432"
 *     api:
 *       image: worker-functions-api
 *       container_name: cv-fase2-abac-api
 *       ports: !override
 *         - "8092:8080"
 *       environment:
 *         CORS_ALLOWED_ORIGINS: "http://localhost:5178"
 *
 *   cd worker-functions
 *   docker compose -p cv-fase2-abac -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.group-simulation.yml -f docker-compose.fase2-abac.local.yml \
 *     up -d postgres api
 *   # engine recusa subir sem o marcador da migração de grupos (D117, fail-closed) — hoje uma
 *   # migration já semeia 'done' em banco novo; se subir vazio (versão antiga da imagem):
 *   psql postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e -c \
 *     "INSERT INTO iam.rollout_state (key,value,note,updated_by) VALUES \
 *      ('permission_groups_migrated','done','e2e fase-2','e2e:local') ON CONFLICT (key) DO UPDATE SET value='done'"
 *   cd ../enlite-frontend && VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8092 <demais VITE_FIREBASE_*> \
 *     npx vite --port 5178 --strictPort
 *   E2E_PG_CONTAINER=cv-fase2-abac-postgres ABAC_TEST_DB_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e \
 *     ABAC_API_URL=http://localhost:8092 PW_BASE_URL=http://localhost:5178 \
 *     npx playwright test --project=integration --grep "draft-vacancy-page"
 *
 * Evidência (prints do teste 5) sai em `test-results/.../fase-2-{desktop,mobile}.png`
 * (`testInfo.outputPath`) — nunca caminho absoluto do repo (achado #2 do gate parcial 25/09: o
 * antigo só funcionava nesta máquina). Copiar pra `openspec/.../evidencias/` depois da rodada:
 *   SRC=$(find test-results -iname "fase-2-desktop.png" | head -1)
 *   DST=/Users/gabrielstein-dev/projects/enlite/ebrain/openspec/changes/completar-vacante-em-rascunho/evidencias
 *   cp "$SRC" "$DST/fase-2-desktop.png" && cp "$(dirname "$SRC")/fase-2-mobile.png" "$DST/fase-2-mobile.png"
 *
 * Auth: `loginAs`/`installAuthInterceptors` de `abac-stack-helper.ts` — humano (click +
 * keyboard.type), Identity Toolkit interceptado, `/api/**` e `/v1/me/authz` trocam o
 * Authorization por `mock_*`. Setup de fixture (paciente/serviço/foguete) por um TERCEIRO ator,
 * com só as células que o setup precisa — os dois atores do teste (com/sem célula de publicar)
 * nunca escrevem nada, só leem.
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

const SETUP: MockUser = { uid: `e2e-draft-setup-${RUN_ID}`, email: `draft-setup-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };
const COM_CELULA: MockUser = { uid: `e2e-draft-com-${RUN_ID}`, email: `draft-com-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };
const SEM_CELULA: MockUser = { uid: `e2e-draft-sem-${RUN_ID}`, email: `draft-sem-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };

const mockToken = (u: MockUser): string => 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');
const AUTH_HEADERS = (u: MockUser) => ({ Authorization: `Bearer ${mockToken(u)}`, 'Content-Type': 'application/json' });

test.describe('draft-vacancy-page — fase 2 (completar-vacante-em-rascunho, D426) @integration', () => {
  // Fixture compartilhada (1 paciente, 2 serviços/vagas) entre os testes — serial evita a
  // corrida de `fullyParallel` sobre a mesma linha (mesmo achado do gate na Fase 1).
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  let patientId = '';
  let addressId = '';
  let draftVacancyId = '';
  let draftServiceId = '';
  let publishedVacancyId = '';
  let setupGroupId = '';
  let comCelulaGroupId = '';
  let semCelulaGroupId = '';

  test.beforeAll(async ({ request }) => {
    // Paciente + endereço direto no banco (bypassa permissão de propósito — é fixture, não o que
    // o teste mede). `E2E_PG_CONTAINER` aponta pro Postgres do stack ISOLADO.
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION',
      firstName: 'DraftPage',
      lastName: `Patient${RUN_ID}`,
      withAddress: true,
      hasConsent: true,
      insuranceInformed: 'OSDE',
    });
    patientId = seeded.patientId;
    addressId = seeded.addressId ?? '';
    expect(addressId, 'insertTestPatient não devolveu addressId').toBeTruthy();

    // Ator de SETUP: só as 3 células que criar serviço + disparar o foguete exigem
    // (`patient_services:create`, `patient_services:update`, `vacancy:update` — rota
    // `activate-recruitment`, comentário de `adminPatientsRoutes.ts`).
    setupGroupId = seedStaffInGroup({ uid: SETUP.uid, email: SETUP.email, groupName: `E2E Draft Setup ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(setupGroupId, 'patient_services', 'create');
    grantCell(setupGroupId, 'patient_services', 'update');
    grantCell(setupGroupId, 'vacancy', 'update');

    // Ator COM as duas células de D426 — vê o botão "Completar vacante". `patient_address:read`
    // e `patient_clinical:read` entram aqui (gate parcial 25/09, achado #6): sem elas o GET da
    // vaga zera endereço/zona/dependência e a página teria de escrever "Sin completar" onde na
    // verdade é permissão — os dois atores do teste ganham as duas para que a única VARIÁVEL
    // entre eles continue sendo talentum:update/vacancy:update, não uma segunda dimensão de
    // redação escondida no meio da contagem do teste 2.
    comCelulaGroupId = seedStaffInGroup({ uid: COM_CELULA.uid, email: COM_CELULA.email, groupName: `E2E Draft ComCelula ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [resource, action] of [
      ['vacancy', 'read'], ['vacancy', 'update'], ['talentum', 'update'],
      ['patient', 'read'], ['patient_identity', 'read'], ['patient_services', 'read'],
      ['patient_address', 'read'], ['patient_clinical', 'read'],
    ] as const) grantCell(comCelulaGroupId, resource, action);

    // Ator SEM as duas células de D426 — lê a vaga (F3 do spec: "ator sem a célula de
    // publicar" ainda ABRE a tela), mas não completa/publica. Mesmas células de LEITURA do
    // ator acima (achado #6) — só as 2 de D426 mudam entre os dois.
    semCelulaGroupId = seedStaffInGroup({ uid: SEM_CELULA.uid, email: SEM_CELULA.email, groupName: `E2E Draft SemCelula ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [resource, action] of [
      ['vacancy', 'read'],
      ['patient', 'read'], ['patient_identity', 'read'], ['patient_services', 'read'],
      ['patient_address', 'read'], ['patient_clinical', 'read'],
    ] as const) grantCell(semCelulaGroupId, resource, action);

    // Serviço contratado + foguete (o MESMO caminho de produção) — vaga #1, fica em rascunho.
    // Sem `providerAgeBand`: "Edad del prestador" fica genuinamente vazio de propósito — é UM
    // dos campos que sustentam o "≥ N Sin completar" do teste 2 (contagem justificada lá).
    const svcRes = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/contracted-services`, {
      headers: AUTH_HEADERS(SETUP),
      data: { serviceCode: 'CAREGIVER', providersNeeded: 2, weeklyHours: 32, careLocation: 'HOME', addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '14:00' }] },
    });
    expect(svcRes.ok(), `POST contracted-services (draft) falhou: ${svcRes.status()} ${await svcRes.text()}`).toBe(true);
    draftServiceId = (await svcRes.json()).data.id as string;
    const activateRes = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/contracted-services/${draftServiceId}/activate-recruitment`, { headers: AUTH_HEADERS(SETUP) });
    expect(activateRes.ok(), `activate-recruitment (draft) falhou: ${activateRes.status()} ${await activateRes.text()}`).toBe(true);
    draftVacancyId = (await activateRes.json()).data.vacancyId as string;

    // Vaga #2 (outro serviço), mesmo paciente — vira "publicada" por SQL (F11: publicar de
    // verdade chamaria o Talentum, canal real proibido em teste). Só o bit `is_draft` importa
    // pro redirect (Alt 2).
    const svcRes2 = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/contracted-services`, {
      headers: AUTH_HEADERS(SETUP),
      data: { serviceCode: 'AT', providersNeeded: 1, weeklyHours: 20, careLocation: 'HOME', addressId, schedule: [{ dayOfWeek: 2, startTime: '09:00', endTime: '13:00' }] },
    });
    expect(svcRes2.ok(), `POST contracted-services (published) falhou: ${svcRes2.status()} ${await svcRes2.text()}`).toBe(true);
    const publishedServiceId = (await svcRes2.json()).data.id as string;
    const activateRes2 = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/contracted-services/${publishedServiceId}/activate-recruitment`, { headers: AUTH_HEADERS(SETUP) });
    expect(activateRes2.ok(), `activate-recruitment (published) falhou: ${activateRes2.status()} ${await activateRes2.text()}`).toBe(true);
    publishedVacancyId = (await activateRes2.json()).data.vacancyId as string;

    psql(`UPDATE job_postings SET is_draft = false WHERE id = '${publishedVacancyId}'`);
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(SETUP.uid, setupGroupId);
    cleanupStaffAndGroup(COM_CELULA.uid, comCelulaGroupId);
    cleanupStaffAndGroup(SEM_CELULA.uid, semCelulaGroupId);
    cleanupTestPatient(patientId);
  });

  test('1. feliz — ator com talentum:update + vacancy:update: detalhe redireciona a /borrador, botão leva a /edit', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await page.goto(`/admin/vacancies/${draftVacancyId}`);
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${draftVacancyId}/borrador$`));
    const btn = page.getByTestId('complete-vacancy-btn');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${draftVacancyId}/edit$`));
  });

  test('2. alternativo 1 — ator sem as células: zero controles no DOM, ≥1 "Sin completar"', async ({ page }) => {
    await loginAs(page, SEM_CELULA);
    // Entra pela URL do DETALHE, como o contrato descreve ("abre a tela do rascunho" — spec.md,
    // cenário "visualização por quem não publica") — não direto em `/borrador` (achado #7 do
    // gate fecho 25/09). O redirect em si já é provado pelo teste 1; aqui só confirma que
    // continua valendo também para quem NÃO tem a célula de publicar.
    await page.goto(`/admin/vacancies/${draftVacancyId}`);
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${draftVacancyId}/borrador$`));
    await expect(page.getByTestId('draft-vacancy-callout')).toBeVisible();

    const controls = await page.locator('input, select, textarea, [data-testid="complete-vacancy-btn"]').count();
    expect(controls).toBe(0);
    // ≥ 1, não ≥ 7 (gate parcial 25/09, achado #6): com `patient_address`/`patient_clinical:read`
    // concedidas aos dois atores, endereço/zona/dependência deixam de contar como "Sin completar"
    // (a permissão não é mais o que zera esses campos — o dado real é). O 1 que SOBRA é
    // genuinamente vazio NESTA fixture, não por permissão: "Edad del prestador" (o foguete só
    // preenche via `providerAgeBand` do serviço, que este `beforeAll` não passa de propósito).
    // "Valor por hora" NÃO entra (medido no gate fecho 25/09, achado #8): mesmo com
    // `ActivateRecruitmentUseCase.ts` gravando `salary_text: null` no INSERT, o GET devolve "A
    // convenir" (F2 — o default é aplicado na leitura, não sobrevive só na escrita como eu
    // supunha antes; corrigido aqui pela evidência do e2e, não por suposição). ≥ 1 é o piso
    // estável desta fixture; se a Fase 4 mudar o que o foguete preenche, este número muda com
    // ela. O protótipo v3 NÃO escreve "Sin completar" na lista "Lo que falta" (só rótulos de
    // campo com círculo vazio/cheio) — todo "Sin completar" desta contagem vem do card "Lo que
    // ya sabemos".
    const semCompletar = await page.getByText('Sin completar').count();
    expect(semCompletar).toBeGreaterThanOrEqual(1);
  });

  test('3. alternativo 2 — vaga publicada: /borrador redireciona ao detalhe, sem banner de rascunho', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await page.goto(`/admin/vacancies/${publishedVacancyId}/borrador`);
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${publishedVacancyId}$`));
    await expect(page.getByTestId(`vacancy-draft-badge-${publishedVacancyId}`)).toHaveCount(0);
    await expect(page.getByTestId('draft-vacancy-callout')).toHaveCount(0);
  });

  test('4. ficha do paciente — "Ver vacante" no serviço em rascunho leva a /borrador (F16)', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await page.goto(`/admin/patients/${patientId}`);
    // A ficha abre em "Datos Clínicos" por padrão (`PatientDetailPage.tsx:63`,
    // `useState('clinicalData')`) — achado do gate parcial 25/09 (conceder `patient_clinical:read`
    // ao ator fez essa aba passar a existir e ficar em primeiro lugar, tirando "Servicio
    // Contratado" do fallback `visibleTabs[0]`). Clicar a aba certa em vez de confiar na
    // primeira visível.
    await page.getByTestId('patient-profile-tabs').getByText('Servicio Contratado').click();
    const verVacante = page.getByTestId(`contracted-service-view-vacancy-${draftServiceId}`);
    await expect(verVacante).toBeVisible();
    await verVacante.click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${draftVacancyId}/borrador$`));
  });

  test('5. sem scroll horizontal em 1366×768 e 400px — prints de evidência', async ({ page }, testInfo) => {
    await loginAs(page, COM_CELULA);

    // `<main>` é o ÚNICO rolável da tela (AdminLayout.tsx:48, `overflow-y-auto`) — o
    // `<html>`/`<body>` não rolam, então `fullPage: true` parava no viewport (achado #4 do gate
    // parcial 25/09: "Última edición" e o botão do rodapé ficavam fora do print). Mede a altura
    // REAL do conteúdo e aumenta o viewport até caber tudo sem depender do scroll interno.
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(`/admin/vacancies/${draftVacancyId}/borrador`);
    await expect(page.getByTestId('draft-vacancy-callout')).toBeVisible();
    const desktop = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      mainScrollHeight: document.querySelector('main')?.scrollHeight ?? document.documentElement.scrollHeight,
    }));
    await page.setViewportSize({ width: 1366, height: desktop.mainScrollHeight + 80 });
    await expect(page.getByTestId('complete-vacancy-btn-footer')).toBeVisible();
    await expect(page.getByText(/Última edición/)).toBeVisible();
    // Caminho RELATIVO à pasta de saída do teste (`test-results/…`) — nunca absoluto do repo
    // (achado #2 do gate parcial: o caminho antigo só funcionava nesta máquina). Copiado para
    // `openspec/.../evidencias/` depois da rodada (comando no cabeçalho do arquivo/no fecho).
    await page.screenshot({ path: testInfo.outputPath('fase-2-desktop.png') });

    await page.setViewportSize({ width: 400, height: 900 });
    await page.reload();
    await expect(page.getByTestId('draft-vacancy-callout')).toBeVisible();
    const mobile = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      mainScrollHeight: document.querySelector('main')?.scrollHeight ?? document.documentElement.scrollHeight,
    }));
    await page.setViewportSize({ width: 400, height: mobile.mainScrollHeight + 80 });
    await page.screenshot({ path: testInfo.outputPath('fase-2-mobile.png') });

    console.log(`scrollWidth/innerWidth — 1366: ${desktop.scrollWidth}/${desktop.innerWidth} · 400: ${mobile.scrollWidth}/${mobile.innerWidth}`);
    expect(desktop.scrollWidth).toBeLessThanOrEqual(desktop.innerWidth);
    expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.innerWidth);
  });

  test('6. largura útil do container de conteúdo a 400px — shell vs página (achado #3)', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await page.setViewportSize({ width: 400, height: 900 });

    await page.goto(`/admin/vacancies/${draftVacancyId}/borrador`);
    await expect(page.getByTestId('draft-vacancy-callout')).toBeVisible();
    const borradorWidth = await page.evaluate(() => document.querySelector('main')?.getBoundingClientRect().width ?? 0);

    await page.goto(`/admin/vacancies/${publishedVacancyId}`);
    await expect(page.getByTestId('admin-layout')).toBeVisible();
    const detalheWidth = await page.evaluate(() => document.querySelector('main')?.getBoundingClientRect().width ?? 0);

    await page.goto('/admin/vacancies');
    await expect(page.getByTestId('admin-layout')).toBeVisible();
    const listaWidth = await page.evaluate(() => document.querySelector('main')?.getBoundingClientRect().width ?? 0);

    console.log(`largura útil (main.getBoundingClientRect().width) a 400px — borrador=${borradorWidth} detalhe=${detalheWidth} lista=${listaWidth}`);

    // As 3 telas usam o MESMO <main> do AdminLayout — se a largura é igual nas 3 (com folga de
    // arredondamento), a causa é o SHELL (`AdminLayout.tsx:48`, `ml-[200px]` sem prefixo
    // responsivo — mede 200px fixos mesmo a 400px de viewport), pré-existente e fora do escopo
    // desta fase. Registrado como `fixme` — visível no relatório, nunca silenciado.
    const causaEhShell = Math.abs(borradorWidth - detalheWidth) < 5 && Math.abs(borradorWidth - listaWidth) < 5;
    test.fixme(
      causaEhShell,
      `largura útil do <main> a 400px é ${borradorWidth.toFixed(0)}px nas 3 telas (borrador/detalhe/lista) — ` +
        `causa é o shell do admin (AdminLayout.tsx:48, "ml-[200px]" sem prefixo "md:"), pré-existente, fora do ` +
        'escopo da Fase 2. Não corrigido aqui — achado registrado para o Gabriel priorizar.',
    );

    expect(borradorWidth).toBeGreaterThanOrEqual(320);
  });
});
