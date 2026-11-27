/**
 * admin-presence-review.e2e.ts @integration — emenda 077 §6 (T-806-57): a tela "Revisión de presencia" (`/admin/presencia/revision`) contra o stack
 * local INTEIRO (WF + attendance + banco), com o engine ABAC LIGADO e staff REAL em grupo (células por SQL). Nenhum `page.route` de dado: o único
 * `page.route` é o do login (`loginAs`: troca o token, a request e a resposta seguem reais). Gestos humanos: click + teclado, nunca `fill()`.
 *
 *  feliz        — coordenação (célula `presence_exception:review`) aprova uma exceção de lugar pendente com código e ela SAI da fila (relida do attendance);
 *                 o attendance gravou APPROVED com o uid dela.
 *  alternativo 1 — rechaza com código e a ocorrência SAI das horas do mês, lido pela API de horas (−120 min, −1 turno); a aprovada do feliz segue contando.
 *  alternativo 2 — usuária sem a célula: sem item no menu, a URL mostra "Sin acceso" e as 2 rotas respondem 403 (nenhuma decisão gravada).
 *
 * ⚠️ Escrito para a F9 e NÃO executado (nem local, nem no CI): precisa do stack de `docker compose -p presenca806` com WF + attendance + 2 bancos.
 * Variáveis: ABAC_API_URL/ABAC_TEST_DB_URL (WF, como os irmãos ABAC), ATTENDANCE_TEST_DB_URL, ATTENDANCE_API_URL, E2E_ATTENDANCE_HOURS_HEADERS,
 * E2E_PG_CONTAINER (o `seedItinerary` semeia o paciente/prestador no MESMO banco do WF). `PERMISSION_CATALOG_SYNC_ENABLED=true` no WF (a célula
 * nova entra no catálogo no boot). Roda no projeto `chromium-admin` (login próprio), fora do conjunto do `pr-gate`.
 */
import { test, expect } from '@playwright/test';
import {
  ABAC_API_URL, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, safeSql, seedStaffInGroup, tokenFor, type MockUser,
} from './helpers/abac-stack-helper';
import { cleanupItinerary, seedItinerary, seedTitularAllocation, type ItinerarySeed } from './helpers/itinerary-db-helper';
import { decisionOf, plusDays, readMonthHours, seedPendingException, type PendingException } from './helpers/presence-review-seed';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const mk = (nome: string): MockUser => ({ uid: `e2e-prs-${nome}-${RUN}`, email: `prs.${nome}.${RUN}@e2e.test`, role: 'recruiter', country: 'AR' });
const COORD = mk('coord');
const SEM = mk('sem');
const grupos: Record<string, string> = {};

const REVISION = '/admin/presencia/revision';
const NOME_PRESTADOR = 'Alberto Marquez'; // o titular do `seedItinerary`
const label = (onDate: string): string => `${onDate.split('-').reverse().join('/')} · 09:00–11:00`;

let seed: ItinerarySeed;
let aprovada: PendingException; // feliz
let recusada: PendingException; // alternativo 1
let intocada: PendingException; // alternativo 2 (a rota recusa: segue pendente)
let minutosAntes: { workedMinutes: number; shifts: number };

const api = (u: MockUser, method: 'GET' | 'POST', path: string, body?: unknown) =>
  fetch(`${ABAC_API_URL}${path}`, { method, headers: { Authorization: `Bearer ${tokenFor(u)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test.describe('revisión de presencia 077 — a coordenación decide, sin célula no entra @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test.beforeAll(async ({ request }) => {
    seed = seedItinerary();
    seedTitularAllocation(seed);
    const w = seed.titularWorkerId;
    const base = { workerId: w, slotId: seed.slotId, uid: `e2e-prs-worker-${RUN}` };
    aprovada = seedPendingException({ ...base, onDate: seed.nextMonday });
    recusada = seedPendingException({ ...base, onDate: plusDays(seed.nextMonday, 7) });
    intocada = seedPendingException({ ...base, onDate: plusDays(seed.nextMonday, 14) });
    for (const [chave, u] of [['coord', COORD], ['sem', SEM]] as Array<[string, MockUser]>) {
      grupos[chave] = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `Prs077 ${chave} ${RUN}`, country: 'AR' }).groupId;
    }
    grantCell(grupos.coord, 'presence_exception', 'review');
    // O contrato de acesso tem cache no backend: espera a célula chegar ANTES de abrir a tela.
    await pollAuthz(request, COORD, (b) => b?.permissions?.includes('presence_exception:review'));
    minutosAntes = await readMonthHours(recusada.onDate.slice(0, 7), w);
  });

  test.afterAll(() => {
    for (const [chave, u] of [['coord', COORD], ['sem', SEM]] as Array<[string, MockUser]>) cleanupStaffAndGroup(u.uid, grupos[chave] ?? '');
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE 'Prs077 % ${RUN}'`);
    if (seed) cleanupItinerary(seed); // os fatos do attendance são imutáveis: não há o que apagar lá (ver presence-review-seed.ts)
  });

  test('feliz: aprovar uma exceção de lugar pendente, com código, e ela sai da fila', async ({ page }) => {
    await loginAs(page, COORD);
    const item = page.locator(`a[href="${REVISION}"]`);
    await expect(item.first()).toBeVisible({ timeout: 30_000 });
    await item.first().click();
    await expect(page.getByTestId('presence-review-page')).toBeVisible();

    const fila = page.getByTestId('presence-row').filter({ hasText: label(aprovada.onDate) });
    await expect(fila).toHaveCount(1);
    await expect(fila).toContainText(NOME_PRESTADOR);          // nome resolvido pelo WF na leitura
    await expect(fila).toContainText('Excepción de lugar');
    await expect(fila).toContainText('El GPS no funciona adentro de la casa');
    await expect(fila).toContainText('180 m del paciente · precisión ±40 m');

    await fila.getByTestId('presence-approve').click();
    const confirmar = page.getByTestId('presence-dialog-confirm');
    await expect(confirmar).toBeDisabled();                    // sem código, não confirma
    await page.getByLabel('GPS adentro, confirmado').click();
    await expect(confirmar).toBeEnabled();
    await confirmar.click();

    await expect(page.getByTestId('presence-dialog')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('presence-row').filter({ hasText: label(aprovada.onDate) })).toHaveCount(0); // relida do attendance
    await expect(page.getByTestId('presence-row').filter({ hasText: label(recusada.onDate) })).toHaveCount(1); // as outras seguem
    expect(decisionOf(seed.titularWorkerId, aprovada.eventId)).toBe(`APPROVED|INDOOR_CONFIRMED|${COORD.uid}`);
  });

  test('alternativo 1: rechazar com código — a ocorrência sai das horas do mês (lido pela API de horas)', async ({ page }) => {
    const mes = recusada.onDate.slice(0, 7);
    expect(minutosAntes.workedMinutes).toBeGreaterThanOrEqual(120); // controle positivo: a ocorrência contava antes
    await loginAs(page, COORD);
    await page.locator(`a[href="${REVISION}"]`).first().click();

    const fila = page.getByTestId('presence-row').filter({ hasText: label(recusada.onDate) });
    await fila.getByTestId('presence-reject').click();
    await expect(page.getByRole('heading', { name: 'Rechazar excepción de lugar' })).toBeVisible();
    await page.getByLabel('No estaba con el paciente').click();
    await page.getByTestId('presence-dialog-confirm').click();
    await expect(page.getByTestId('presence-dialog')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('presence-row').filter({ hasText: label(recusada.onDate) })).toHaveCount(0);

    expect(decisionOf(seed.titularWorkerId, recusada.eventId)).toBe(`REFUSED|NOT_AT_PATIENT|${COORD.uid}`);
    const depois = await readMonthHours(mes, seed.titularWorkerId);
    expect(depois.workedMinutes).toBe(minutosAntes.workedMinutes - 120);
    expect(depois.shifts).toBe(minutosAntes.shifts - 1);
  });

  test('alternativo 2: sem a célula vê "Sin acceso" e as rotas respondem 403 (nada é gravado)', async ({ page }) => {
    await loginAs(page, SEM);
    await expect(page.locator(`a[href="${REVISION}"]`)).toHaveCount(0);
    await page.goto(REVISION);
    await expect(page.getByTestId('presence-no-access')).toContainText('Sin acceso', { timeout: 20_000 });
    await expect(page.getByTestId('presence-review-page')).toHaveCount(0);
    await expect(page.getByTestId('presence-row')).toHaveCount(0);

    const leitura = await api(SEM, 'GET', '/api/admin/presence/review-queue');
    expect(leitura.status).toBe(403);
    expect(JSON.stringify(await leitura.json())).not.toContain(NOME_PRESTADOR); // 403 sem enriquecimento
    const decisao = await api(SEM, 'POST', `/api/admin/presence/exceptions/${intocada.eventId}/decision`, { decision: 'APPROVED', resolution_code: 'INDOOR_CONFIRMED' });
    expect(decisao.status).toBe(403);
    expect(decisionOf(seed.titularWorkerId, intocada.eventId)).toBe('');
    // controle positivo: quem tem a célula lê (200) — o 403 acima é da célula, não de uma rota quebrada
    expect((await api(COORD, 'GET', '/api/admin/presence/review-queue')).status).toBe(200);
  });
});
