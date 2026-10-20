/**
 * 058a-contratos.integration.e2e.ts @integration — spec 058 Parte A, T132: cartão "Contratos" da obra social (contrato + termo de valor).
 *
 * E2E DE TELA, SEM MOCK de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo, clique e teclado de humano.
 * Os cenários (obras sociais, contrato com termo) são montados pela API real.
 *
 *  FELIZ         — "Nuevo contrato" -> nome, país, valor-hora e imposto `0` DIGITADO -> Guardar -> o contrato aparece com o valor e "Exento (0 %)".
 *  ALTERNATIVO 1 — obra social sem tipo de pagador: `PAYER_KIND_REQUIRED` com a frase e o LINK para Dados gerais; classificada ali, o mesmo
 *                  formulário salva.
 *  ALTERNATIVO 2 — imposto VAZIO é recusado (a frase pede "0 se isento"), nenhum POST sai; o servidor recusa o corpo sem imposto (422).
 *  ALTERNATIVO 3 — (ABAC) sem `patient_contract_value:read` o valor-hora é `REDACTED` (cadeado + frase, nunca o número) e o imposto continua
 *                  visível; sem `patient_contract_value:create` não há botão de contrato/termo. Só mede com o engine ligado.
 */
import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/abac-stack-helper';
import {
  RUN_ID, CELLS_INSURANCE_ALL, seedActor, dropActors, purgeProviders, api, apiOk, makeProvider, makeContract, asOfAR, addDays, digitar, escolher,
  type Actor, type ProviderMade, type ContractMade,
} from '../helpers/insurance-058a-helper';

const VALOR_1500 = /1\.?500,00/;

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('058a-contratos — cartão Contratos da obra social (spec 058 T132) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let ator: Actor;
  let semValor: Actor;
  let classificada: ProviderMade;
  let semTipo: ProviderMade;
  let existente: ContractMade;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    ator = seedActor('contr', CELLS_INSURANCE_ALL);
    // Lê a obra social e os contratos, mas NÃO o valor nem cria termo: é a pessoa do alternativo 3.
    semValor = seedActor('contr-sem-valor', [['catalog_insurance_providers', 'read'], ['insurance_contracts', 'read']]);
    classificada = await makeProvider(request, ator, 'Contratos');
    semTipo = await makeProvider(request, ator, 'Contratos SemTipo', null);
    const hoje = await asOfAR(request, ator);
    existente = await makeContract(request, ator, classificada.code, 'Existente', { hourlyRate: 1500, taxRatePercent: 0, validFrom: addDays(hoje, -30) });
    await request.dispose();
  });

  test.afterAll(() => {
    purgeProviders();
    dropActors();
  });

  test('FELIZ: Nuevo contrato com imposto 0 digitado -> o contrato aparece com o valor-hora e "Exento (0 %)"', async ({ page }) => {
    const nome = `Contrato Feliz ${RUN_ID}`;
    await loginAs(page, ator.user);
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(classificada.code)}`);
    await expect(page.getByTestId('contracts-list')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('contracts-new').click();
    await expect(page.getByTestId('contract-new-form')).toBeVisible();
    expect(await digitar(page, 'contract-new-name', nome)).toBe(nome);
    await escolher(page, 'contract-new-country', 'Argentina');
    // O "hoje" do país vem da API: só depois dele o início aparece (preenchido).
    await expect(page.getByTestId('contract-new-valid-from')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('contract-new-valid-from')).not.toHaveValue('');
    // O imposto NASCE vazio; o 0 é digitado.
    await expect(page.getByTestId('contract-new-tax-rate')).toHaveValue('');
    expect(await digitar(page, 'contract-new-hourly-rate', '1500')).toBe('1500');
    expect(await digitar(page, 'contract-new-tax-rate', '0')).toBe('0');

    const criado = page.waitForResponse((r) => r.request().method() === 'POST' && /\/insurance-providers\/[^/]+\/contracts$/.test(r.url()));
    await page.getByTestId('contract-new-submit').click();
    expect((await criado).status()).toBe(201);
    await expect(page.getByTestId('contract-new-form')).toHaveCount(0);

    const contrato = page.getByTestId('contracts-list').locator('article', { hasText: nome });
    await expect(contrato).toHaveCount(1);
    await expect(contrato.locator('[data-testid$="-current-price"]')).toContainText(VALOR_1500);
    await expect(contrato.locator('[data-testid$="-current-tax"]')).toContainText('Exento (0 %)');
    await expect(contrato.locator('[data-testid$="-country"]')).toHaveText('Argentina');
    // O contrato de antes (montado pela API) segue na lista.
    await expect(page.getByTestId(`contract-${existente.id}`)).toBeVisible();
    await page.screenshot({ path: 'test-results/058a-contratos.png', fullPage: true });
  });

  test('ALTERNATIVO 1: obra social sem tipo de pagador -> PAYER_KIND_REQUIRED com o link para Dados gerais; classificada ali, o mesmo formulário salva', async ({ page, request }) => {
    const nome = `Contrato SemTipo ${RUN_ID}`;
    await loginAs(page, ator.user);
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(semTipo.code)}`);
    await expect(page.getByTestId('provider-general-payerKind')).toHaveText('Sin clasificar', { timeout: 30_000 });
    await page.getByTestId('contracts-new').click();
    await digitar(page, 'contract-new-name', nome);
    await escolher(page, 'contract-new-country', 'Argentina');
    await expect(page.getByTestId('contract-new-valid-from')).not.toHaveValue('');
    await digitar(page, 'contract-new-hourly-rate', '1200');
    await digitar(page, 'contract-new-tax-rate', '0');
    await page.getByTestId('contract-new-submit').click();

    await expect(page.getByTestId('contract-new-error')).toHaveText(
      'Clasificá el tipo de pagador (obra social, prepaga o particular) en Datos generales antes de crear un contrato.');
    const lista = await apiOk<{ items: Array<{ name: string }> }>(request, ator, 'GET', `/api/admin/insurance-providers/${semTipo.code}/contracts`, undefined, 200);
    expect(lista.items.map((c) => c.name)).not.toContain(nome);

    // O link leva ao cartão Dados gerais, já em edição.
    await expect(page.getByTestId('contracts-payer-kind-required')).toBeVisible();
    await page.getByTestId('contracts-go-general').click();
    await expect(page.getByTestId('provider-general-form')).toBeVisible();
    await escolher(page, 'provider-general-payerKind-input', 'Prepaga');
    await page.getByTestId('provider-general-save').click();
    await expect(page.getByTestId('provider-general-payerKind')).toHaveText('Prepaga');

    // O formulário continuou aberto com o que foi digitado: salvar agora funciona.
    await expect(page.getByTestId('contract-new-name')).toHaveValue(nome);
    await page.getByTestId('contract-new-submit').click();
    await expect(page.getByTestId('contract-new-form')).toHaveCount(0);
    await expect(page.getByTestId('contracts-list').locator('article', { hasText: nome })).toHaveCount(1);
  });

  test('ALTERNATIVO 2: imposto vazio é recusado (a frase pede 0 se isento), nenhum POST sai; o servidor recusa o corpo sem imposto', async ({ page, request }) => {
    const nome = `Contrato SemImposto ${RUN_ID}`;
    let posts = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && /\/contracts$/.test(r.url())) posts += 1; });

    await loginAs(page, ator.user);
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(classificada.code)}`);
    await expect(page.getByTestId('contracts-list')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('contracts-new').click();
    await digitar(page, 'contract-new-name', nome);
    await escolher(page, 'contract-new-country', 'Argentina');
    await expect(page.getByTestId('contract-new-valid-from')).not.toHaveValue('');
    await digitar(page, 'contract-new-hourly-rate', '1500');
    await page.getByTestId('contract-new-submit').click(); // imposto vazio
    await expect(page.getByText('Informá el impuesto. Escribí 0 si está exento.')).toBeVisible();
    await expect(page.getByTestId('contract-new-form')).toBeVisible();
    expect(posts, 'a API não foi chamada sem imposto').toBe(0);

    // Forçando pela API real: sem `taxRatePercent` o servidor recusa (o 0 de isento nunca é assumido).
    const hoje = await asOfAR(request, ator);
    const forcado = await api(request, ator, 'POST', `/api/admin/insurance-providers/${classificada.code}/contracts`,
      { name: nome, country: 'AR', firstTerm: { hourlyRate: 1500, validFrom: hoje } });
    expect(forcado.status).toBe(422);
    expect(forcado.body?.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(forcado.body?.details)).toContain('firstTerm'); // o termo embutido no corpo do contrato
    // O mesmo no termo avulso de um contrato existente: o campo recusado vem NOMEADO.
    const termoSemImposto = await api(request, ator, 'POST', `/api/admin/insurance-contracts/${existente.id}/terms`, { hourlyRate: 1600, validFrom: addDays(hoje, 1) });
    expect(termoSemImposto.status).toBe(422);
    expect(termoSemImposto.body?.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(termoSemImposto.body?.details)).toContain('taxRatePercent');
    const lista = await apiOk<{ items: Array<{ name: string }> }>(request, ator, 'GET', `/api/admin/insurance-providers/${classificada.code}/contracts`, undefined, 200);
    expect(lista.items.map((c) => c.name)).not.toContain(nome);
  });

  test('ALTERNATIVO 3 (ABAC): sem `patient_contract_value:read` o valor-hora vem REDACTED (cadeado, nunca o número); o imposto segue visível; sem botão de contrato', async ({ page, request }) => {
    // Controle positivo: quem tem a célula lê o número do MESMO contrato.
    const comValor = await apiOk<{ items: Array<{ id: string; currentTerm: { price: { state: string; hourlyRate?: number } } }> }>(
      request, ator, 'GET', `/api/admin/insurance-providers/${classificada.code}/contracts`, undefined, 200);
    const meu = comValor.items.find((c) => c.id === existente.id);
    expect(meu?.currentTerm.price).toMatchObject({ state: 'OK', hourlyRate: 1500 });

    await loginAs(page, semValor.user);
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(classificada.code)}`);
    const contrato = page.getByTestId(`contract-${existente.id}`);
    await expect(contrato).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`contract-${existente.id}-current-price`)).toContainText('🔒 Sin permiso para ver el valor');
    await expect(page.getByTestId(`contract-${existente.id}-current-price`)).not.toContainText(/1\.?500/);
    await expect(page.getByTestId(`contract-${existente.id}-current-tax`)).toContainText('Exento (0 %)');
    await expect(page.getByTestId('contracts-new')).toHaveCount(0);
    await expect(page.getByTestId(`contract-${existente.id}-new-term`)).toHaveCount(0);

    const redigido = await apiOk<{ items: Array<{ id: string; currentTerm: { price: { state: string; hourlyRate?: number } } }> }>(
      request, semValor, 'GET', `/api/admin/insurance-providers/${classificada.code}/contracts`, undefined, 200);
    expect(redigido.items.find((c) => c.id === existente.id)?.currentTerm.price).toEqual({ state: 'REDACTED' });
  });
});
