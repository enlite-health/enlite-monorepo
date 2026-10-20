/**
 * 058a-empregados.integration.e2e.ts @integration — spec 058 Parte A, T131: cartão "Empleados" da obra social (contatos de terceiros).
 *
 * E2E DE TELA, SEM MOCK de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo, clique e teclado de humano.
 * O cenário (a obra social e o contato já cadastrado) é montado pela API real.
 *
 *  FELIZ         — "Nuevo" (abre UMA modal) -> nome, cargo, telefone, e-mail, tipo e número do documento -> Guardar -> a linha mostra tudo;
 *                  depois, fechar a modal com alteração pede descarte (X/Esc; seguir editando mantém, descartar fecha) e sem alteração fecha direto.
 *  ALTERNATIVO 1 — tipo do documento SEM número: a tela recusa com a frase (nenhum POST sai) e o servidor, forçado, recusa com
 *                  `DOCUMENT_PAIR_INCOMPLETE` (422); nada foi gravado.
 *  ALTERNATIVO 2 — (ABAC) quem NÃO tem `insurance_provider_contacts:read` não vê a tabela, o telefone, o e-mail nem o nome: vê "sem permissão"
 *                  (não uma tabela vazia) e o servidor devolve 403. Controle positivo: quem tem a célula lê o telefone do MESMO contato.
 *                  SÓ MEDE com o engine ligado (com ele OFF `cells===null` mostra tudo): por isso roda no job do ABAC.
 */
import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/abac-stack-helper';
import {
  RUN_ID, CELLS_INSURANCE_ALL, seedActor, dropActors, purgeProviders, api, apiOk, makeProvider, digitar, escolher,
  type Actor, type ProviderMade,
} from '../helpers/insurance-058a-helper';

const FONE_SEED = '11 5555 0581';
const EMAIL_SEED = `qa058a.seed.${RUN_ID.toLowerCase()}@example.test`;

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('058a-empregados — cartão Empleados da obra social (spec 058 T131) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let ator: Actor;
  let semLeitura: Actor;
  let obra: ProviderMade;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    ator = seedActor('emp', CELLS_INSURANCE_ALL);
    // Vê a obra social, mas NÃO lê os contatos: é a pessoa do alternativo 2.
    semLeitura = seedActor('emp-sem-leitura', [['catalog_insurance_providers', 'read'], ['insurance_contracts', 'read']]);
    obra = await makeProvider(request, ator, 'Empleados');
    await apiOk(request, ator, 'POST', `/api/admin/insurance-providers/${obra.code}/contacts`,
      { fullName: `QA058A Contato Semente ${RUN_ID}`, roleTitle: 'Facturación', phone: FONE_SEED, email: EMAIL_SEED }, 201);
    await request.dispose();
  });

  test.afterAll(() => {
    purgeProviders();
    dropActors();
  });

  test('FELIZ: Nuevo empleado com e-mail e documento -> Guardar -> a linha mostra nome, cargo, telefone, e-mail e identificação', async ({ page }) => {
    const nome = `QA058A Empleado Feliz ${RUN_ID}`;
    const email = `qa058a.feliz.${RUN_ID.toLowerCase()}@example.test`;

    await loginAs(page, ator.user);
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(obra.code)}`);
    await expect(page.getByTestId('provider-employees-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('employees-table')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('employees-new').click();
    await expect(page.getByTestId('contact-form')).toBeVisible();
    expect(await digitar(page, 'contact-fullName', nome)).toBe(nome);
    expect(await digitar(page, 'contact-roleTitle', 'Gerente de cuentas')).toBe('Gerente de cuentas');
    expect(await digitar(page, 'contact-phone', '11 5555 0582')).toBe('11 5555 0582');
    expect(await digitar(page, 'contact-email', email)).toBe(email);
    await escolher(page, 'contact-documentType', 'DNI');
    expect(await digitar(page, 'contact-documentNumber', '99000582')).toBe('99000582');

    const criado = page.waitForResponse((r) => r.request().method() === 'POST' && /\/insurance-providers\/[^/]+\/contacts$/.test(r.url()));
    await page.getByTestId('contact-save').click();
    expect((await criado).status()).toBe(201);
    await expect(page.getByTestId('contact-form')).toHaveCount(0);

    // A tabela, como uma pessoa a lê.
    const linha = page.locator('[data-testid^="employee-row-"]', { hasText: nome });
    await expect(linha).toHaveCount(1);
    await expect(linha).toContainText(email);
    await expect(linha).toContainText('Gerente de cuentas');
    await expect(linha).toContainText('11 5555 0582');
    await expect(linha).toContainText('DNI');
    await expect(linha).toContainText('99000582');
    // O contato semente (cadastrado pela API) continua ali: o Novo acrescenta, não substitui.
    await expect(page.locator('[data-testid^="employee-row-"]', { hasText: `QA058A Contato Semente ${RUN_ID}` })).toHaveCount(1);

    // Fechar a modal COM alteração pede descarte (X e Esc); "Seguir editando" mantém o digitado; "Descartar" fecha sem gravar nada.
    const rascunho = `QA058A Empleado Rascunho ${RUN_ID}`;
    await page.getByTestId('employees-new').click();
    await expect(page.getByTestId('contact-form')).toBeVisible();
    expect(await digitar(page, 'contact-fullName', rascunho)).toBe(rascunho);
    await page.getByTestId('contact-form-close').click();
    await expect(page.getByTestId('discard-changes-confirm')).toBeVisible();
    await page.getByTestId('discard-changes-keep-editing').click();
    await expect(page.getByTestId('discard-changes-confirm')).toHaveCount(0);
    await expect(page.getByTestId('contact-fullName')).toHaveValue(rascunho);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('discard-changes-confirm')).toBeVisible();
    await page.getByTestId('discard-changes-discard').click();
    await expect(page.getByTestId('contact-form')).toHaveCount(0);
    await expect(page.locator('[data-testid^="employee-row-"]', { hasText: rascunho })).toHaveCount(0);
    // Sem alteração, fecha direto (sem pergunta).
    await page.getByTestId('employees-new').click();
    await page.getByTestId('contact-form-close').click();
    await expect(page.getByTestId('contact-form')).toHaveCount(0);
    await expect(page.getByTestId('discard-changes-confirm')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/058a-empregados.png', fullPage: true });
  });

  test('ALTERNATIVO 1: tipo de documento sem número -> a tela recusa com a frase (nenhum POST) e o servidor recusa com DOCUMENT_PAIR_INCOMPLETE', async ({ page, request }) => {
    const nome = `QA058A Empleado Par ${RUN_ID}`;
    let posts = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && /\/contacts$/.test(r.url())) posts += 1; });

    await loginAs(page, ator.user);
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(obra.code)}`);
    await expect(page.getByTestId('employees-table')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('employees-new').click();
    await digitar(page, 'contact-fullName', nome);
    await digitar(page, 'contact-roleTitle', 'Auditoría');
    await digitar(page, 'contact-phone', '11 5555 0583');
    await escolher(page, 'contact-documentType', 'DNI'); // o número fica vazio
    await page.getByTestId('contact-save').click();
    await expect(page.getByTestId('contact-problem')).toHaveText('Informá el tipo y el número del documento juntos, o dejá los dos vacíos.');
    expect(posts, 'a API não foi chamada com o par incompleto').toBe(0);
    await expect(page.getByTestId('contact-form')).toBeVisible();

    // Forçando pela API real: o servidor recusa com o código (a tela não é a única trava).
    const forcado = await api(request, ator, 'POST', `/api/admin/insurance-providers/${obra.code}/contacts`,
      { fullName: nome, roleTitle: 'Auditoría', phone: '11 5555 0583', documentType: 'DNI' });
    expect(forcado.status).toBe(422);
    expect(forcado.body?.code).toBe('DOCUMENT_PAIR_INCOMPLETE');
    const lista = await apiOk<{ items: Array<{ fullName: string }> }>(request, ator, 'GET', `/api/admin/insurance-providers/${obra.code}/contacts`, undefined, 200);
    expect(lista.items.map((c) => c.fullName)).not.toContain(nome);
  });

  test('ALTERNATIVO 2 (ABAC): sem `insurance_provider_contacts:read` o cartão diz "sem permissão" e nada do contato aparece; o servidor devolve 403', async ({ page, request }) => {
    // Controle positivo (o teste enxerga o que deveria ter): quem tem a célula lê o telefone do MESMO contato.
    const comLeitura = await apiOk<{ items: Array<{ phone: string | null; redacted: boolean }> }>(
      request, ator, 'GET', `/api/admin/insurance-providers/${obra.code}/contacts`, undefined, 200);
    expect(comLeitura.items.some((c) => c.phone === FONE_SEED && !c.redacted)).toBe(true);

    await loginAs(page, semLeitura.user);
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(obra.code)}`);
    await expect(page.getByTestId('provider-general-view')).toBeVisible({ timeout: 30_000 }); // a página abre: a pessoa lê a obra social
    await expect(page.getByTestId('employees-no-permission')).toHaveText('No tenés permiso para ver los empleados de esta obra social.');
    await expect(page.getByTestId('employees-table')).toHaveCount(0);
    await expect(page.getByTestId('employees-new')).toHaveCount(0);
    const corpo = await page.locator('body').innerText();
    expect(corpo).not.toContain(FONE_SEED);
    expect(corpo).not.toContain(EMAIL_SEED);
    expect(corpo).not.toContain('Contato Semente');

    const negado = await api(request, semLeitura, 'GET', `/api/admin/insurance-providers/${obra.code}/contacts`);
    expect(negado.status).toBe(403);
    expect(JSON.stringify(negado.body)).not.toContain(FONE_SEED);
  });
});
