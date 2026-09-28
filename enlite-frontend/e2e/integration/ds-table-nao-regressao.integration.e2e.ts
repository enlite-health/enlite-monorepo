/**
 * ds-table-nao-regressao — Fase 9 (change cadeia-paciente-vacante-itinerario), DX-9.8.
 *
 * Prova de não-regressão do átomo `atoms/Table` (`TableRow` ganha a prop `selected`, Fase 9):
 * 1 `test` por tela do inventário (`CH/evidencias/fase-9/consumidores-table.tsv`, 30 telas),
 * SEM `describe.serial` (um vermelho no 1º não derruba os irmãos), SEM `toHaveScreenshot`/baseline
 * (o `compare` A1×A2×D roda fora, local — ver DX-9.9). A massa é semeada UMA vez e só LIDA aqui
 * (`ensureDsTableMassa`, idempotente, P3).
 *
 * Este arquivo (P4) cobre t01-t15 (listas, fichas de paciente/worker/vaga); t16-t30 (catálogos,
 * dedup, acesso, dashboard) entram no P5, no MESMO arquivo (+15 títulos).
 *
 * Cada teste: `loginAs` (click + keyboard.type, nunca `fill()`) → `page.goto(<rota>)` → clique real
 * de aba/modal quando a tela pede (`getByRole`/`data-testid` que já existe) → espera o nó que prova
 * a tela pronta → `document.fonts.ready` → (i) tabela montada (massa) OU nó de vazio visível (VAZIO,
 * com o motivo em `test.info().annotations`) → (ii) `tr[aria-selected]` conta 0 (o lado desligado
 * na tela real, nenhum consumidor passa a prop até a Fase 10) → (só com `PRINT_DIR`) screenshot.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from '../helpers/abac-stack-helper';
import { ensureDsTableMassa, cleanupDsTableMassa, DS_TABLE_STAFF, type DsTableMassa } from '../helpers/ds-table-massa-helper';

test.describe('ds-table-nao-regressao', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });

  let massa: DsTableMassa;

  test.beforeAll(async ({ request }) => {
    massa = await ensureDsTableMassa(request);
  });

  test.afterAll(() => {
    // `process.env` lido DENTRO do hook (nunca em const de módulo) — rule 11 do BRIEF-COMUM.
    if (process.env.DS_TABLE_MASSA_KEEP !== '1') {
      cleanupDsTableMassa(massa);
    }
  });

  /** Espera fontes carregadas antes do print — critério 12 do BRIEF-COMUM. */
  async function waitFontsReady(page: Page): Promise<void> {
    await page.evaluate(() => document.fonts.ready);
  }

  /** `PRINT_DIR` lido DENTRO do teste (rule 11) — screenshot só quando existe (critério 12). */
  async function maybeScreenshot(page: Page, slug: string): Promise<void> {
    const dir = process.env.PRINT_DIR;
    if (!dir) return;
    await page.screenshot({ path: `${dir}/${slug}.png`, fullPage: true, animations: 'disabled', caret: 'hide' });
  }

  /** Critério (ii) da DX-9.8: nenhum consumidor da tela real fica com `aria-selected`. */
  async function expectNoSelectedRow(page: Page): Promise<void> {
    await expect(page.locator('tr[aria-selected]')).toHaveCount(0);
  }

  // ── t01-t15 (P4) ───────────────────────────────────────────────────────────────────────────

  test('ds-table-nao-regressao t01-anacare-horas', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/anacare/horas');
    // VAZIO por design (DX-9.6): a stack local não tem a fonte do Ana Care configurada — o
    // container cai no ramo de erro (`AnaCareHoursListContainer.tsx`, `FONTE_NAO_CONFIGURADA`),
    // medido 27/09 (não a lista com `TableRow` de vazio que a DX-9.6 previa).
    const errorNode = page.getByTestId('anacare-hours-list-error');
    await expect(errorNode).toBeVisible();
    test.info().annotations.push({
      type: 'vazio',
      description: 'fonte do Ana Care não configurada na stack local (anacare-hours-list-error) — sem dado sincronizado, memória chave-anacare-do-env-esta-defasada',
    });
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't01-anacare-horas');
  });

  test('ds-table-nao-regressao t02-anacare-horas-paciente', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    // URL usa o ID INTERNO do paciente (spec da tela) — sem paciente vinculado ao Ana Care, o
    // hook cai no ramo de erro do container (`AnaCareHoursDetailContainer.tsx`).
    await page.goto(`/admin/anacare/horas/${massa.patientId}`);
    const errorNode = page.getByTestId('anacare-hours-detail-error');
    await expect(errorNode).toBeVisible();
    test.info().annotations.push({
      type: 'vazio',
      description: 'DayGroup (t02) só monta com dia sincronizado do Ana Care, ausente na stack local — Q-EX-9.2: o print é da página vazia, sem o átomo',
    });
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't02-anacare-horas-paciente');
  });

  test('ds-table-nao-regressao t03-prestadores', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/workers');
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't03-prestadores');
  });

  test('ds-table-nao-regressao t04-prestador-ficha', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto(`/admin/workers/${massa.workerFunnelId}`);
    // Aba default é "documents" (workerTabs.ts) — a aba pede clique real. Rótulo é "Encuadre"
    // (singular, `admin.workerDetail.tabs.encuadres` no es.json) — diferente do título do card,
    // "Encuadres (N)" (`admin.workerDetail.encuadres`), medido 27/09.
    await page.getByRole('button', { name: 'Encuadre', exact: true }).click();
    const card = page.getByTestId('worker-encuadres-card');
    await expect(card).toBeVisible();
    await expect(card.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't04-prestador-ficha');
  });

  test('ds-table-nao-regressao t05-vacante-encuadres', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    // Aba default da vaga já é "encuadres" (VacancyDetailPage.tsx) — sem clique.
    await page.goto(`/admin/vacancies/${massa.vacancyId}`);
    const funnel = page.getByTestId('vacancy-funnel-view');
    await expect(funnel).toBeVisible();
    await expect(funnel.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't05-vacante-encuadres');
  });

  test('ds-table-nao-regressao t06-vacante-match', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto(`/admin/vacancies/${massa.vacancyId}`);
    await page.getByRole('button', { name: /Hacer match/i }).click();
    const modal = page.getByTestId('match-modal');
    await expect(modal).toBeVisible();
    // Achado (medido 27/09, fora do escopo de codar aqui): o modal renderiza
    // `MatchCandidateRow.match.tsx` (divs), NÃO `VacancyMatch/MatchCandidateRow.tsx` (o arquivo
    // que importa `atoms/Table`, órfão — 0 importadores em produção, grep abaixo). O funil por
    // trás do modal (`vacancy-funnel-view`, aba "encuadres") continua montado e é o `<table>` que
    // a asserção (i) enxerga — mesmo padrão do Q-EX-9.2 (t02): o print existe e é comparado, mas
    // quem prova o átomo aqui é o byte a byte (DX-9.4) + as suítes unit, não este spec.
    await expect(modal.getByTestId('match-modal-worker-link').first()).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    test.info().annotations.push({
      type: 'achado',
      description: 'MatchCandidateRow.tsx (importa atoms/Table) é órfão — 0 importadores em produção; MatchBucketSection usa MatchCandidateRow.match.tsx (divs). Reportado no retorno do P4, não corrigido aqui (fora do escopo do passo).',
    });
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't06-vacante-match');
  });

  test('ds-table-nao-regressao t07-vacante-talentum', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto(`/admin/vacancies/${massa.vacancyId}`);
    await page.getByTestId('vacancy-tab-talentum').click();
    await expect(page.getByRole('heading', { name: 'Publicaciones' })).toBeVisible();
    // Único `<table>` sob a aba talentum (VacancyPrescreeningConfig/VacancyTalentumCard não usam
    // o atom) — a tabela de publicações da própria VacancyDetailPage.
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't07-vacante-talentum');
  });

  test('ds-table-nao-regressao t08-vacante-notas', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto(`/admin/vacancies/${massa.vacancyId}`);
    await page.getByTestId('vacancy-tab-notes').click();
    const panel = page.getByTestId('vacancy-notes-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't08-vacante-notas');
  });

  test('ds-table-nao-regressao t09-pacientes', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/patients');
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't09-pacientes');
  });

  test('ds-table-nao-regressao t10-vacantes', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/vacancies');
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't10-vacantes');
  });

  test('ds-table-nao-regressao t11-reclutamiento', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/recruitment');
    // Achado (medido 27/09, fora do escopo de codar aqui): `ActiveCasesTable` lê `clickUpData`
    // (`useDashboardData`→`getClickUpCases`), que no backend É `job_postings` real (`RecruitmentController.
    // getClickUpCases`, `SELECT jp.status ...`), mas o filtro do front (`useActiveCases.ts`) só aceita
    // `status.toUpperCase()` em {BUSQUEDA, BÚSQUEDA, REEMPLAZO, REEMPLAZOS} — os enums atuais de
    // `job_postings.status` são em inglês (`SEARCHING`, migration 148_normalize_job_posting_status),
    // então NENHUMA vaga do schema atual passa nesse filtro. A tela é VAZIO na prática, para
    // qualquer massa possível nesta stack — não é falta de semente (reportado no retorno do P4).
    const heading = page.getByRole('heading', { level: 1 }).first();
    await expect(heading).toBeVisible();
    await expect(page.locator('table tbody tr')).toHaveCount(0);
    test.info().annotations.push({
      type: 'vazio',
      description: 'ActiveCasesTable filtra status em {BUSQUEDA,REEMPLAZO} (useActiveCases.ts) — job_postings.status atual é inglês (SEARCHING); nenhuma vaga do schema vigente aparece. Achado, não corrigido aqui.',
    });
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't11-reclutamiento');
  });

  test('ds-table-nao-regressao t12-paciente-clinico', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    // Aba default do paciente já é "clinicalData" (PatientDetailPage.tsx) — sem clique.
    await page.goto(`/admin/patients/${massa.patientId}`);
    const projeto = page.getByTestId('projeto-terapeutico-card');
    const equipe = page.getByTestId('equipe-tratante-card');
    await expect(projeto).toBeVisible();
    await expect(equipe).toBeVisible();
    await expect(projeto.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't12-paciente-clinico');
  });

  test('ds-table-nao-regressao t13-paciente-red', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto(`/admin/patients/${massa.patientId}`);
    await page.getByRole('button', { name: 'Red de Apoyo' }).click();
    const familiares = page.getByTestId('familiares-card');
    const externos = page.getByTestId('external-contacts-card');
    await expect(familiares).toBeVisible();
    await expect(externos).toBeVisible();
    await expect(familiares.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't13-paciente-red');
  });

  test('ds-table-nao-regressao t14-paciente-servicio', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto(`/admin/patients/${massa.patientId}`);
    await page.getByRole('button', { name: 'Servicio Contratado' }).click();
    const localizacoes = page.getByTestId('localizacoes-card');
    await expect(localizacoes).toBeVisible();
    await expect(localizacoes.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't14-paciente-servicio');
  });

  test('ds-table-nao-regressao t15-paciente-historial', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto(`/admin/patients/${massa.patientId}`);
    await page.getByRole('button', { name: 'Historial' }).click();
    const historyCard = page.getByTestId('patient-status-history-card');
    await expect(historyCard).toBeVisible();
    await expect(historyCard.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't15-paciente-historial');
  });

  // ── t16-t30 (P5) ───────────────────────────────────────────────────────────────────────────

  test('ds-table-nao-regressao t16-mensajes-por-etapa', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/mensajes-por-etapa');
    // A tabela monta sempre (DX-9.6: FunnelStageMessagesPage.tsx:104), sem depender da massa.
    const table = page.getByTestId('fsm-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't16-mensajes-por-etapa');
  });

  test('ds-table-nao-regressao t17-intentos-bloqueados', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/recruitment/blocked-attempts');
    const content = page.getByTestId('blocked-content');
    await expect(content).toBeVisible();
    await expect(content.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't17-intentos-bloqueados');
  });

  test('ds-table-nao-regressao t18-direcciones-pendientes', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/vacancies/pending-address-review');
    // PendingAddressReviewPage.tsx não tem data-testid de container ao redor da tabela.
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't18-direcciones-pendientes');
  });

  test('ds-table-nao-regressao t19-dedup-cola', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/dedup');
    // Aba default já é "Fila" (DedupCenterPageInner, `activeTab` inicial 'queue') — sem clique.
    const content = page.getByTestId('dedup-content');
    await expect(content).toBeVisible();
    await expect(content.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't19-dedup-cola');
  });

  test('ds-table-nao-regressao t20-dedup-importados', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/dedup');
    // Aba por clique real (DedupTabs.tsx — botão puro, rótulo 'Importados' via i18n).
    await page.getByRole('button', { name: 'Importados', exact: true }).click();
    const content = page.getByTestId('imported-content');
    await expect(content).toBeVisible();
    await expect(content.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't20-dedup-importados');
  });

  test('ds-table-nao-regressao t21-dedup-historial', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/dedup');
    await page.getByRole('button', { name: 'Historial', exact: true }).click();
    const container = page.getByTestId('history-table-container');
    await expect(container).toBeVisible();
    await expect(container.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't21-dedup-historial');
  });

  test('ds-table-nao-regressao t22-catalogo-objetivos', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/catalogos/objetivos-especificos');
    const container = page.getByTestId('therapeutic-catalog-table');
    await expect(container).toBeVisible();
    await expect(container.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't22-catalogo-objetivos');
  });

  test('ds-table-nao-regressao t23-tags', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/tags');
    // TagCatalogPage.tsx não tem data-testid de container ao redor da tabela.
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't23-tags');
  });

  test('ds-table-nao-regressao t24-roles-chat', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/patient-chat-roles');
    const container = page.getByTestId('chat-roles-table');
    await expect(container).toBeVisible();
    await expect(container.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't24-roles-chat');
  });

  test('ds-table-nao-regressao t25-plantillas', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/plantillas');
    const table = page.getByTestId('tc-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't25-plantillas');
  });

  test('ds-table-nao-regressao t26-dashboard', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/dashboard');
    // VAZIO por infra (medido 27/09, fora do escopo de codar aqui): `ManagementDashboardApiService`
    // chama `${getBaseURL()}/analytics/dashboard/management` — SEM o segmento `/api/` que
    // `installAuthInterceptors` troca pelo token mock (`page.route('**/api/**', swapToken)`,
    // abac-stack-helper.ts:134). A requisição sai com o idToken fake do Firebase, e o backend
    // recusa (`MockAuthMiddleware`, "Invalid credentials") — `data` nunca chega e `mgmt-content`/
    // `ZoneAnalyticsSection` não montam nesta stack. O spec pré-existente
    // `management-dashboard-visual.e2e.ts` já contorna isso mockando o endpoint via `page.route`
    // — proibido aqui (BRIEF-COMUM critério 10: "nenhum page.route").
    const errorNode = page.getByTestId('mgmt-error');
    await expect(errorNode).toBeVisible();
    test.info().annotations.push({
      type: 'vazio',
      description: 'GET /analytics/dashboard/management não casa o glob **/api/** do installAuthInterceptors — "Invalid credentials" (MockAuthMiddleware); ZoneAnalyticsSection nunca monta nesta stack sem page.route (proibido). Achado, não corrigido aqui.',
    });
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't26-dashboard');
  });

  test('ds-table-nao-regressao t27-usuarios', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    // Achado (medido 27/09, fora do escopo de codar aqui): a DX-9.6 previa a rota `/admin/users`,
    // mas `AdminUsersPage` é a rota INDEX de `/admin` (App.tsx:238) — não existe
    // `<Route path="users">`. `loginAs` já pousa em `/admin` (abac-stack-helper.ts:159); o `goto`
    // explícito abaixo é só paridade de forma com os demais testes.
    await page.goto('/admin');
    await expect(page.getByTestId('admin-users-header')).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't27-usuarios');
  });

  test('ds-table-nao-regressao t28-acceso-grupos', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/access');
    // VAZIO por acesso (medido 27/09, fora do escopo de codar aqui): `AccessGate` usa
    // `useCellAccess` DIRETO (useCellAccess.ts:31-42) — fail-CLOSED SEMPRE, sem o bypass "engine
    // off" que `useContainerAccess`/`useActionGate` têm (D268/D286). O staff fixo da massa
    // (`DS_TABLE_STAFF`) não está em nenhum `iam.user_groups` com `permission_management:read` —
    // só ganharia entrando num grupo com essa célula (molde:
    // admin-access-panel.integration.e2e.ts:263-272), fora do escopo do P5 (spec só, sem tocar no
    // helper da massa do P3). `AccessGate.tsx:26` redireciona `/admin/access` para `/admin` — a
    // MESMA tela do t27 (confirmado por navegação real, não suposição).
    await expect(page).toHaveURL(/\/admin\/?$/);
    await expect(page.getByTestId('admin-users-header')).toBeVisible();
    test.info().annotations.push({
      type: 'vazio',
      description: 'permission_management:read ausente para o staff fixo da massa — AccessGate (fail-closed sempre, useCellAccess) redireciona /admin/access para /admin. Achado, não corrigido aqui (fora do escopo do P5).',
    });
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't28-acceso-grupos');
  });

  test('ds-table-nao-regressao t29-acceso-features', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/access/features');
    // VAZIO por acesso — mesmo achado do t28 (CountryFeaturesPage também é envolvida por
    // `AccessGate`, mesma célula `permission_management`); confirmado por navegação real.
    await expect(page).toHaveURL(/\/admin\/?$/);
    await expect(page.getByTestId('admin-users-header')).toBeVisible();
    test.info().annotations.push({
      type: 'vazio',
      description: 'permission_management:read ausente para o staff fixo da massa — AccessGate redireciona /admin/access/features para /admin. Mesmo achado do t28, não corrigido aqui.',
    });
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't29-acceso-features');
  });

  test('ds-table-nao-regressao t30-acceso-auditoria', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/access/audit');
    // VAZIO por acesso — mesmo achado do t28 (PermissionHistoryPage também é envolvida por
    // `AccessGate`, mesma célula `permission_management`); confirmado por navegação real.
    // `data-clarity-mask` (PermissionHistoryPage.tsx:134) é irrelevante nesta stack — Clarity só
    // roda em PRD (memória clarity-so-roda-em-prd) — e nunca chega a montar aqui.
    await expect(page).toHaveURL(/\/admin\/?$/);
    await expect(page.getByTestId('admin-users-header')).toBeVisible();
    test.info().annotations.push({
      type: 'vazio',
      description: 'permission_management:read ausente para o staff fixo da massa — AccessGate redireciona /admin/access/audit para /admin. Mesmo achado do t28, não corrigido aqui.',
    });
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't30-acceso-auditoria');
  });
});
