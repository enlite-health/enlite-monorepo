/**
 * Spec 074 — a tela do catálogo "Guardias predefinidas" (`/admin/catalogos/guardias`), exercitada por um HUMANO
 * contra o stack REAL (frontend + API + Postgres), zero mock de rede. Régua humana (memória `e2e-humano-nao-e-fill`):
 * click + `keyboard.type`, hora escolhida no TimeSelect (click no gatilho, click na opção), valor lido da TELA.
 * A API só desmonta o cenário (limpeza) e confere a lista de opções com o token do mesmo STAFF logado.
 *
 * O que se prova:
 *   1. FELIZ — "Nueva opción" → rótulo digitado + 1 turno 06:00–14:00 escolhido → Guardar → POST 201 → a linha mostra
 *      "06:00 – 14:00" → o banco tem 1 item 06:00/480 → reabrir a edição mostra 06:00 e 14:00;
 *   2. ALTERNATIVO — turnos que se sobrepõem (20:00–08:00 e 06:00–10:00) → 422, a frase na tela, modal aberta,
 *      0 linhas com o rótulo no banco (controle: as 2 sementes existem na mesma execução);
 *   3. ALTERNATIVO — mesmo rótulo com caixa e espaços diferentes → 409 com a frase da tela; desativar pelo toggle →
 *      `GET …/options` (token do STAFF) deixa de trazer o id e `GET …?includeInactive=true` traz (controle positivo:
 *      a semente segue em `options`).
 *
 * Dados "QA 074 …" + carimbo do run, removidos no afterAll (itens primeiro, depois as guardias — FK RESTRICT); as
 * sementes `GUARDIAS_8_14_20` e `GUARDIA_24H` nunca são tocadas.
 */
import { test, expect, type Page } from '@playwright/test';
import { runSQL } from '../helpers/patient-detail-c-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import { backendUrl } from '../helpers/lancamento-e2e-helper';

const STAMP = Date.now().toString(36);
const STAFF_EMAIL = `e2e.guardias.${STAMP}@enlite.health`;
const STAFF: MockUser = { uid: `e2e-guardias-${STAMP}`, email: STAFF_EMAIL, role: 'admin', country: 'AR' };
const LABEL = `QA 074 Guardia mañana ${STAMP}`;
const LABEL_SOBREPOSTA = `QA 074 Guardia sobrepuesta ${STAMP}`;
const ROTA = '/admin/catalogos/guardias';
const POST_OU_PATCH_BASE = /\/therapeutic-catalogs\/service-shift-templates$/;
const SEMENTES = "('GUARDIAS_8_14_20','GUARDIA_24H')";

async function entrar(page: Page): Promise<void> {
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${STAFF.uid}', '${STAFF.email}', 'E2E Guardias', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await loginComoStaffMock(page, STAFF, 'E2E Guardias');
}

/** Escolhe a hora no TimeSelect como um humano: abre a lista e clica na opção. */
async function escolherHora(page: Page, testId: string, hora: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByTestId(`${testId}-option-${hora}`).click();
  await expect(page.getByTestId(testId)).toContainText(hora);
}

async function digitarRotulo(page: Page, texto: string): Promise<void> {
  const input = page.getByTestId('therapeutic-catalog-label-input');
  await input.click();
  await expect(input).toBeFocused();
  await page.keyboard.type(texto);
  expect(await input.inputValue()).toBe(texto);
}

async function abrirTela(page: Page): Promise<void> {
  await page.goto(ROTA);
  await expect(page.getByRole('heading', { level: 1, name: 'Guardias predefinidas' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('therapeutic-catalog-table')).toBeVisible();
}

const ehPostDaLista = (r: { request(): { method(): string }; url(): string }): boolean => r.request().method() === 'POST' && POST_OU_PATCH_BASE.test(r.url());

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe('spec 074 — catálogo de guardias predefinidas: um HUMANO cria, esbarra na sobreposição e no duplicado e desativa @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let novoId: string;

  test.afterAll(() => {
    const ids = `SELECT id FROM service_shift_templates WHERE label LIKE 'QA 074 %${STAMP}'`;
    runSQL(`DELETE FROM service_shift_template_items WHERE template_id IN (${ids})`);
    runSQL(`DELETE FROM service_shift_templates WHERE label LIKE 'QA 074 %${STAMP}'`);
    try { runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`); } catch { /* limpeza não esconde o resultado */ }
  });

  test('feliz: cria Guardia QA mañana 06:00-14:00 e reabre', async ({ page }) => {
    await entrar(page);
    await abrirTela(page);
    // Controle positivo: a tela lista as 2 sementes da migration (a linha delas tem os turnos).
    const linhas = page.getByTestId('therapeutic-catalog-table').locator('[data-testid^="therapeutic-catalog-row-"]');
    expect(await linhas.count()).toBeGreaterThanOrEqual(2);

    await page.getByTestId('therapeutic-catalog-new-btn').click();
    const modal = page.getByTestId('therapeutic-catalog-form-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('therapeutic-catalog-form-save')).toBeDisabled(); // 0 turnos
    await digitarRotulo(page, LABEL);
    await page.getByTestId('shift-template-add').click();
    await escolherHora(page, 'svc-shift-start-0', '06:00');
    await escolherHora(page, 'svc-shift-end-0', '14:00');
    await expect(page.getByTestId('svc-shift-duration-0')).toContainText('8 h');
    await expect(page.getByTestId('therapeutic-catalog-not-retroactive')).toHaveText('Los servicios ya cargados no cambian.');

    const criada = page.waitForResponse(ehPostDaLista);
    await page.getByTestId('therapeutic-catalog-form-save').click();
    const resposta = await criada;
    expect(resposta.status()).toBe(201);
    const body = (await resposta.json()) as { data: { id: string; label: string; active: boolean; items: Array<{ startTime: string; durationMinutes: number }> } };
    expect(body.data.label).toBe(LABEL);
    novoId = body.data.id;

    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId(`therapeutic-catalog-label-${novoId}`)).toHaveText(LABEL);
    await expect(page.getByTestId(`therapeutic-catalog-shifts-${novoId}`)).toHaveText('06:00 – 14:00');
    await expect(page.getByTestId(`therapeutic-catalog-status-${novoId}`)).toContainText('Activa');
    expect(runSQL(`SELECT count(*)::text || ',' || min(to_char(start_time, 'HH24:MI')) || ',' || min(duration_minutes)::text FROM service_shift_template_items WHERE template_id = '${novoId}'`)).toBe('1,06:00,480');

    // Reabrir a edição: o turno hidrata da API (06:00 e 14:00), não de estado local.
    await page.getByTestId(`therapeutic-catalog-edit-${novoId}`).click();
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('svc-shift-start-0')).toContainText('06:00');
    await expect(page.getByTestId('svc-shift-end-0')).toContainText('14:00');
    await page.getByTestId('therapeutic-catalog-form-close').click();
    await expect(modal).toHaveCount(0);
  });

  test('alternativo: turnos sobrepostos mostram erro e nada é gravado', async ({ page }) => {
    await entrar(page);
    await abrirTela(page);
    await page.getByTestId('therapeutic-catalog-new-btn').click();
    const modal = page.getByTestId('therapeutic-catalog-form-modal');
    await expect(modal).toBeVisible();
    await digitarRotulo(page, LABEL_SOBREPOSTA);
    await page.getByTestId('shift-template-add').click();
    await escolherHora(page, 'svc-shift-start-0', '20:00');
    await escolherHora(page, 'svc-shift-end-0', '08:00');
    await page.getByTestId('shift-template-add').click();
    await escolherHora(page, 'svc-shift-start-1', '06:00');
    await escolherHora(page, 'svc-shift-end-1', '10:00');

    const recusa = page.waitForResponse(ehPostDaLista);
    await page.getByTestId('therapeutic-catalog-form-save').click();
    expect((await recusa).status()).toBe(422);
    await expect(page.getByTestId('therapeutic-catalog-form-error')).toContainText('Hay turnos que se superponen dentro de la guardia.');
    await expect(modal).toBeVisible(); // segue aberta para o humano corrigir
    // Banco: nada gravado, com controle positivo na mesma execução (a consulta enxerga as 2 sementes).
    expect(Number(runSQL(`SELECT count(*) FROM service_shift_templates WHERE code IN ${SEMENTES}`))).toBe(2);
    expect(Number(runSQL(`SELECT count(*) FROM service_shift_templates WHERE label = '${LABEL_SOBREPOSTA}'`))).toBe(0);
    await page.getByTestId('therapeutic-catalog-form-close').click();
    await expect(modal).toHaveCount(0);
  });

  test('alternativo: nome duplicado mostra erro; desativar tira da lista de opções', async ({ page }) => {
    expect(novoId, 'o teste feliz criou a guardia').toBeTruthy();
    await entrar(page);
    await abrirTela(page);

    // ── 409: o MESMO texto (caixa e espaços diferentes) ──────────────────────────────────────
    await page.getByTestId('therapeutic-catalog-new-btn').click();
    const modal = page.getByTestId('therapeutic-catalog-form-modal');
    await expect(modal).toBeVisible();
    await digitarRotulo(page, `  ${LABEL.replace('Guardia', 'GUARDIA')}  `);
    await page.getByTestId('shift-template-add').click();
    await expect(page.getByTestId('svc-shift-start-0')).toBeVisible();
    const recusa = page.waitForResponse(ehPostDaLista);
    await page.getByTestId('therapeutic-catalog-form-save').click();
    expect((await recusa).status()).toBe(409);
    await expect(page.getByTestId('therapeutic-catalog-form-error')).toContainText('Ya existe una opción activa con ese texto');
    await expect(modal).toBeVisible();
    await page.getByTestId('therapeutic-catalog-form-close').click();
    await expect(modal).toHaveCount(0);
    expect(Number(runSQL(`SELECT count(*) FROM service_shift_templates WHERE lower(btrim(label)) = lower('${LABEL}') AND active`))).toBe(1);

    // ── desativar pelo toggle ───────────────────────────────────────────────────────────────
    await expect(page.getByTestId(`therapeutic-catalog-status-${novoId}`)).toContainText('Activa');
    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/service-shift-templates/${novoId}`));
    await page.getByTestId(`therapeutic-catalog-toggle-${novoId}`).click();
    expect((await patched).status()).toBe(200);
    await expect(page.getByTestId(`therapeutic-catalog-status-${novoId}`)).toContainText('Inactiva');
    expect(runSQL(`SELECT active::text || ',' || (deactivated_at IS NOT NULL)::text FROM service_shift_templates WHERE id = '${novoId}'`)).toBe('false,true');

    // A lista de opções do editor do serviço (só ativas) deixa de trazer o id; a da tela (includeInactive) traz.
    const authorization = `Bearer ${tokenFor(STAFF)}`;
    const base = `${backendUrl()}/api/admin/therapeutic-catalogs/service-shift-templates`;
    const semente24h = runSQL(`SELECT id FROM service_shift_templates WHERE code = 'GUARDIA_24H'`);
    const opcoes = await page.request.get(`${base}/options`, { headers: { authorization } });
    expect(opcoes.status()).toBe(200);
    const idsOpcoes = ((await opcoes.json()) as { data: { items: Array<{ id: string }> } }).data.items.map((i) => i.id);
    expect(idsOpcoes, 'controle positivo: a semente segue nas opções').toContain(semente24h);
    expect(idsOpcoes).not.toContain(novoId);
    const daTela = await page.request.get(`${base}?includeInactive=true`, { headers: { authorization } });
    expect(daTela.status()).toBe(200);
    expect(((await daTela.json()) as { data: { items: Array<{ id: string }> } }).data.items.map((i) => i.id)).toContain(novoId);
  });
});
