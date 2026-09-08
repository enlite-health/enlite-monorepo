/**
 * Spec 017 — as telas de catálogo do projeto terapêutico (D299.3: uma tela e uma célula por lista),
 * exercitadas por um HUMANO contra o stack REAL (frontend + API + Postgres + emulador), zero mock.
 * Régua humana (memória `e2e-humano-nao-e-fill`): click + `keyboard.type` + valor lido da TELA.
 *
 * O que se prova (na tela de objetivos específicos; as três telas são o MESMO componente por `kind`,
 * e a rota de cada uma é conferida por título):
 *   1. a rota `/admin/catalogos/objetivos-especificos` existe (App.tsx) e lista o seed da migration 415
 *      (8 opções ativas, ordem por `sort_order`);
 *   2. caminho feliz: "Nueva opción" → digita o texto → Guardar → a linha aparece na tabela E existe no banco;
 *   3. caminho alternativo: o MESMO texto de novo → 409 do servidor, a frase da tela, o banco não ganha linha;
 *   4. caminho alternativo: desativar pela tela → a linha fica "Inactiva", o banco tem `active=false`,
 *      e o formulário do projeto deixa de oferecer a opção (contagem do listbox);
 *   5. as outras duas rotas abrem com o próprio título;
 *   6. foto da tabela e da modal com a recusa (`toHaveScreenshot`).
 */
import { test, expect } from '@playwright/test';
import { runSQL } from '../helpers/patient-detail-c-helper';
import { loginComoHumano } from '../helpers/login-humano';

const STAFF_EMAIL = `e2e.cat.${Date.now()}@enlite.health`;
const STAMP = Date.now().toString(36);
const LABEL = `Objetivo e2e ${STAMP}`;


function ativos(): number {
  return Number(runSQL(`SELECT count(*) FROM therapeutic_specific_objectives WHERE active`));
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('spec 017 — catálogo do projeto terapêutico: um HUMANO lista, cria, esbarra no duplicado e desativa @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let seedAtivos: number;
  let novoId: string;

  test.beforeAll(() => {
    seedAtivos = ativos();
    expect(seedAtivos).toBeGreaterThanOrEqual(8); // o seed da 415; outra suíte pode ter deixado mais
  });
  test.afterAll(() => {
    runSQL(`DELETE FROM therapeutic_specific_objectives WHERE label = '${LABEL}'`);
  });

  test('a rota existe, lista o seed, cria pela tela (banco confirma) e recusa o duplicado (409 na tela, banco intacto)', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Catalogo');
    await page.goto('/admin/catalogos/objetivos-especificos');
    await expect(page.getByRole('heading', { name: 'Objetivos específicos del proyecto terapéutico' })).toBeVisible({ timeout: 30_000 });
    const table = page.getByTestId('therapeutic-catalog-table');
    await expect(table).toBeVisible();
    // A tela lista TODAS (ativas e inativas); o formulário do projeto, só as ativas.
    await expect(table.locator('[data-testid^="therapeutic-catalog-row-"]')).toHaveCount(Number(runSQL(`SELECT count(*) FROM therapeutic_specific_objectives`)));
    // O primeiro do seed é o primeiro da tabela (ORDER BY active DESC, sort_order, lower(label)).
    const primeiroSeed = runSQL(`SELECT label FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order, lower(label) LIMIT 1`).split('\n')[0].trim();
    await expect(table.locator('[data-testid^="therapeutic-catalog-label-"]').first()).toHaveText(primeiroSeed);

    // ── Caminho feliz: Nueva opción ─────────────────────────────────────────────────────────
    await page.getByTestId('therapeutic-catalog-new-btn').click();
    const modal = page.getByTestId('therapeutic-catalog-form-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('therapeutic-catalog-form-save')).toBeDisabled();
    const input = page.getByTestId('therapeutic-catalog-label-input');
    await input.click();
    await expect(input).toBeFocused();
    await page.keyboard.type(LABEL);
    expect(await input.inputValue()).toBe(LABEL);
    await expect(page.getByTestId('therapeutic-catalog-label-count')).toContainText(`${LABEL.length}`);
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-catalogs\/specific-objectives$/.test(r.url()));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    const body = (await (await created).json()) as { data: { id: string; label: string; active: boolean } };
    expect(body.data.label).toBe(LABEL);
    expect(body.data.active).toBe(true);
    novoId = body.data.id;
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId(`therapeutic-catalog-label-${novoId}`)).toHaveText(LABEL);
    await expect(page.getByTestId(`therapeutic-catalog-status-${novoId}`)).toContainText('Activa');
    expect(ativos()).toBe(seedAtivos + 1);
    expect(runSQL(`SELECT created_by = 'seed:415' FROM therapeutic_specific_objectives WHERE id = '${novoId}'`).trim()).toBe('f'); // autor real, não o seed
    await expect(table).toHaveScreenshot('catalogo-objetivos-com-novo.png', {
      mask: [page.getByTestId(`therapeutic-catalog-row-${novoId}`)],
      maxDiffPixelRatio: 0.02,
    });

    // ── Caminho alternativo: o MESMO texto (caixa e espaços diferentes) → 409 ───────────────
    await page.getByTestId('therapeutic-catalog-new-btn').click();
    await expect(modal).toBeVisible();
    await page.getByTestId('therapeutic-catalog-label-input').click();
    await page.keyboard.type(`  ${LABEL.toUpperCase()}  `);
    const recusa = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-catalogs\/specific-objectives$/.test(r.url()));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    expect((await recusa).status()).toBe(409);
    await expect(page.getByTestId('therapeutic-catalog-form-error')).toContainText('Ya existe una opción activa con ese texto');
    await expect(modal).toBeVisible(); // segue aberta para o humano corrigir
    // Máscara no que muda a cada rodada (o texto carimbado, na linha e no campo) e no aviso do emulador.
    await expect(modal).toHaveScreenshot('catalogo-modal-duplicado.png', {
      mask: [page.getByTestId('therapeutic-catalog-label-input'), page.getByTestId(`therapeutic-catalog-row-${novoId}`), page.locator('.firebase-emulator-warning')],
      maxDiffPixelRatio: 0.02,
    });
    await page.getByTestId('therapeutic-catalog-form-close').click();
    await expect(modal).toHaveCount(0);
    expect(ativos()).toBe(seedAtivos + 1);
    expect(Number(runSQL(`SELECT count(*) FROM therapeutic_specific_objectives WHERE lower(btrim(label)) = lower('${LABEL}')`))).toBe(1);
  });

  test('caminho alternativo: desativar pela tela → "Inactiva", banco com active=false, e o formulário do projeto deixa de oferecer a opção', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Catalogo');
    await page.goto('/admin/catalogos/objetivos-especificos');
    await expect(page.getByTestId(`therapeutic-catalog-status-${novoId}`)).toContainText('Activa', { timeout: 30_000 });
    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/therapeutic-catalogs/specific-objectives/${novoId}`));
    await page.getByTestId(`therapeutic-catalog-toggle-${novoId}`).click();
    expect((await patched).status()).toBe(200);
    await expect(page.getByTestId(`therapeutic-catalog-status-${novoId}`)).toContainText('Inactiva');
    expect(runSQL(`SELECT active::text || ',' || (deactivated_at IS NOT NULL)::text FROM therapeutic_specific_objectives WHERE id = '${novoId}'`).trim()).toBe('false,true');
    expect(ativos()).toBe(seedAtivos);

    // A lista que o FORMULÁRIO do projeto consome (GET sem `includeInactive`) não traz mais a opção; a
    // da tela (com `includeInactive=true`) traz. Mesmo token do humano logado, lido da request da própria tela.
    const req = page.waitForRequest((r) => r.method() === 'GET' && r.url().includes('/therapeutic-catalogs/specific-objectives'));
    await page.reload();
    const viva = await req;
    const authorization = viva.headers()['authorization'];
    expect(authorization).toMatch(/^Bearer /);
    const base = viva.url().split('/api/admin/')[0];
    const doForm = await page.request.get(`${base}/api/admin/therapeutic-catalogs/specific-objectives`, { headers: { authorization } });
    expect(doForm.status()).toBe(200);
    const idsForm = ((await doForm.json()) as { data: { items: { id: string }[] } }).data.items.map((i) => i.id);
    expect(idsForm).not.toContain(novoId);
    expect(idsForm).toHaveLength(seedAtivos);
    const daTela = await page.request.get(`${base}/api/admin/therapeutic-catalogs/specific-objectives?includeInactive=true`, { headers: { authorization } });
    expect(((await daTela.json()) as { data: { items: { id: string }[] } }).data.items.map((i) => i.id)).toContain(novoId);
  });

  test('as outras duas rotas abrem com o próprio título (mesmo componente, `kind` diferente)', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Catalogo');
    await page.goto('/admin/catalogos/actividades');
    await expect(page.getByRole('heading', { name: 'Rutina y actividades del proyecto terapéutico' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('therapeutic-catalog-table').locator('[data-testid^="therapeutic-catalog-row-"]')).toHaveCount(Number(runSQL(`SELECT count(*) FROM therapeutic_activities`)));
    await page.goto('/admin/catalogos/tipos-de-patologia');
    await expect(page.getByRole('heading', { name: 'Tipos de patología (segmento)' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('therapeutic-catalog-table').locator('[data-testid^="therapeutic-catalog-row-"]')).toHaveCount(Number(runSQL(`SELECT count(*) FROM pathology_types`)));
    await expect(page.getByTestId('therapeutic-catalog-table')).not.toContainText('ICHOM');
  });
});
