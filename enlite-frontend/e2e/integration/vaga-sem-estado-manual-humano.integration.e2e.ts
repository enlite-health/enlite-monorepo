/**
 * vaga-sem-estado-manual-humano.integration.e2e.ts @integration — change semaforo-da-vaga, F4 (front): ninguém escolhe estado para a vaga.
 *
 * E2E DE TELA, sem mock de resposta (nenhum `page.route` de dado; o único swap é o token do `loginAs`, e o `/generate-ai-content` do
 * wizard — IA custa — que vem do helper do lançamento): frontend + API + Postgres reais, engine OFF, clique e teclado de humano, valor lido
 * do DOM. SQL só MONTA o cenário. Nada aqui toca canal real: a vaga do foguete nasce rascunho (sem Talentum), a vaga de SQL não tem projeto
 * Talentum nem short link, e o `PUT` do wizard não passa por publish.
 *
 *  FELIZ — a lista e a ficha da vaga NÃO têm seletor de estado nem selo "Abierta": mostram o estado do PACIENTE (pílula) e, na lista, o
 *          semáforo. O paciente muda no banco e a vaga acompanha ao recarregar, sem escrita nela.
 *  ALT 1 — o wizard (edição do rascunho do foguete) não tem campo de estado, e o PUT do "Continuar" NÃO leva `status`
 *          (mandar dá 400 `VACANCY_STATUS_NOT_WRITABLE`): 200, banco intacto.
 *  ALT 2 — "Dar de baja" numa vaga sem serviço (clique na ficha) mostra o selo "Dada de baja"; a vaga some da lista (busca digitada)
 *          até marcar "Mostrar dadas de baja", e aí volta com o selo.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import {
  LANCAMENTO_VIEWPORT_ES_AR, mockAdminUserFor, useLancamentoStaff, loginAndMockAi, seedLaunchablePatient, type SeedLaunchablePatientResult,
} from '../helpers/lancamento-e2e-helper';
import { activateRecruitmentViaApi } from '../helpers/itinerario-e2e-helper';

const RUN = Date.now();
const CASE = 947600 + (RUN % 300);
const STAFF = mockAdminUserFor('vaga-sem-estado');

interface Seed {
  patientId: string;
  vNoAr: string;
  vLivre: string;
}
let S: Seed;
let foguete: SeedLaunchablePatientResult | null = null;
let vagaRascunho = '';

/** Vaga publicada por SQL (a linha de hoje). `is_test=false`: a lista esconde vaga de teste. Sem projeto Talentum nem short link. */
function vaga(patientId: string, o: { title: string; ordinal: number }): string {
  return scalar(`INSERT INTO job_postings (vacancy_number, case_number, title, description, patient_id, case_ordinal, required_professions, status,
      is_draft, is_test, country, social_short_links, created_at, updated_at)
    VALUES (nextval('job_postings_vacancy_number_seq'), ${CASE}, '${o.title}', '', '${patientId}', ${o.ordinal}, ARRAY['AT']::varchar[], 'SEARCHING',
      false, false, 'AR', '{}'::jsonb, NOW(), NOW()) RETURNING id`);
}

/** SQL pelo `docker exec` do stack (mesmo caminho do job padrão do CI — nada de Postgres do ABAC). */
const scalar = (sql: string): string => runSQL(sql).split('\n')[0].trim(); // INSERT ... RETURNING devolve também a linha "INSERT 0 1"
const safeSql = (sql: string): void => { runSQL(sql); };

const estado = (id: string): string => scalar(`SELECT status FROM job_postings WHERE id = '${id}'`);

/** Abre a lista e estreita pelo número do caso digitando na busca (gesto humano: clique + teclado). */
async function abrirLista(page: Page): Promise<void> {
  await page.goto('/admin/vacancies');
  await expect(page.getByTestId('vacancies-col-case')).toBeVisible({ timeout: 20_000 });
  const busca = page.getByPlaceholder(/^Buscar por/);
  await busca.click();
  await expect(busca).toBeFocused();
  await page.keyboard.type(String(CASE));
}

test.use({ video: 'on' });

test.describe('vaga sem estado manual — ficha, wizard e baixa (F4) @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, viewport: { width: 1600, height: 1000 } });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Vaga Sem Estado');

  test.beforeAll(async ({ request }) => {
    test.setTimeout(120_000);
    const { patientId } = insertTestPatient({
      status: 'SEARCHING', firstName: 'SemEstado', lastName: `E2E${RUN} QA`, diagnosis: 'sin dato QA', withAddress: true,
    });
    safeSql(`UPDATE patients SET case_number = ${CASE} WHERE id = '${patientId}'`);
    S = {
      patientId,
      vNoAr: vaga(patientId, { title: `SE no ar ${RUN}`, ordinal: 1 }),
      vLivre: vaga(patientId, { title: `SE livre ${RUN}`, ordinal: 2 }),
    };
    // o rascunho do foguete (vaga de serviço), para o wizard: paciente + serviço + `activate-recruitment` reais (sem Talentum)
    foguete = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -53.91, lng: -67.91 });
    vagaRascunho = await activateRecruitmentViaApi(request, foguete.patientId, foguete.serviceId);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM job_posting_audit_log WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id = '${S.patientId}')`);
    safeSql(`DELETE FROM job_postings WHERE patient_id = '${S.patientId}'`);
    cleanupTestPatient(S.patientId);
    foguete?.cleanup();
  });

  test('FELIZ — a lista e a ficha não têm seletor de estado nem "Abierta": mostram o estado do paciente (e, na lista, o semáforo)', async ({ page }) => {
    await loginAs(page, STAFF);
    await abrirLista(page);
    const fila = page.getByTestId(`vacancy-row-${S.vNoAr}`);
    await expect(fila).toBeVisible({ timeout: 15_000 });

    // lido da TELA: o estado do paciente e o semáforo; nenhum selo de estado da vaga
    await expect(fila.getByTestId('patient-status-pill')).toHaveText('Búsqueda');
    await expect(fila.getByTestId('vacancy-lifecycle-badge')).toHaveCount(0);
    await expect(fila.getByText('Abierta', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId(`vacancies-row-${S.vNoAr}-semaphore`).getByTestId('vacancy-semaphore-dot')).toHaveAttribute('data-color', 'red');
    await expect(page.getByTestId('vacancy-filter-lifecycle')).toHaveCount(0); // o filtro de ciclo de vida saiu
    await expect(page.getByTestId('vacancies-table-region')).toHaveScreenshot('vaga-sem-estado-lista.png', { maxDiffPixelRatio: 0.05 });

    // a ficha: estado do paciente, sem seletor
    await fila.click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${S.vNoAr}`), { timeout: 15_000 });
    const card = page.getByTestId('vacancy-case-card');
    await expect(card.getByTestId('patient-status-pill')).toHaveText('Búsqueda', { timeout: 15_000 });
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-status-editor-dropdown')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Reanudar/ })).toHaveCount(0);
    await expect(card.getByTestId('vacancy-lifecycle-badge')).toHaveCount(0);
    await expect(card).toHaveScreenshot('vaga-sem-estado-ficha.png', { maxDiffPixelRatio: 0.05 });

    // o paciente muda (a derivação/o foguete são do paciente): a vaga acompanha SEM escrita nela
    const antes = scalar(`SELECT updated_at FROM job_postings WHERE id = '${S.vNoAr}'`);
    safeSql(`UPDATE patients SET status = 'REPLACEMENT' WHERE id = '${S.patientId}'`);
    await page.reload();
    await expect(page.getByTestId('vacancy-case-card').getByTestId('patient-status-pill')).toHaveText('Reemplazos', { timeout: 15_000 });
    expect(scalar(`SELECT updated_at FROM job_postings WHERE id = '${S.vNoAr}'`)).toBe(antes);
    expect(estado(S.vNoAr)).toBe('SEARCHING');
    safeSql(`UPDATE patients SET status = 'SEARCHING' WHERE id = '${S.patientId}'`);
  });

  test('ALT 1 — o wizard não tem campo de estado, e o PUT do "Continuar" não leva `status` (200, banco intacto)', async ({ page }) => {
    await loginAndMockAi(page, STAFF);
    await page.goto(`/admin/vacancies/${vagaRascunho}/edit`);
    const salvar = page.getByTestId('create-vacancy-save-btn');
    await expect(salvar).toBeEnabled({ timeout: 20_000 });

    // nenhum campo de estado no formulário
    await expect(page.getByTestId('status-select')).toHaveCount(0);
    await expect(page.getByText('Seleccionar...', { exact: true })).toHaveCount(0);
    await expect(page).toHaveScreenshot('vaga-sem-estado-wizard.png', { maxDiffPixelRatio: 0.05, fullPage: false });

    const statusAntes = estado(vagaRascunho);
    let corpo: Record<string, unknown> | null | undefined;
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes(`/api/admin/vacancies/${vagaRascunho}`) && !req.url().includes('/talentum')) {
        try { corpo = JSON.parse(req.postData() ?? '{}'); } catch { corpo = null; }
      }
    });
    const put = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/admin/vacancies/${vagaRascunho}`, { timeout: 30_000 });
    await salvar.click();
    const resposta = await put;

    expect(resposta.status()).toBe(200);
    expect(corpo, 'nenhum PUT capturado').not.toBeUndefined();
    expect(corpo, 'corpo do PUT não era JSON').not.toBeNull();
    expect(Object.keys(corpo ?? {})).not.toContain('status');
    expect(estado(vagaRascunho)).toBe(statusAntes); // o servidor não tocou no estado
  });

  test('ALT 2 — "Dar de baja" numa vaga sem serviço mostra o selo "Dada de baja"; some da lista até marcar "Mostrar dadas de baja"', async ({ page }) => {
    await loginAs(page, STAFF);
    await page.goto(`/admin/vacancies/${S.vLivre}`);
    await expect(page.getByTestId('vacancy-case-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('vacancy-lifecycle-badge')).toHaveCount(0); // no ar: sem selo
    await page.getByTestId('vacancy-baja-button').click();
    await expect(page.getByTestId('vacancy-baja-confirm')).toBeVisible();
    await page.getByTestId('vacancy-baja-confirm-ok').click();

    await expect(page.getByTestId('vacancy-de-baja-banner')).toContainText('solo consulta', { timeout: 15_000 });
    await expect(page.getByTestId('vacancy-case-card').getByTestId('vacancy-lifecycle-badge')).toHaveText('Dada de baja');
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toHaveCount(0);
    expect(estado(S.vLivre)).toBe('DE_BAJA');
    await expect(page.getByTestId('vacancy-case-card')).toHaveScreenshot('vaga-sem-estado-baja-ficha.png', { maxDiffPixelRatio: 0.05 });

    // a lista: a baixada some (busca digitada) até ligar o filtro com o clique no rótulo
    await abrirLista(page);
    await expect(page.getByTestId(`vacancy-row-${S.vNoAr}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`vacancy-row-${S.vLivre}`)).toHaveCount(0);
    await page.getByText('Mostrar dadas de baja', { exact: true }).click();
    const fila = page.getByTestId(`vacancy-row-${S.vLivre}`);
    await expect(fila).toBeVisible({ timeout: 15_000 });
    await expect(fila.getByTestId('vacancy-lifecycle-badge')).toHaveText('Dada de baja');
    await expect(page.getByTestId('vacancies-table-region')).toHaveScreenshot('vaga-sem-estado-lista-baja.png', { maxDiffPixelRatio: 0.05 });
  });
});
