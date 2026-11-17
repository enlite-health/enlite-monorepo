/**
 * Spec 091 (CA-13, §9.7/§9.11) — vínculos de CIE-11 nas telas de catálogo do admin, exercitados por um HUMANO contra o stack
 * REAL (frontend + API + Postgres), zero interceptação de dado na rede. Régua humana (memória `e2e-humano-nao-e-fill`): click +
 * `keyboard.type` + valor lido da TELA; o banco confirma depois.
 *
 * Dado: o catálogo da planilha (587) já está no banco. A terminologia é semeada por SQL com um release de teste promovido como
 * CORRENTE (sob o advisory lock 9100221 — o mesmo de `travarReleaseCorrente` do back — para não colidir com outro e2e):
 *   · `6A02`/`6A03` = categorias que EXISTEM na planilha (conferido com `jq` no `catalogo-cid.normalizado.json`);
 *   · `ZE91` = stem ausente do JSON (candidato a "Agregar" que nenhum catálogo usa);
 *   · `6A05` está na planilha mas NÃO no release de teste → a linha mostra "No está en la versión CIE-11 vigente".
 * O objetivo e a atividade do teste (prefixo `E2E091`) são semeados por SQL e apagados ao fim.
 *
 *   1. feliz: filtra objetivos por `6A02`, abre o painel pelo chip, busca local, adiciona `ZE91` (busca no catálogo CIE-11),
 *      remove com a confirmação da cascata ("Se quitarán también 1 vínculos de actividades");
 *   2. alt 1: na atividade, "Agregar" só oferece as categorias do objetivo ainda não ligadas;
 *   3. alt 2: `/admin/catalogos/segmentos` não abre a tela e o menu não tem "Segmentos".
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { runSQL } from '../helpers/patient-detail-c-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';

const STAMP = Date.now().toString(36);
const STAFF_EMAIL = `e2e.cid091.${Date.now()}@enlite.health`;
const STAFF: MockUser = { uid: `e2e-cid091-${Date.now()}`, email: STAFF_EMAIL, role: 'admin', country: 'AR' };
const PREFIXO = 'E2E091 ';
const RELEASE = 'E2E091-FIX';
const LOCK_RELEASE_CORRENTE = 9100221; // mesma chave de `travarReleaseCorrente` (worker-functions/tests/e2e/helpers/ptiCatalogoCidSeed.ts)
const OBJETIVO = `${PREFIXO}objetivo ${STAMP}`;
const ATIVIDADE = `${PREFIXO}actividad ${STAMP}`;
const CAT_NA_PLANILHA = '6A02';
const CAT_NA_PLANILHA_2 = '6A03';
const CAT_FORA_DO_RELEASE = '6A05';
const CAT_FORA_DA_PLANILHA = 'ZE91';

async function entrar(page: Page): Promise<void> {
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${STAFF.uid}', '${STAFF.email}', 'E2E Cid091', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await loginComoStaffMock(page, STAFF, 'E2E Cid091');
}

/** Advisory lock de sessão numa conexão dedicada (processo `psql` aberto): fechar o processo solta o lock. Falha ALTO após 20 s. */
function travarReleaseCorrente(): Promise<() => void> {
  const container = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
  const proc: ChildProcessWithoutNullStreams = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'enlite_admin', '-d', 'enlite_e2e', '-tA', '-v', 'ON_ERROR_STOP=1']);
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`release CID corrente ocupado por outro e2e (lock ${LOCK_RELEASE_CORRENTE})`)); }, 25_000);
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('TRAVADO')) { clearTimeout(timer); resolve(() => { proc.kill(); }); }
    });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('exit', (code) => { if (!out.includes('TRAVADO')) { clearTimeout(timer); reject(new Error(`psql do lock saiu (${code}): ${err}`)); } });
    proc.stdin.write(`SET lock_timeout = '20s'; SELECT pg_advisory_lock(${LOCK_RELEASE_CORRENTE}); SELECT 'TRAVADO';\n`);
  });
}

function sql(...stmts: string[]): void {
  for (const s of stmts) runSQL(s);
}

function limpar(): void {
  const objetivos = `(SELECT id FROM therapeutic_specific_objectives WHERE label LIKE '${PREFIXO}%')`;
  sql(
    `DELETE FROM therapeutic_activity_icd_categories WHERE objective_id IN ${objetivos}`,
    `DELETE FROM therapeutic_objective_icd_categories WHERE objective_id IN ${objetivos}`,
    `DELETE FROM therapeutic_activities WHERE label LIKE '${PREFIXO}%' OR objective_id IN ${objetivos}`,
    `DELETE FROM therapeutic_specific_objectives WHERE label LIKE '${PREFIXO}%'`,
  );
}

function restaurarRelease(anterior: string): void {
  sql(
    `UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE release = '${RELEASE}'`,
    ...(anterior ? [`UPDATE terminology.icd_releases SET is_current = true, promoted_at = now(), promoted_by = 'e2e091-restore' WHERE release = '${anterior}'`] : []),
    `DELETE FROM terminology.icd_entities WHERE release = '${RELEASE}'`,
    `DELETE FROM terminology.icd_releases WHERE release = '${RELEASE}'`,
  );
}

const vinculosObjetivo = (id: string): string =>
  runSQL(`SELECT string_agg(category_code, ',' ORDER BY category_code) FROM therapeutic_objective_icd_categories WHERE objective_id = '${id}'`);
const vinculosAtividade = (id: string): string =>
  runSQL(`SELECT coalesce(string_agg(category_code, ',' ORDER BY category_code), '') FROM therapeutic_activity_icd_categories WHERE activity_id = '${id}'`);

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe('spec 091 — vínculos CIE-11 no catálogo: um HUMANO filtra, abre o painel, adiciona e quita categorias @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let soltarLock: () => void = () => undefined;
  let releaseAnterior = '';
  let objetivoId = '';
  let atividadeId = '';

  test.beforeAll(async () => {
    soltarLock = await travarReleaseCorrente();
    try {
      limpar();
      restaurarRelease(''); // sobra de rodada interrompida (sem reativar nada)
      // Terminologia sintética: 1 capítulo + 3 stems. Os títulos são sintéticos (não são texto clínico de paciente).
      sql(
        `INSERT INTO terminology.icd_releases (release, entity_count) VALUES ('${RELEASE}', 4) ON CONFLICT (release) DO NOTHING`,
        `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf) VALUES
           ('test://e2e091/cap06', '${RELEASE}', '06', 'Capitulo sintetico 091', NULL, '06', NULL, 'chapter', false),
           ('test://e2e091/${CAT_NA_PLANILHA}', '${RELEASE}', '${CAT_NA_PLANILHA}', 'Categoria sintetica uno 091', NULL, '06', NULL, 'stem', true),
           ('test://e2e091/${CAT_NA_PLANILHA_2}', '${RELEASE}', '${CAT_NA_PLANILHA_2}', 'Categoria sintetica dos 091', NULL, '06', NULL, 'stem', true),
           ('test://e2e091/${CAT_FORA_DA_PLANILHA}', '${RELEASE}', '${CAT_FORA_DA_PLANILHA}', 'Categoria sintetica fuera de la planilla 091', NULL, '06', NULL, 'stem', true)`,
      );
      releaseAnterior = runSQL(`SELECT release FROM terminology.icd_releases WHERE is_current AND release <> '${RELEASE}' LIMIT 1`);
      sql(
        `UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current`,
        `UPDATE terminology.icd_releases SET is_current = true, promoted_at = now(), promoted_by = 'e2e091' WHERE release = '${RELEASE}'`,
      );
      objetivoId = runSQL(`INSERT INTO therapeutic_specific_objectives (label, service_code, created_by, updated_by) VALUES ('${OBJETIVO}', 'AT', 'e2e091', 'e2e091') RETURNING id`).split('\n')[0];
      atividadeId = runSQL(`INSERT INTO therapeutic_activities (label, objective_id, created_by, updated_by) VALUES ('${ATIVIDADE}', '${objetivoId}', 'e2e091', 'e2e091') RETURNING id`).split('\n')[0];
      for (const c of [CAT_NA_PLANILHA, CAT_NA_PLANILHA_2, CAT_FORA_DO_RELEASE]) {
        sql(`INSERT INTO therapeutic_objective_icd_categories (objective_id, category_code, created_by) VALUES ('${objetivoId}', '${c}', 'e2e091')`);
      }
      sql(`INSERT INTO therapeutic_activity_icd_categories (activity_id, objective_id, category_code, created_by) VALUES ('${atividadeId}', '${objetivoId}', '${CAT_NA_PLANILHA}', 'e2e091')`);
      // controle de não-vacuidade: o catálogo da planilha está no banco e a categoria escolhida existe nele
      expect(Number(runSQL(`SELECT count(DISTINCT objective_id) FROM therapeutic_objective_icd_categories WHERE category_code = '${CAT_NA_PLANILHA}' AND objective_id <> '${objetivoId}'`))).toBeGreaterThan(0);
    } catch (e) {
      soltarLock();
      throw e;
    }
  });

  test.afterAll(() => {
    try {
      limpar();
      restaurarRelease(releaseAnterior);
      runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
    } finally {
      soltarLock();
    }
  });

  test('feliz: filtra objetivos por 6A02, abre o painel, busca, adiciona ZE91 e quita com a confirmação da cascata', async ({ page }) => {
    await entrar(page);
    await page.goto('/admin/catalogos/objetivos-especificos');
    await expect(page.getByRole('heading', { name: 'Objetivos específicos del proyecto terapéutico' })).toBeVisible({ timeout: 30_000 });
    const table = page.getByTestId('therapeutic-catalog-table');
    await expect(table).toBeVisible();
    // A coluna CIE-11 existe e a de Segmento não.
    await expect(page.getByRole('columnheader', { name: 'CIE-11' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Servicio' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Segmento/ })).toHaveCount(0);
    const linhas = table.locator('[data-testid^="therapeutic-catalog-row-"]');
    const todas = Number(runSQL(`SELECT count(*) FROM therapeutic_specific_objectives`));
    await expect(linhas).toHaveCount(todas);

    // ── filtro por categoria: digita o código como um humano; a lista passa a ser só quem tem o vínculo ──
    const filtro = page.getByTestId('therapeutic-catalog-filter-icd');
    await filtro.click();
    await expect(filtro).toBeFocused();
    await page.keyboard.type(CAT_NA_PLANILHA);
    expect(await filtro.inputValue()).toBe(CAT_NA_PLANILHA);
    const comVinculo = Number(runSQL(`SELECT count(DISTINCT objective_id) FROM therapeutic_objective_icd_categories WHERE category_code = '${CAT_NA_PLANILHA}'`));
    expect(comVinculo).toBeGreaterThan(1);
    await expect(linhas).toHaveCount(comVinculo, { timeout: 20_000 });
    await expect(page.getByTestId(`therapeutic-catalog-label-${objetivoId}`)).toHaveText(OBJETIVO);
    await expect(page.getByTestId(`therapeutic-catalog-service-${objetivoId}`)).toHaveText('Acompañante terapéutico');
    const chip = page.getByTestId(`therapeutic-catalog-icd-${objetivoId}`);
    await expect(chip).toHaveText('3 categorías');

    // ── painel: contagem, linhas "código — título" e a frase de categoria fora do release ──
    await chip.click();
    const painel = page.getByTestId('therapeutic-catalog-cid-panel');
    await expect(painel).toBeVisible();
    await expect(painel.getByTestId('cid-panel-count')).toHaveText('3 categorías');
    await expect(painel.getByTestId(`cid-panel-row-${CAT_NA_PLANILHA}`)).toHaveText(new RegExp(`^${CAT_NA_PLANILHA} — Categoria sintetica uno 091`));
    await expect(painel.getByTestId(`cid-panel-row-${CAT_FORA_DO_RELEASE}`)).toContainText('No está en la versión CIE-11 vigente');

    // busca local: por código e depois por título
    const buscaLocal = painel.getByTestId('cid-panel-filter');
    await buscaLocal.click();
    await expect(buscaLocal).toBeFocused();
    await page.keyboard.type(CAT_FORA_DO_RELEASE);
    await expect(painel.locator('[data-testid^="cid-panel-row-"]')).toHaveCount(1);
    await expect(painel.getByTestId(`cid-panel-row-${CAT_FORA_DO_RELEASE}`)).toBeVisible();
    await buscaLocal.press('ControlOrMeta+a');
    await page.keyboard.type('dos 091');
    await expect(painel.locator('[data-testid^="cid-panel-row-"]')).toHaveCount(1);
    await expect(painel.getByTestId(`cid-panel-row-${CAT_NA_PLANILHA_2}`)).toBeVisible();
    await buscaLocal.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await expect(painel.locator('[data-testid^="cid-panel-row-"]')).toHaveCount(3);

    // ── Agregar: busca no catálogo CIE-11 (stem fora da planilha) e clica "Agregar" ──
    const busca = painel.getByTestId('cid-panel-add-search');
    await busca.click();
    await expect(busca).toBeFocused();
    await page.keyboard.type(CAT_FORA_DA_PLANILHA);
    const candidato = painel.getByTestId(`cid-panel-candidate-${CAT_FORA_DA_PLANILHA}`);
    await expect(candidato).toContainText('Categoria sintetica fuera de la planilla 091');
    const adicionou = page.waitForResponse((r) => r.request().method() === 'POST' && /therapeutic-catalogs\/specific-objectives\/.+\/categories/.test(r.url()));
    await painel.getByTestId(`cid-panel-add-${CAT_FORA_DA_PLANILHA}`).click();
    expect((await adicionou).status()).toBeLessThan(300);
    await expect(painel.getByTestId('cid-panel-count')).toHaveText('4 categorías');
    await expect(painel.getByTestId(`cid-panel-row-${CAT_FORA_DA_PLANILHA}`)).toBeVisible();
    expect(vinculosObjetivo(objetivoId)).toBe(`${CAT_NA_PLANILHA},${CAT_NA_PLANILHA_2},${CAT_FORA_DO_RELEASE},${CAT_FORA_DA_PLANILHA}`);

    // ── Quitar com cascata: a atividade passa a usar ZE91 (SQL) e o painel recarrega com a contagem de vínculos ──
    sql(`INSERT INTO therapeutic_activity_icd_categories (activity_id, objective_id, category_code, created_by) VALUES ('${atividadeId}', '${objetivoId}', '${CAT_FORA_DA_PLANILHA}', 'e2e091')`);
    await page.getByTestId('therapeutic-catalog-cid-panel-close-btn').click();
    await expect(painel).toHaveCount(0);
    await chip.click();
    await expect(painel.getByTestId('cid-panel-count')).toHaveText('4 categorías');
    await painel.getByTestId(`cid-panel-remove-${CAT_FORA_DA_PLANILHA}`).click();
    await expect(painel.getByTestId('cid-panel-confirm')).toContainText('Se quitarán también 1 vínculos de actividades');
    expect(vinculosObjetivo(objetivoId)).toContain(CAT_FORA_DA_PLANILHA); // nada some antes de confirmar
    const quitou = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/categories/'));
    await painel.getByTestId('cid-panel-confirm-yes').click();
    expect((await quitou).status()).toBeLessThan(300);
    await expect(painel.getByTestId('cid-panel-count')).toHaveText('3 categorías');
    await expect(painel.getByTestId(`cid-panel-row-${CAT_FORA_DA_PLANILHA}`)).toHaveCount(0);
    expect(vinculosObjetivo(objetivoId)).toBe(`${CAT_NA_PLANILHA},${CAT_NA_PLANILHA_2},${CAT_FORA_DO_RELEASE}`);
    expect(vinculosAtividade(atividadeId)).toBe(CAT_NA_PLANILHA); // a cascata levou o vínculo da atividade com ZE91
    await page.getByTestId('therapeutic-catalog-cid-panel-close-btn').click();
    await expect(chip).toHaveText('3 categorías');
  });

  test('alt 1: na atividade, "Agregar" só oferece as categorias do objetivo ainda não ligadas', async ({ page }) => {
    await entrar(page);
    await page.goto('/admin/catalogos/actividades');
    await expect(page.getByRole('heading', { name: 'Rutina y actividades del proyecto terapéutico' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('columnheader', { name: 'Objetivo' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Frecuencia sugerida' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'CIE-11' })).toBeVisible();
    const filtro = page.getByTestId('therapeutic-catalog-filter-icd');
    await filtro.click();
    await expect(filtro).toBeFocused();
    await page.keyboard.type(CAT_NA_PLANILHA);
    const chip = page.getByTestId(`therapeutic-catalog-icd-${atividadeId}`);
    await expect(chip).toHaveText('1 categorías', { timeout: 20_000 });
    await expect(page.getByTestId(`therapeutic-catalog-objective-${atividadeId}`)).toHaveText(OBJETIVO);
    await chip.click();
    const painel = page.getByTestId('therapeutic-catalog-cid-panel');
    await expect(painel).toBeVisible();
    await expect(painel.getByTestId(`cid-panel-row-${CAT_NA_PLANILHA}`)).toBeVisible();
    // sem campo de busca no catálogo: a atividade só escolhe entre as categorias do objetivo (ligadas ao objetivo: 6A02, 6A03, 6A05)
    await expect(painel.getByTestId('cid-panel-add-search')).toHaveCount(0);
    const select = painel.getByTestId('cid-panel-add-select');
    await expect(select.locator('option')).toHaveText([/^Agregar$/, new RegExp(`^${CAT_NA_PLANILHA_2} — Categoria sintetica dos 091`), new RegExp(`^${CAT_FORA_DO_RELEASE} —`)]);
    await expect(select.locator(`option[value="${CAT_NA_PLANILHA}"]`)).toHaveCount(0); // já ligada à atividade
    await expect(select.locator(`option[value="${CAT_FORA_DA_PLANILHA}"]`)).toHaveCount(0); // não é do objetivo
    const adicionou = page.waitForResponse((r) => r.request().method() === 'POST' && /therapeutic-catalogs\/activities\/.+\/categories/.test(r.url()));
    await select.selectOption(CAT_NA_PLANILHA_2);
    expect((await adicionou).status()).toBeLessThan(300);
    await expect(painel.getByTestId('cid-panel-count')).toHaveText('2 categorías');
    await expect(select.locator('option')).toHaveCount(2); // sobrou só a 6A05
    expect(vinculosAtividade(atividadeId)).toBe(`${CAT_NA_PLANILHA},${CAT_NA_PLANILHA_2}`);
    // atividade não tem cascata: "Quitar" remove direto
    const quitou = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/categories/'));
    await painel.getByTestId(`cid-panel-remove-${CAT_NA_PLANILHA_2}`).click();
    expect((await quitou).status()).toBeLessThan(300);
    await expect(painel.getByTestId('cid-panel-confirm')).toHaveCount(0);
    await expect(painel.getByTestId('cid-panel-count')).toHaveText('1 categorías');
    expect(vinculosAtividade(atividadeId)).toBe(CAT_NA_PLANILHA);
  });

  test('alt 2: /admin/catalogos/segmentos não abre a tela e o menu não tem "Segmentos"', async ({ page }) => {
    await entrar(page);
    await page.goto('/admin/catalogos/objetivos-especificos');
    await expect(page.getByRole('heading', { name: 'Objetivos específicos del proyecto terapéutico' })).toBeVisible({ timeout: 30_000 });
    // controle de não-vacuidade: o menu está montado e tem os irmãos
    await expect(page.getByRole('link', { name: 'Rutina y actividades' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Segmentos/ })).toHaveCount(0);
    await page.goto('/admin/catalogos/segmentos');
    // Rota inexistente cai no `path="*"` → raiz; a tela do catálogo não renderiza.
    await expect(page).not.toHaveURL(/catalogos\/segmentos/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /Segmentos/ })).toHaveCount(0);
    await expect(page.getByTestId('therapeutic-catalog-table')).toHaveCount(0);
  });
});
