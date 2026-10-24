/**
 * patient-itinerary-catalogo-motivos.integration.e2e.ts @integration — Fase 1 da change
 * itinerario-trocas-motivos-e-figma: a tela do catálogo de motivos de saída do serviço
 * (`/admin/catalogos/motivos-de-salida`), exercitada por um HUMANO contra o stack REAL
 * (frontend + API + Postgres), sem mock de dado de negócio — só a auth é o mock do stack
 * (token `mock_*` com `country`, molde `catalogo-terapeutico-humano` + `abac-stack-helper`).
 * Régua humana (memória `e2e-humano-nao-e-fill`): click + `keyboard.type` + valor lido da TELA;
 * nenhum preenchimento programático de campo. Entrada pelo MENU, não por `goto`.
 *
 * Os 3 testes (serial, um `describe`):
 *   1. FELIZ — abre pelo menu, vê a orientação "sem dado de saúde", cria "Cambio de disponibilidad",
 *      desativa "Otro"; a lista ATIVA da tela == `GET …/options` da mesma execução (contagem e rótulos);
 *   2. ALTERNATIVO 1 — criar um rótulo que já existe entre os ativos → 409, frase da tela, lista intacta;
 *   3. ALTERNATIVO 2 — rótulo com e-mail → 400, frase da tela, nada criado.
 *
 * Re-executável: antes e depois, remove o item criado (só o que o admin criou: `code = id::text`) e
 * REATIVA "Otro" (a carga inicial o traz ativo). Os 3 testes do arquivo entram no `--grep patient-itinerary`.
 */
import { test, expect, type Page } from '@playwright/test';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginAs, tokenFor, type MockUser } from '../helpers/abac-stack-helper';

const STAMP = Date.now().toString(36);
const ADMIN: MockUser = { uid: `e2e-motivos-${STAMP}`, email: `e2e.motivos.${STAMP}@enlite.test`, role: 'admin', country: 'AR' };

const NOVO = 'Cambio de disponibilidad';
const JA_EXISTE = 'Sin disponibilidad horaria';
const COM_EMAIL = `pessoa.${STAMP}@example.com`;
const TITULO = 'Motivos de salida';
const ORIENTACAO = 'Categorías genéricas, sin datos de salud.';
const MSG_DUPLICADO = 'Ya existe una opción activa con ese texto';
const MSG_INVALIDO = 'El texto no puede tener datos de una persona';

function total(): number {
  return Number(runSQL('SELECT count(*) FROM service_exit_reasons'));
}
function ativos(): number {
  return Number(runSQL('SELECT count(*) FROM service_exit_reasons WHERE active'));
}
function limpar(): void {
  // Só o que o admin criou (o trigger põe code = id::text); a carga inicial nunca é apagada.
  runSQL(`DELETE FROM service_exit_reasons WHERE code = id::text AND (label = '${NOVO}' OR label LIKE '%@%')`);
  runSQL(`UPDATE service_exit_reasons SET active = true, deactivated_at = NULL WHERE code = 'OTHER'`);
}

/** Entra pelo MENU: /admin → link "Motivos de salida" → a tela do catálogo. */
async function abrirPeloMenu(page: Page): Promise<void> {
  await loginAs(page, ADMIN);
  const link = page.getByRole('navigation').first().getByRole('link', { name: TITULO });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.click();
  await expect(page).toHaveURL(/\/admin\/catalogos\/motivos-de-salida$/);
  await expect(page.getByRole('heading', { level: 1, name: TITULO })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('therapeutic-catalog-table')).toBeVisible();
}

async function digitarEGuardar(page: Page, texto: string): Promise<void> {
  await page.getByTestId('therapeutic-catalog-new-btn').click();
  await expect(page.getByTestId('therapeutic-catalog-form-modal')).toBeVisible();
  const input = page.getByTestId('therapeutic-catalog-label-input');
  await input.click();
  await expect(input).toBeFocused();
  await page.keyboard.type(texto);
  expect(await input.inputValue()).toBe(texto);
}

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe('patient-itinerary — catálogo de motivos de saída: um HUMANO abre pelo menu, cria, desativa e esbarra nas recusas @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeAll(() => {
    limpar();
    expect(ativos(), 'a carga inicial traz os 4 motivos ativos').toBeGreaterThanOrEqual(4);
    // O login mock só entra se a conta existir em `users` como admin ativo (senão: "Acesso negado" na tela de login).
    runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified, status) VALUES ('${ADMIN.uid}', '${ADMIN.email}', 'E2E Motivos', 'admin', true, true, 'ACTIVE') ON CONFLICT (firebase_uid) DO NOTHING`);
  });
  test.afterAll(() => {
    limpar();
    runSQL(`DELETE FROM users WHERE firebase_uid = '${ADMIN.uid}'`);
  });

  test('FELIZ: menu → orientação → cria "Cambio de disponibilidad" → desativa "Otro"; a tela == GET …/options', async ({ page }) => {
    await abrirPeloMenu(page);
    await expect(page.getByTestId('catalog-guidance')).toHaveText(ORIENTACAO);
    const rows = page.locator('[data-testid^="therapeutic-catalog-row-"]');
    await expect(rows).toHaveCount(total());

    // ── cria ─────────────────────────────────────────────────────────────────────────────
    const antes = total();
    await digitarEGuardar(page, NOVO);
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-catalogs\/service-exit-reasons$/.test(r.url()));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    const body = (await (await created).json()) as { data: { id: string; code: string; label: string; active: boolean } };
    expect(body.data.label).toBe(NOVO);
    expect(body.data.active).toBe(true);
    expect(body.data.code, 'item do admin recebe code = id').toBe(body.data.id);
    await expect(page.getByTestId('therapeutic-catalog-form-modal')).toHaveCount(0);
    await expect(page.getByTestId(`therapeutic-catalog-label-${body.data.id}`)).toHaveText(NOVO);
    await expect(page.getByTestId(`therapeutic-catalog-status-${body.data.id}`)).toHaveText('Activa');
    expect(total()).toBe(antes + 1);

    // ── desativa "Otro" ──────────────────────────────────────────────────────────────────
    const otroId = runSQL(`SELECT id FROM service_exit_reasons WHERE code = 'OTHER'`).trim();
    await expect(page.getByTestId(`therapeutic-catalog-label-${otroId}`)).toHaveText('Otro');
    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/service-exit-reasons/${otroId}`));
    await page.getByTestId(`therapeutic-catalog-toggle-${otroId}`).click();
    expect((await patched).status()).toBe(200);
    await expect(page.getByTestId(`therapeutic-catalog-status-${otroId}`)).toHaveText('Inactiva');
    expect(runSQL(`SELECT active::text FROM service_exit_reasons WHERE code = 'OTHER'`).trim()).toBe('false');

    // ── a lista da tela (só as ativas, na ordem da tela) == GET …/options, mesma execução ──
    const req = page.waitForRequest((r) => r.method() === 'GET' && r.url().includes('/therapeutic-catalogs/service-exit-reasons'));
    await page.reload();
    const base = (await req).url().split('/api/admin/')[0];
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    const rotulos = await page.locator('[data-testid^="therapeutic-catalog-label-"]').allTextContents();
    const estados = await page.locator('[data-testid^="therapeutic-catalog-status-"]').allTextContents();
    expect(rotulos.length).toBe(estados.length);
    const daTela = rotulos.filter((_, i) => estados[i].trim() === 'Activa');
    const res = await page.request.get(`${base}/api/admin/therapeutic-catalogs/service-exit-reasons/options`, {
      headers: { authorization: `Bearer ${tokenFor(ADMIN)}` },
    });
    expect(res.status()).toBe(200);
    const options = ((await res.json()) as { data: { items: { code: string; label: string }[] } }).data.items;
    expect(daTela.length, 'contagem: ativas da tela == options').toBe(options.length);
    expect(daTela, 'rótulos, na mesma ordem').toEqual(options.map((o) => o.label));
    expect(options.map((o) => o.label)).toContain(NOVO);
    expect(options.map((o) => o.label)).not.toContain('Otro');
    expect(options.length).toBe(ativos());
  });

  test('ALTERNATIVO 1: rótulo que já existe entre os ativos → 409, frase na tela, lista inalterada', async ({ page }) => {
    await abrirPeloMenu(page);
    const rows = page.locator('[data-testid^="therapeutic-catalog-row-"]');
    const antes = total();
    await expect(rows).toHaveCount(antes);
    const rotulosAntes = await page.locator('[data-testid^="therapeutic-catalog-label-"]').allTextContents();

    await digitarEGuardar(page, `  ${JA_EXISTE.toUpperCase()}  `);
    const recusa = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-catalogs\/service-exit-reasons$/.test(r.url()));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    expect((await recusa).status()).toBe(409);
    await expect(page.getByTestId('therapeutic-catalog-form-error')).toContainText(MSG_DUPLICADO);
    await expect(page.getByTestId('therapeutic-catalog-form-modal')).toBeVisible(); // segue aberta para corrigir
    await page.getByTestId('therapeutic-catalog-form-close').click();
    await expect(page.getByTestId('therapeutic-catalog-form-modal')).toHaveCount(0);

    await expect(rows).toHaveCount(antes);
    expect(await page.locator('[data-testid^="therapeutic-catalog-label-"]').allTextContents()).toEqual(rotulosAntes);
    expect(total()).toBe(antes);
    expect(Number(runSQL(`SELECT count(*) FROM service_exit_reasons WHERE lower(btrim(label)) = lower('${JA_EXISTE}')`))).toBe(1);
  });

  test('ALTERNATIVO 2: rótulo com e-mail → 400, frase na tela, nada criado', async ({ page }) => {
    await abrirPeloMenu(page);
    const antes = total();

    await digitarEGuardar(page, COM_EMAIL);
    const recusa = page.waitForResponse((r) => r.request().method() === 'POST' && /\/therapeutic-catalogs\/service-exit-reasons$/.test(r.url()));
    await page.getByTestId('therapeutic-catalog-form-save').click();
    expect((await recusa).status()).toBe(400);
    await expect(page.getByTestId('therapeutic-catalog-form-error')).toContainText(MSG_INVALIDO);
    await expect(page.getByTestId('therapeutic-catalog-form-modal')).toBeVisible();
    await page.getByTestId('therapeutic-catalog-form-close').click();

    expect(total()).toBe(antes);
    expect(Number(runSQL(`SELECT count(*) FROM service_exit_reasons WHERE label LIKE '%@%'`))).toBe(0);
    await expect(page.locator('[data-testid^="therapeutic-catalog-row-"]')).toHaveCount(antes);
  });
});
