/**
 * compativeis-e2e-helper.ts
 *
 * Helper e2e da Fase 5 (change cadeia-paciente-vacante-itinerario, P16 — DX-5.10/DX-5.13):
 * semear um card "Compatible" (matched, não convidado: `INVITED`/`system` SEM `messaged_at` —
 * `isMatchedNotInvited`, `WF/domain/kanbanColumn.ts:42-48`), uma vaga isolada por geografia
 * (para a contagem do match não depender do lixo de outros e2e), rodar o match pela rota real
 * e ler a contagem de "Compatibles" nos 3 lugares (Kanban, aba do funil, lista de vacantes).
 *
 * Reusa sem copiar: `insertTestWorker`/`insertTestPatient`/`insertBaseVacancy`/`cleanupTestWorker`/
 * `cleanupTestPatient` (db-test-helper.ts), `insertWJA`/`upsertEncuadre`/`cleanupWJAAndEncuadre`
 * (wja-test-helper.ts), `runSQL` (patient-detail-a-helper.ts — honra `E2E_PG_CONTAINER`).
 * `countOutboundSince` (funnel-move-e2e-helper.ts) já cobre a contagem de `messaging_outbox` —
 * nenhuma função nova para isso aqui (o teste importa direto de lá).
 *
 * `startPeriskopeStub`/`seedVacancyMatchTemplates` seguem o MESMO comportamento de
 * `kanban-reenviar.integration.e2e.ts:40-56,99-103` (hoje locais nele e em mais 4 specs —
 * unificar os antigos para importar daqui é LISTA, DX-5.10, não escopo deste passo).
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import http from 'http';
import { insertTestPatient, insertBaseVacancy, insertTestWorker, cleanupTestPatient, cleanupTestWorker } from './db-test-helper';
import { insertWJA, upsertEncuadre, cleanupWJAAndEncuadre } from './wja-test-helper';
import { runSQL } from './patient-detail-a-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';

// ── Semente: card "Compatible" (matched, não convidado) ──────────────────────────

export interface SeedCompatibleCardOpts {
  lat?: number;
  lng?: number;
  /** `true` → canal periskope (vai para o stub da 9911 — teste nunca toca canal real). */
  periskope?: boolean;
}

export interface SeedCompatibleCardResult {
  workerId: string;
  wjaId: string;
  encuadreId: string;
}

/**
 * Worker REGISTERED (com coords, se dadas, e telefone único — default de `insertTestWorker`)
 * + WJA `INVITED`/`system` SEM `messaged_at` + encuadre. O trigger
 * `trg_ensure_encuadre_on_wja_insert` já cria o encuadre no INSERT da WJA — `upsertEncuadre`
 * só devolve o id (o `ON CONFLICT` dele não sobrescreve nada de novo aqui).
 */
export function seedCompatibleCard(vacancyId: string, opts: SeedCompatibleCardOpts = {}): SeedCompatibleCardResult {
  const { lat, lng, periskope = false } = opts;

  const workerId = insertTestWorker({
    firstName: 'CompativeisE2E',
    lastName: `Seed-${Date.now()}`,
    lat: lat ?? null,
    lng: lng ?? null,
  });

  const wjaId = insertWJA({
    workerId,
    jobPostingId: vacancyId,
    funnelStage: 'INVITED',
    source: 'system',
  });

  const encuadreId = upsertEncuadre({ workerId, jobPostingId: vacancyId });

  if (periskope) {
    runSQL(`UPDATE workers SET messaging_channel = 'periskope' WHERE id = '${workerId}'`);
  }

  return { workerId, wjaId, encuadreId };
}

/** Apaga o card (WJA + encuadre + worker) — reusa `cleanupWJAAndEncuadre`/`cleanupTestWorker`. */
export function cleanupCompatibleCard(workerId: string, vacancyId: string): void {
  cleanupWJAAndEncuadre(workerId, vacancyId);
  cleanupTestWorker(workerId);
}

// ── Semente: vaga isolada por geografia (DX-5.13) ─────────────────────────────────

export interface SeedIsolatedVacancyOpts {
  lat: number;
  lng: number;
}

export interface SeedIsolatedVacancyResult {
  patientId: string;
  vacancyId: string;
  cleanup: () => void;
}

/**
 * Paciente com endereço na coordenada dada + vaga `SEARCHING`/publicada — o hard filter do
 * match pega todo worker REGISTERED do banco dentro do raio
 * (`WF/infrastructure/MatchmakingHardFilterQuery.ts:76-117`); nascer a vaga numa coordenada
 * própria é o que isola a contagem do lixo de outros e2e (DX-5.13).
 */
export function seedIsolatedVacancy(opts: SeedIsolatedVacancyOpts): SeedIsolatedVacancyResult {
  const { lat, lng } = opts;
  const { patientId, addressId } = insertTestPatient({
    withAddress: true,
    firstName: 'CompativeisIsolada',
    lastName: `Seed-${Date.now()}`,
    addressLat: lat,
    addressLng: lng,
  });
  if (!addressId) {
    throw new Error('seedIsolatedVacancy: insertTestPatient não devolveu addressId (withAddress: true)');
  }

  // Base própria (989_000), distinta de 986_000 (Fase 3) e 988_000 (Fase 4) — evita colisão
  // se as sementes rodarem na mesma janela de teste.
  const caseNumber = 989_000 + Math.floor(Math.random() * 900);
  const vacancyId = insertBaseVacancy({
    patientId,
    patientAddressId: addressId,
    caseNumber,
    status: 'SEARCHING',
    isDraft: false,
  });

  const cleanup = (): void => {
    cleanupTestPatient(patientId);
  };

  return { patientId, vacancyId, cleanup };
}

// ── Rota do match (DX-5.13) ────────────────────────────────────────────────────────

export interface RunMatchApiOpts {
  radiusKm?: number;
  topN?: number;
}

export interface RunMatchApiResult {
  status: number;
  body: unknown;
}

/**
 * `POST /api/admin/vacancies/:id/match` — a rota real do match
 * (`WF/interfaces/controllers/VacancyMatchController.ts:30-58`, `match:execute`). Não envia
 * convite (`triggerMatch` só chama `matchWorkersForJob`) — o envio é gatilho separado
 * (`VacancyAutoInviteHandler`).
 */
export async function runMatchApi(
  request: APIRequestContext,
  token: string,
  vacancyId: string,
  opts: RunMatchApiOpts = {},
): Promise<RunMatchApiResult> {
  const { radiusKm = 1, topN = 200 } = opts;
  const res = await request.post(
    `${BACKEND_URL}/api/admin/vacancies/${vacancyId}/match?radius_km=${radiusKm}&top_n=${topN}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
}

// ── Leitura do funil pela API ──────────────────────────────────────────────────────

/** `GET /api/admin/vacancies/:id/funnel` — devolve o `data` cru da resposta. */
export async function readFunnelApi(request: APIRequestContext, token: string, vacancyId: string): Promise<unknown> {
  const res = await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}/funnel`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  return body?.data;
}

/** `GET /api/admin/vacancies/:id/funnel-table` — `columns` filtra (ex.: `['COMPATIBLE']`). */
export async function readFunnelTableApi(
  request: APIRequestContext,
  token: string,
  vacancyId: string,
  columns?: string[],
): Promise<unknown> {
  const qs = columns && columns.length > 0 ? `?columns=${columns.join(',')}` : '';
  const res = await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}/funnel-table${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  return body?.data;
}

// ── Navegação (P17/P18/P19/P20 — molde `funil-vacante-motivo.integration.e2e.ts`) ──
// Byte-idênticas nos 4 specs novos (achado 🟡-3 do gate parcial da Fase 5, G2); movidas
// aqui em vez de repetidas — cada spec só importa.

/**
 * `VacancyFunnelView.tsx` persiste a última vista (list/kanban) em
 * `localStorage['vacancy-funnel-view-<id>']` — limpa antes de cada visita fresca,
 * senão uma 2ª navegação à MESMA vaga reabre em Kanban (molde da Fase 2/4).
 */
export async function gotoVacancyDetail(page: Page, vacancyId: string): Promise<void> {
  await page
    .evaluate((id) => localStorage.removeItem(`vacancy-funnel-view-${id}`), vacancyId)
    .catch(() => {});
  const funnelTableRe = new RegExp(`/vacancies/${vacancyId}/funnel-table(\\?|$)`);
  const [response] = await Promise.all([
    page.waitForResponse((r) => funnelTableRe.test(r.url()) && r.request().method() === 'GET'),
    page.goto(`/admin/vacancies/${vacancyId}`),
  ]);
  expect(response.ok(), 'GET funnel-table falhou').toBe(true);
  await expect(page.getByTestId('vacancy-funnel-view')).toBeVisible({ timeout: 15_000 });
}

export async function switchToKanban(page: Page, vacancyId: string): Promise<void> {
  const funnelRe = new RegExp(`/vacancies/${vacancyId}/funnel(\\?|$)`);
  const [response] = await Promise.all([
    page.waitForResponse((r) => funnelRe.test(r.url()) && r.request().method() === 'GET'),
    page
      .getByRole('group', { name: 'Cambiar vista' })
      .getByRole('button', { name: /Kanban/i })
      .click(),
  ]);
  expect(response.ok(), 'GET funnel (kanban) falhou').toBe(true);
  await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 15_000 });
}

/** Lê a contagem de UM testid (número cru, sem padding — kanban/aba usam texto puro). */
export async function readStageCount(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).textContent())?.trim() ?? '';
  return Number(text);
}

// ── Leitura na tela — os 3 lugares (DX-5.10) ───────────────────────────────────────

export interface CompatibleCountsOnScreen {
  kanban?: number;
  lista?: number;
  vacantes?: number;
}

async function readCountByTestId(page: Page, testId: string): Promise<number | undefined> {
  const locator = page.getByTestId(testId);
  if ((await locator.count()) === 0) return undefined;
  const text = (await locator.first().textContent())?.trim() ?? '';
  const n = Number(text);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Lê a contagem de "Compatibles" onde ela estiver visível — `kanban-column-COMPATIBLE-count`
 * (Kanban), `funnel-tab-COMPATIBLE-count` (aba do funil, o número dentro de `#funnel-tab-
 * COMPATIBLE`) e `vacancy-row-<vacancyId>-stage-COMPATIBLE` (lista de vacantes). Cada um só
 * existe na tela em que o chamador navegou — o ausente devolve `undefined`, nunca lança.
 */
export async function readCompatibleCountsOnScreen(page: Page, vacancyId: string): Promise<CompatibleCountsOnScreen> {
  const kanban = await readCountByTestId(page, 'kanban-column-COMPATIBLE-count');
  const lista = await readCountByTestId(page, 'funnel-tab-COMPATIBLE-count');
  const vacantes = await readCountByTestId(page, `vacancy-row-${vacancyId}-stage-COMPATIBLE`);
  return { kanban, lista, vacantes };
}

// ── Stub Periskope + templates do convite (molde kanban-reenviar) ─────────────────

export interface PeriskopeStubCall {
  path: string;
  body: string;
}

export interface PeriskopeStub {
  server: http.Server;
  calls: PeriskopeStubCall[];
}

/**
 * Stub do Periskope: aceita `POST /message/send` e conta as chamadas. Mesmo comportamento de
 * `kanban-reenviar.integration.e2e.ts:40-56` — teste nunca toca canal real.
 */
export function startPeriskopeStub(): PeriskopeStub {
  const port = Number(process.env.PERISKOPE_STUB_PORT ?? 9911);
  const calls: PeriskopeStubCall[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.endsWith('/message/send')) {
        calls.push({ path: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'queued', unique_id: `stub-${calls.length}`, queue_id: 'q-1' }));
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  server.listen(port, '0.0.0.0');
  return { server, calls };
}

/**
 * Semeia os 2 templates do convite — o setup do e2e do backend TRUNCA `message_templates`.
 * Mesmo comportamento de `kanban-reenviar.integration.e2e.ts:99-103`.
 */
export function seedVacancyMatchTemplates(): void {
  runSQL(`INSERT INTO message_templates (slug, name, body, category, is_active) VALUES
    ('ar_vacancy_match_complete', 'E2E match completo', 'Hola {{worker_name}}, hay una vacante para vos.', 'vacancy', true),
    ('ar_vacancy_match_incomplete', 'E2E match incompleto', 'Hola {{worker_name}}, completá tu registro.', 'vacancy', true)
    ON CONFLICT (slug) DO UPDATE SET is_active = true`);
}
