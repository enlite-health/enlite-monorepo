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
 *
 * Q-9.4 (P6-fix-3, orquestrador): o print sai em DUAS imagens — `<slug>.png` (página inteira) e
 * `<slug>.table.png` (recorte, via `target.screenshot()` nativo do Playwright — P11-fix — no MESMO
 * locator que a asserção (i) já usa para provar "tabela montada": o `<table>` do consumidor, ou o
 * container do átomo quando a tela é VAZIO e não há `<table>` nenhum).
 *
 * Q-9.4 segunda decisão (P11-fix-2, orquestrador, 28/09): o critério 7 literal do `fase-9.md`
 * (`for p in antes/*.png; do compare … "depois/$(basename "$p")" …; done`) roda sobre a PÁGINA
 * INTEIRA (`<slug>.png`), não o recorte — o recorte `<slug>.table.png` segue fotografado e
 * comparado só como evidência SUPLEMENTAR. Motivo: um jitter residual de ~1px em `box.y` do alvo,
 * sem causa raiz localizada entre invocações separadas do `npx playwright test` (diagnóstico denso
 * em `P11-fix.md`), pode deixar o recorte apertado ≠ 0 mesmo quando a página inteira — que contém o
 * mesmo pixel de conteúdo com folga ao redor — fecha idêntica. Ver `CH/evidencias/fase-9/mascaras.md`
 * §Q-9.4.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { loginAs, tokenFor } from '../helpers/abac-stack-helper';
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

  // P11-fix (Hipótese B, mantida como melhoria defensiva mesmo não sendo a causa confirmada do
  // jitter de `t06`): relógio congelado ANTES de qualquer navegação — fecha uma classe de risco
  // real (algum nó não localizado usando `new Date()`/`Date.now()` no lado do browser), regra 8 do
  // BRIEF-COMUM. Data fixa arbitrária, fora de qualquer janela de expiração da massa sintética.
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-14T10:00:00-03:00'));
  });

  /** Espera fontes carregadas antes do print — critério 12 do BRIEF-COMUM. */
  async function waitFontsReady(page: Page): Promise<void> {
    await page.evaluate(() => document.fonts.ready);
  }

  /**
   * `PRINT_DIR` lido DENTRO do teste (rule 11) — screenshot só quando existe (critério 12).
   * Q-9.4 (P6-fix-3): sempre duas imagens — página inteira (`<slug>.png`) e o recorte do alvo
   * (`<slug>.table.png`, o `<table>` do consumidor ou o container do átomo em telas VAZIO) —
   * `target` é o MESMO locator que a asserção (i) do teste já usa para provar "tabela
   * montada"/"vazio visível". **`scrollIntoViewIfNeeded` antes de medir:** o shell do admin tem
   * sidebar/header fixos e o painel de conteúdo rola por dentro (`<main class="… overflow-y-auto">`,
   * não o documento) — `document.documentElement.scrollHeight` fica preso ao viewport (768) e o
   * `fullPage: true` do Playwright NÃO enxerga esse scroll interno (medido: `t03-prestadores` tem
   * `<table>` em `y=812.5`, fora do range 0-768, e o PNG `fullPage` sai com 768px de altura mesmo
   * assim — a tabela dessas telas fica abaixo da dobra do painel). `scrollIntoViewIfNeeded()` rola
   * o painel interno até o alvo ficar visível ANTES de medir e fotografar — nas telas onde o alvo já
   * está visível é no-op (nenhuma mudança de comportamento).
   *
   * P11-fix (Hipótese A, CONFIRMADA e mantida — `mascaras.md` §Q-9.4 segunda decisão): o recorte
   * `.table.png` fotografa com `target.screenshot()` NATIVO do Playwright em vez do `clip` manual
   * calculado a partir de `boundingBox()` + margem + clamp em `document.documentElement.scrollHeight`
   * (que ficava preso a 768 pelo scroll interno do `<main>` e vazava jitter de `box.y` 1:1 para a
   * altura do PNG). `target.screenshot()` resolve seu próprio recorte internamente, sem o clamp —
   * elimina essa classe de bug de instrumento. Mesmo assim, um jitter residual de ~1px em `box.y`
   * entre invocações separadas do `npx playwright test` (nunca dentro da mesma invocação) persiste
   * sem causa raiz localizada (diagnóstico denso em `P11-fix.md`, Parte 2.4) — por isso o critério 7
   * (CMP-F9, `AE=0`) passa a rodar sobre a PÁGINA INTEIRA (`<slug>.png`, decisão do orquestrador
   * Q-9.4 de 28/09), e o recorte `<slug>.table.png` segue gerado e comparado só como evidência
   * SUPLEMENTAR (a página inteira idêntica prova que a diferença do recorte não é pixel de
   * conteúdo, e sim origem do recorte deslocada em ~1px).
   */
  async function maybeScreenshot(page: Page, slug: string, target: Locator): Promise<void> {
    const dir = process.env.PRINT_DIR;
    if (!dir) return;
    await target.scrollIntoViewIfNeeded();
    // Duplo rAF: garante que o browser pintou pelo menos um frame com fontes prontas antes de medir
    // e fotografar — reduz corrida entre `document.fonts.ready` (resolve no load da fonte, não no
    // paint) e o rasterizador de texto (a classe de instabilidade de subpixel do Chromium/macOS que
    // o P6/P6-fix/P6-fix-2 mediram: 4/30, 4/30, 2/30 telas aleatórias). Roda ANTES das duas fotos —
    // inclusive antes do `target.screenshot()` nativo, que lê `boundingBox()` internamente.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // `mascaras.md` §Q-9.4: o Firebase SDK injeta um `<p style="position:fixed;bottom:0">` de aviso
    // do emulador (`firebase-auth-compat.js`, função `d()`) de forma intermitente (após a 1ª chamada
    // de auth) — sem classe/testid, texto fixo. Não é produto nem a tabela; sobrepõe o rodapé da tela
    // e foi o nó que o A1×A2 acusou em `t06-vacante-match` (a encuadres table do funil fica perto do
    // rodapé, atrás do modal). Mask, não recorte — o critério 12 permite ("nunca a tabela inteira").
    const emulatorBanner = page.locator('p', { hasText: 'Running in emulator mode' });
    await page.screenshot({ path: `${dir}/${slug}.png`, fullPage: true, animations: 'disabled', caret: 'hide', mask: [emulatorBanner] });
    await target.screenshot({ path: `${dir}/${slug}.table.png`, animations: 'disabled', caret: 'hide', mask: [emulatorBanner] });
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
    await maybeScreenshot(page, 't01-anacare-horas', errorNode);
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
    await maybeScreenshot(page, 't02-anacare-horas-paciente', errorNode);
  });

  test('ds-table-nao-regressao t03-prestadores', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/workers');
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't03-prestadores', page.locator('table').first());
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
    await maybeScreenshot(page, 't04-prestador-ficha', card.locator('table').first());
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
    await maybeScreenshot(page, 't05-vacante-encuadres', funnel.locator('table').first());
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
    await maybeScreenshot(page, 't06-vacante-match', page.locator('table').first());
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
    await maybeScreenshot(page, 't07-vacante-talentum', page.locator('table').first());
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
    await maybeScreenshot(page, 't08-vacante-notas', panel.locator('table').first());
  });

  test('ds-table-nao-regressao t09-pacientes', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/patients');
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't09-pacientes', page.locator('table').first());
  });

  test('ds-table-nao-regressao t10-vacantes', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/vacancies');
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't10-vacantes', page.locator('table').first());
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
    // Q-9.4: `ActiveCasesTable` no ramo vazio (cases.length === 0) não renderiza `<table>` nenhum
    // (`ActiveCasesTable.tsx:108-116`, só um `<div>` com o texto `noCase`) — sem alvo de tabela para
    // recortar, o fallback é o container do átomo mais próximo já provado visível: a heading da página.
    await maybeScreenshot(page, 't11-reclutamiento', heading);
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
    await maybeScreenshot(page, 't12-paciente-clinico', projeto.locator('table').first());
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
    await maybeScreenshot(page, 't13-paciente-red', familiares.locator('table').first());
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
    await maybeScreenshot(page, 't14-paciente-servicio', localizacoes.locator('table').first());
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
    await maybeScreenshot(page, 't15-paciente-historial', historyCard.locator('table').first());
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
    await maybeScreenshot(page, 't16-mensajes-por-etapa', table);
  });

  test('ds-table-nao-regressao t17-intentos-bloqueados', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/recruitment/blocked-attempts');
    const content = page.getByTestId('blocked-content');
    await expect(content).toBeVisible();
    await expect(content.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't17-intentos-bloqueados', content.locator('table').first());
  });

  test('ds-table-nao-regressao t18-direcciones-pendientes', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/vacancies/pending-address-review');
    // PendingAddressReviewPage.tsx não tem data-testid de container ao redor da tabela.
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't18-direcciones-pendientes', page.locator('table').first());
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
    await maybeScreenshot(page, 't19-dedup-cola', content.locator('table').first());
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
    await maybeScreenshot(page, 't20-dedup-importados', content.locator('table').first());
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
    await maybeScreenshot(page, 't21-dedup-historial', container.locator('table').first());
  });

  test('ds-table-nao-regressao t22-catalogo-objetivos', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/catalogos/objetivos-especificos');
    const container = page.getByTestId('therapeutic-catalog-table');
    await expect(container).toBeVisible();
    await expect(container.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't22-catalogo-objetivos', container.locator('table').first());
  });

  test('ds-table-nao-regressao t23-tags', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/tags');
    // TagCatalogPage.tsx não tem data-testid de container ao redor da tabela.
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't23-tags', page.locator('table').first());
  });

  test('ds-table-nao-regressao t24-roles-chat', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/patient-chat-roles');
    const container = page.getByTestId('chat-roles-table');
    await expect(container).toBeVisible();
    await expect(container.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't24-roles-chat', container.locator('table').first());
  });

  test('ds-table-nao-regressao t25-plantillas', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/plantillas');
    const table = page.getByTestId('tc-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't25-plantillas', table);
  });

  test('ds-table-nao-regressao t26-dashboard', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    // P3.1 (achado 1 do P5, auth corrigido): `ManagementDashboardApiService`/`ZoneAnalyticsApiService`
    // chamam `/analytics/dashboard/*` — SEM o segmento `/api/` que `installAuthInterceptors` troca
    // pelo token mock (glob `**/api/**`, abac-stack-helper.ts, sem parâmetro de padrão de URL).
    // Injeta o MESMO Authorization que o `loginAs` já injeta nas outras rotas — não é mock de
    // resposta, a request e a resposta seguem reais (fix de auth, não de dado).
    await page.route('**/analytics/**', async (route) => {
      await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${tokenFor(DS_TABLE_STAFF)}` } });
    });
    // P3.2: com o escopo de país (AR) semeado em `iam.group_country_scopes` pela massa
    // (`ds-table-massa-helper.ts`, `ensureDsTableMassa`), `resolveCountryScope.ts` já não
    // devolve 403 — a rota responde de verdade. `waitForResponse` prova que a requisição real
    // (não interceptada por mock de resposta) voltou 200 antes de afirmar a tabela.
    const [mgmtResponse] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/analytics/dashboard/management') && resp.status() === 200,
      ),
      page.goto('/admin/dashboard'),
    ]);
    expect(mgmtResponse.status()).toBe(200);
    await expect(page.getByTestId('mgmt-content')).toBeVisible();
    // Tabela real do `ZoneAnalyticsSection` (consumidor do átomo `Table`, DX-9.6/t26): a linha
    // com 6 `td` (zone/patients/workersMale/workersFemale/demand/availability) só existe quando
    // `data.zones` tem pelo menos 1 zona — o empty-state renderiza 1 `td` com `colSpan={6}`
    // (`ZoneAnalyticsSection.tsx:134-140`), então contar as células distingue tabela montada de
    // estado vazio sem depender do texto i18n.
    const zoneSection = page.getByTestId('mgmt-zone-analytics');
    await expect(zoneSection).toBeVisible();
    const zoneRows = zoneSection.locator('table tbody tr');
    await expect(zoneRows.first()).toBeVisible();
    await expect(zoneRows.first().locator('td')).toHaveCount(6);
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't26-dashboard', zoneSection.locator('table').first());
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
    await maybeScreenshot(page, 't27-usuarios', page.locator('table').first());
  });

  test('ds-table-nao-regressao t28-acceso-grupos', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/access');
    // P3.1 (achado 2 do P5, corrigido): staff fixo agora está no grupo `DS Tabla — acceso F9`
    // (`permission_management:read`, semeado em `ensureDsTableMassa`) — `AccessGate` monta o
    // painel de verdade em vez de redirecionar para `/admin`.
    await expect(page.getByTestId('access-groups-header')).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't28-acceso-grupos', page.locator('table').first());
  });

  test('ds-table-nao-regressao t29-acceso-features', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/access/features');
    // P3.1 (achado 2 do P5, corrigido) — mesmo grupo do t28 dá acesso a esta rota também.
    await expect(page).toHaveURL(/\/admin\/access\/features\/?$/);
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't29-acceso-features', page.locator('table').first());
  });

  test('ds-table-nao-regressao t30-acceso-auditoria', async ({ page }) => {
    await loginAs(page, DS_TABLE_STAFF);
    await page.goto('/admin/access/audit');
    // P3.1 (achado 2 do P5, corrigido) — mesmo grupo do t28 dá acesso a esta rota também.
    // `data-clarity-mask` (PermissionHistoryPage.tsx:134) é irrelevante nesta stack — Clarity só
    // roda em PRD (memória clarity-so-roda-em-prd) — e nunca chega a montar aqui.
    await expect(page).toHaveURL(/\/admin\/access\/audit\/?$/);
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await waitFontsReady(page);
    await expectNoSelectedRow(page);
    await maybeScreenshot(page, 't30-acceso-auditoria', page.locator('table').first());
  });
});
