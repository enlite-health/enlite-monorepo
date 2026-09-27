/**
 * compativeis-sem-celula.integration.e2e.ts @integration
 *
 * Integration E2E — Fase 5 da change cadeia-paciente-vacante-itinerario
 * (`CH/execucao/fase-5.md`, P21, DX-5.7/DX-5.11): prova o critério 7 — o card de
 * "Compatíveis" (candidato do match nunca mensageado, `isMatchedNotInvited`) some o
 * NOME sem `match:read`, mas a CONTAGEM continua visível nos 3 lugares — com o engine
 * ABAC de verdade LIGADO, não com token `role: 'admin'` (memória `stack-e2e-abac-ligado`:
 * role admin sem célula não prova nada sob engine ligado, e passa até na variante sem
 * engine — é o que `funil-compativeis-lista-aba-vazia`, P17, já mostra: nome visível
 * porque a stack `cadeia-f5` tem o engine OFF, `cells === null`, D113).
 *
 * Caminho e título SEM `funil-vacante`/`lista-vacantes` de propósito (DX-5.10): este
 * spec não pode entrar no job `pr-gate.yml` (engine OFF) — vai só para
 * `integration-e2e-group-simulation` (engine ON), amarrado por `--grep` no P22.
 *
 * Stack isolada `cadeia-f5-abac` (postgres 5494 / api 8107 / Vite 5191) — NÃO é a
 * `cadeia-f5` dos demais e2e da fase (essa continua com o engine OFF).
 * `PERMISSION_ENGINE_ENABLED`/`PERMISSION_ENFORCED_ROUTES`/`PERMISSION_CATALOG_SYNC_ENABLED`/
 * `PERMISSION_CACHE_TTL_MS` vêm do `docker-compose.group-simulation.yml` (o mesmo trio do
 * job de CI); o override `cadeia-f5-abac.override.yml` só troca porta/nome de
 * container e CORS/auth mock.
 *
 * Usuários reais (`seedStaffInGroup`/`grantCell` de `abac-stack-helper.ts`), célula
 * concedida ANTES do 1º request (TTL do cache do ABAC = 30 s):
 *   - staff A: grupo com `vacancy:read` + `funnel:read` + `worker_contact:read`, SEM `match:read`.
 *   - staff B: as mesmas + `match:read` (controle positivo).
 *
 * Exercises:
 *   P21 — funil-compativeis-sem-celula: API (`GET .../funnel`, `GET .../funnel-table`)
 *         e tela (lista de vacantes, modo lista aba Compatibles, Kanban) com A veem a
 *         contagem de Compatíveis = 1 e o nome REDIGIDO ("Contato restrito", workerId
 *         null); o convidado (INVITED) continua com nome visível (controle: a redação é
 *         só de Compatíveis). Com B (`match:read`), o nome do compatível aparece nas
 *         duas telas.
 */

import { test, expect } from '@playwright/test';
import { seedVacancyWithCards } from '../helpers/funnel-move-e2e-helper';
import {
  seedCompatibleCard,
  cleanupCompatibleCard,
  readFunnelApi,
  readFunnelTableApi,
  type SeedCompatibleCardResult,
} from '../helpers/compativeis-e2e-helper';
import {
  loginAs,
  tokenFor,
  seedStaffInGroup,
  cleanupStaffAndGroup,
  grantCell,
  ABAC_API_URL,
  type MockUser,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const A_UID = `e2e-int-compat-a-${RUN_ID}`;
const A_EMAIL = `${A_UID}@e2e.test`;
const B_UID = `e2e-int-compat-b-${RUN_ID}`;
const B_EMAIL = `${B_UID}@e2e.test`;

const STAFF_A: MockUser = { uid: A_UID, email: A_EMAIL, role: 'recruiter', country: 'AR' };
const STAFF_B: MockUser = { uid: B_UID, email: B_EMAIL, role: 'recruiter', country: 'AR' };

const NOME_REDIGIDO = 'Contato restrito';
// Nome fixo semeado por `seedCompatibleCard` (compativeis-e2e-helper.ts:52-57) — grep
// negativo no DOM prova a redação; positivo (staff B) prova que a célula libera.
const NOME_COMPATIVEL = 'CompativeisE2E';

test.describe('Compatíveis some o nome sem match:read (engine ABAC ligado) @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let vacancyId = '';
  let seedCleanup: (() => void) | undefined;
  let compat: SeedCompatibleCardResult | undefined;
  let groupAId = '';
  let groupBId = '';

  test.beforeAll(() => {
    const seed = seedVacancyWithCards([{ stage: 'INVITED' }]);
    vacancyId = seed.vacancyId;
    seedCleanup = seed.cleanup;
    compat = seedCompatibleCard(vacancyId);

    // Células CONCEDIDAS antes do 1º request (o override liga PERMISSION_CACHE_TTL_MS=30000).
    ({ groupId: groupAId } = seedStaffInGroup({
      uid: A_UID,
      email: A_EMAIL,
      groupName: `Compat A ${RUN_ID}`,
      country: 'AR',
    }));
    grantCell(groupAId, 'vacancy', 'read');
    grantCell(groupAId, 'funnel', 'read');
    grantCell(groupAId, 'worker_contact', 'read');
    // NUNCA match:read no A — é o que este teste prova que falta.

    ({ groupId: groupBId } = seedStaffInGroup({
      uid: B_UID,
      email: B_EMAIL,
      groupName: `Compat B ${RUN_ID}`,
      country: 'AR',
    }));
    grantCell(groupBId, 'vacancy', 'read');
    grantCell(groupBId, 'funnel', 'read');
    grantCell(groupBId, 'worker_contact', 'read');
    grantCell(groupBId, 'match', 'read');
  });

  test.afterAll(() => {
    try {
      cleanupStaffAndGroup(A_UID, groupAId);
    } catch (err) {
      console.error('[cleanup] staff A falhou (seguindo)', err);
    }
    try {
      cleanupStaffAndGroup(B_UID, groupBId);
    } catch (err) {
      console.error('[cleanup] staff B falhou (seguindo)', err);
    }
    try {
      if (compat) cleanupCompatibleCard(compat.workerId, vacancyId);
    } catch (err) {
      console.error('[cleanup] card compatível falhou (seguindo)', err);
    }
    try {
      seedCleanup?.();
    } catch (err) {
      console.error('[cleanup] vaga/paciente falhou (seguindo)', err);
    }
  });

  test('funil-compativeis-sem-celula', async ({ page, request, browser }) => {
    // ── 1. API com A (sem match:read): contagem visível, nome redigido ──────────
    const funnelA = (await readFunnelApi(request, tokenFor(STAFF_A), vacancyId)) as {
      stages: Record<string, Array<{ workerName: string | null; workerId: string | null }>>;
    };
    expect(funnelA.stages.COMPATIBLE?.length, 'A: stages.COMPATIBLE.length').toBe(1);
    expect(funnelA.stages.COMPATIBLE[0].workerName, 'A: nome redigido em Compatíveis').toBe(NOME_REDIGIDO);
    expect(funnelA.stages.COMPATIBLE[0].workerId, 'A: workerId null em Compatíveis').toBeNull();
    // Controle: a redação é SÓ de Compatíveis — o convidado continua com nome visível.
    expect(funnelA.stages.INVITED?.[0]?.workerName, 'A: nome visível em Invitados (controle)').toMatch(
      /FunnelMoveINVITED/,
    );

    const funnelTableA = (await readFunnelTableApi(request, tokenFor(STAFF_A), vacancyId, [
      'COMPATIBLE',
    ])) as { rows: Array<{ workerName: string | null }> };
    expect(funnelTableA.rows.length, 'A: funnel-table?columns=COMPATIBLE → 1 linha').toBe(1);
    expect(funnelTableA.rows[0].workerName, 'A: funnel-table linha redigida').toBe(NOME_REDIGIDO);

    const funnelTableAllA = (await readFunnelTableApi(request, tokenFor(STAFF_A), vacancyId)) as {
      rows: Array<{ workerName: string | null; kanbanColumn: string | null }>;
    };
    const compatRowA = funnelTableAllA.rows.find((r) => r.kanbanColumn === 'COMPATIBLE');
    expect(compatRowA?.workerName, 'A: ?bucket=ALL — linha do compatível redigida').toBe(NOME_REDIGIDO);

    console.log('[5.7] API com A (sem match:read): COMPATIBLE.length=', funnelA.stages.COMPATIBLE.length, 'nome=', funnelA.stages.COMPATIBLE[0].workerName);

    // ── 2. Tela com A: lista de vacantes, modo lista (aba Compatibles), Kanban ──
    await loginAs(page, STAFF_A);

    const [listResponse] = await Promise.all([
      page.waitForResponse((r) => /\/api\/admin\/vacancies\?/.test(r.url()) && r.request().method() === 'GET'),
      page.goto('/admin/vacancies'),
    ]);
    expect(listResponse.ok(), 'GET /api/admin/vacancies falhou').toBe(true);
    const vacantesCompat = page.getByTestId(`vacancy-row-${vacancyId}-stage-COMPATIBLE`);
    await vacantesCompat.scrollIntoViewIfNeeded();
    await expect(vacantesCompat, 'lista de vacantes: stage-COMPATIBLE').toHaveText('01');

    await page
      .evaluate((id) => localStorage.removeItem(`vacancy-funnel-view-${id}`), vacancyId)
      .catch(() => {});
    const funnelTableRe = new RegExp(`/vacancies/${vacancyId}/funnel-table(\\?|$)`);
    const [tableResponse] = await Promise.all([
      page.waitForResponse((r) => funnelTableRe.test(r.url()) && r.request().method() === 'GET'),
      page.goto(`/admin/vacancies/${vacancyId}`),
    ]);
    expect(tableResponse.ok(), 'GET funnel-table falhou').toBe(true);
    await expect(page.getByTestId('vacancy-funnel-view')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('funnel-tab-COMPATIBLE-count'), 'modo lista: aba Compatibles = 1').toHaveText('1');
    await page.locator('#funnel-tab-COMPATIBLE').click();
    const rows = page.locator('[data-testid^="funnel-row-"]');
    await expect(rows, 'modo lista aba Compatibles: 1 linha').toHaveCount(1);
    await expect(rows.first(), 'modo lista: linha SEM o nome do compatível').not.toContainText(NOME_COMPATIVEL);
    await expect(rows.first(), 'modo lista: linha mostra o texto de redação').toContainText(NOME_REDIGIDO);

    const funnelRe = new RegExp(`/vacancies/${vacancyId}/funnel(\\?|$)`);
    const [kanbanResponse] = await Promise.all([
      page.waitForResponse((r) => funnelRe.test(r.url()) && r.request().method() === 'GET'),
      page
        .getByRole('group', { name: 'Cambiar vista' })
        .getByRole('button', { name: /Kanban/i })
        .click(),
    ]);
    expect(kanbanResponse.ok(), 'GET funnel (kanban) falhou').toBe(true);
    await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByTestId('kanban-column-COMPATIBLE-count'),
      'Kanban: kanban-column-COMPATIBLE-count = 1',
    ).toHaveText('1');
    const kanbanCompatColumn = page.getByTestId('kanban-column-COMPATIBLE');
    await expect(kanbanCompatColumn, 'Kanban: coluna Compatíveis SEM o nome').not.toContainText(NOME_COMPATIVEL);
    await expect(kanbanCompatColumn, 'Kanban: coluna Compatíveis mostra o texto de redação').toContainText(
      NOME_REDIGIDO,
    );
    // Controle: o convidado (nome visível) aparece em Invitados, mesma tela.
    await expect(
      page.getByTestId('kanban-column-INVITED'),
      'Kanban: nome do convidado aparece em Invitados (controle)',
    ).toContainText('FunnelMoveINVITED');

    console.log('[5.7] Tela com A: vacantes=01, aba=1 (sem nome), kanban=1 (sem nome)');

    // ── 3. Contexto novo com B (match:read): o nome aparece nas duas telas ──────
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await loginAs(page2, STAFF_B);

    await page2
      .evaluate((id) => localStorage.removeItem(`vacancy-funnel-view-${id}`), vacancyId)
      .catch(() => {});
    const [tableResponse2] = await Promise.all([
      page2.waitForResponse((r) => funnelTableRe.test(r.url()) && r.request().method() === 'GET'),
      page2.goto(`/admin/vacancies/${vacancyId}`),
    ]);
    expect(tableResponse2.ok(), 'B: GET funnel-table falhou').toBe(true);
    await page2.locator('#funnel-tab-COMPATIBLE').click();
    await expect(
      page2.locator('[data-testid^="funnel-row-"]').first(),
      'B (match:read): nome do compatível visível no modo lista',
    ).toContainText(NOME_COMPATIVEL);

    const [kanbanResponse2] = await Promise.all([
      page2.waitForResponse((r) => funnelRe.test(r.url()) && r.request().method() === 'GET'),
      page2
        .getByRole('group', { name: 'Cambiar vista' })
        .getByRole('button', { name: /Kanban/i })
        .click(),
    ]);
    expect(kanbanResponse2.ok(), 'B: GET funnel (kanban) falhou').toBe(true);
    await expect(page2.getByTestId('kanban-board')).toBeVisible({ timeout: 15_000 });
    await expect(
      page2.getByTestId('kanban-column-COMPATIBLE'),
      'B (match:read): nome do compatível visível no Kanban',
    ).toContainText(NOME_COMPATIVEL);

    console.log('[5.7] Tela com B (match:read): nome do compatível visível nas duas telas — controle positivo OK');

    await ctx2.close();
  });
});
