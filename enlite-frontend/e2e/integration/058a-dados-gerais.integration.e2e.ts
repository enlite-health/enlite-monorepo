/**
 * 058a-dados-gerais.integration.e2e.ts @integration — spec 058 Parte A, T130: cadastro da obra social e o cartão "Datos generales".
 *
 * E2E DE TELA, SEM MOCK de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL), clique e
 * teclado de humano (`loginAs`, `click` + `keyboard.type`, valor lido da tela). O cenário (a obra social "outra") é montado pela API real.
 *
 *  FELIZ         — cria a obra social SÓ com o nome + aliases (R8: o alias gravado aparece em `insurance_provider_aliases` e aponta o código),
 *                  abre o cartão, completa razão social / CUIT / endereço, classifica o pagador, reabre e vê tudo persistido; a lista mostra o tipo.
 *  ALTERNATIVO 1 — nome repetido (renomear para o de outra) = 409 com a mensagem; nome só de símbolos = a tela pede o código
 *                  (`NAME_NOT_CODIFIABLE`) e, informado, cria.
 *  ALTERNATIVO 2 — CUIT de outra obra social = 409 com a mensagem; classificar a "Particular" como obra social = a mensagem do CHECK.
 *
 * Roda no job do ENGINE ABAC LIGADO de `_frontend-integration.yml` (usa `abac-stack-helper`: Postgres/API desse job).
 */
import { test, expect } from '@playwright/test';
import { scalar, loginAs } from '../helpers/abac-stack-helper';
import {
  RUN_ID, CELLS_INSURANCE_ALL, seedActor, dropActors, purgeProviders, api, makeProvider, digitar, substituir, escolher, type Actor,
} from '../helpers/insurance-058a-helper';

// CUIT sintético, único por rodada (a obra social vive só neste banco de teste).
const TAX_A = `30${Date.now().toString().slice(-9)}`;
const TAX_FELIZ = `33${Date.now().toString().slice(-9)}`;

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('058a-dados-gerais — cadastro da obra social e cartão Dados generales (spec 058 T130) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let ator: Actor;

  test.beforeAll(() => {
    ator = seedActor('geral', CELLS_INSURANCE_ALL);
  });

  test.afterAll(() => {
    purgeProviders();
    dropActors();
  });

  test('FELIZ: cria só com o nome (+ aliases), completa os dados gerais, classifica e reabre tudo persistido', async ({ page }) => {
    const nome = `QA058A Geral Feliz ${RUN_ID}`;
    const alias = `QA058A alias ${RUN_ID}`;

    await loginAs(page, ator.user);
    await page.goto('/admin/obras-sociales');
    await expect(page.getByTestId('providers-new')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('providers-new').click();
    await expect(page.getByTestId('provider-create-form')).toBeVisible();
    expect(await digitar(page, 'provider-create-name', nome)).toBe(nome);
    expect(await digitar(page, 'provider-create-aliases', alias)).toBe(alias);
    await page.getByTestId('provider-create-submit').click();

    // Criada, abre a página de cartões; o código sai do nome e vai na URL.
    await expect(page).toHaveURL(/\/admin\/obras-sociales\/[^/]+$/, { timeout: 20_000 });
    const code = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
    expect(code).not.toBe('');
    await expect(page.getByTestId('provider-general-name')).toHaveText(nome);
    await expect(page.getByTestId('provider-general-code')).toHaveText(code);
    await expect(page.getByTestId('provider-general-payerKind')).toHaveText('Sin clasificar');

    // R8: o alias gravado no POST mínimo aparece em `insurance_provider_aliases` e MAPEIA o rótulo para este código.
    expect(scalar(`SELECT code FROM insurance_provider_aliases WHERE source = 'clickup' AND label = '${alias}'`)).toBe(code);

    // Completa o cartão: razão social, CUIT, endereço e o tipo do pagador.
    await page.getByTestId('provider-general-edit').click();
    await expect(page.getByTestId('provider-general-form')).toBeVisible();
    await digitar(page, 'provider-general-legalName-input', 'QA058A Razon Social S.A.');
    await digitar(page, 'provider-general-taxId-input', TAX_FELIZ);
    await digitar(page, 'provider-general-address-input', 'Av. Sintetica 1234, CABA');
    await escolher(page, 'provider-general-payerKind-input', 'Obra Social');
    await page.getByTestId('provider-general-save').click();
    await expect(page.getByTestId('provider-general-view')).toBeVisible();
    await expect(page.getByTestId('provider-general-legalName')).toHaveText('QA058A Razon Social S.A.');
    await expect(page.getByTestId('provider-general-taxId')).toHaveText(TAX_FELIZ);
    await expect(page.getByTestId('provider-general-payerKind')).toHaveText('Obra Social');

    // Reabre a página: tudo persistido (lido da tela, não do estado em memória).
    await page.reload();
    await expect(page.getByTestId('provider-general-view')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('provider-general-name')).toHaveText(nome);
    await expect(page.getByTestId('provider-general-address')).toHaveText('Av. Sintetica 1234, CABA');
    await expect(page.getByTestId('provider-general-taxId')).toHaveText(TAX_FELIZ);
    await expect(page.getByTestId('provider-general-payerKind')).toHaveText('Obra Social');
    expect(scalar(`SELECT payer_kind FROM insurance_providers WHERE code = '${code}'`)).toBe('OBRA_SOCIAL');

    // A lista mostra o tipo e o estado.
    await page.goto('/admin/obras-sociales');
    await digitar(page, 'providers-search', nome);
    await expect(page.getByTestId(`provider-row-${code}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`provider-kind-${code}`)).toHaveText('Obra Social');
    await expect(page.getByTestId(`provider-status-${code}`)).toHaveText('Activa');

    await page.goto(`/admin/obras-sociales/${encodeURIComponent(code)}`);
    await expect(page.getByTestId('provider-general-view')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: 'test-results/058a-dados-gerais.png', fullPage: true });
  });

  test('ALTERNATIVO 1: nome repetido = 409 com a mensagem; nome só de símbolos = a tela pede o código e, informado, cria', async ({ page, request }) => {
    const outra = await makeProvider(request, ator, 'Geral Alt1 A');
    const esta = await makeProvider(request, ator, 'Geral Alt1 B');

    await loginAs(page, ator.user);
    // (a) renomear "B" para o nome de "A" (em minúsculas: a unicidade é por lower(btrim(nome))) -> 409, e o nome gravado NÃO muda.
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(esta.code)}`);
    await expect(page.getByTestId('provider-general-view')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('provider-general-edit').click();
    expect(await substituir(page, 'provider-general-name-input', outra.name.toLowerCase())).toBe(outra.name.toLowerCase());
    await page.getByTestId('provider-general-save').click();
    await expect(page.getByTestId('provider-general-error')).toHaveText('Ya existe una obra social con ese nombre.');
    expect(scalar(`SELECT name FROM insurance_providers WHERE code = '${esta.code}'`)).toBe(esta.name);

    // (b) nome só de símbolos: o código não sai dele -> a tela pede o código; informado, a obra social é criada.
    await page.goto('/admin/obras-sociales');
    await page.getByTestId('providers-new').click();
    await digitar(page, 'provider-create-name', '***');
    await expect(page.getByTestId('provider-create-code')).toHaveCount(0);
    await page.getByTestId('provider-create-submit').click();
    await expect(page.getByTestId('provider-create-error')).toHaveText('Ese nombre no sirve para generar el código. Probá con otro.');
    await expect(page.getByTestId('provider-create-code')).toBeVisible();
    const codigo = `QA058A${RUN_ID}X`;
    expect(await digitar(page, 'provider-create-code', codigo)).toBe(codigo);
    await page.getByTestId('provider-create-submit').click();
    await expect(page).toHaveURL(new RegExp(`/admin/obras-sociales/${codigo}$`), { timeout: 20_000 });
    await expect(page.getByTestId('provider-general-code')).toHaveText(codigo);
    expect(scalar(`SELECT name FROM insurance_providers WHERE code = '${codigo}'`)).toBe('***');
  });

  test('ALTERNATIVO 2: CUIT de outra obra social = 409 com a mensagem; classificar a "Particular" como obra social = a mensagem do CHECK', async ({ page, request }) => {
    const dona = await makeProvider(request, ator, 'Geral Alt2 A');
    const outra = await makeProvider(request, ator, 'Geral Alt2 B');
    const dado = await api(request, ator, 'PATCH', `/api/admin/insurance-providers/${dona.code}`, { taxId: TAX_A });
    expect(dado.status, JSON.stringify(dado.body)).toBe(200);

    await loginAs(page, ator.user);
    // (a) o CUIT da "A" digitado na "B": 409 e nada gravado.
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(outra.code)}`);
    await expect(page.getByTestId('provider-general-view')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('provider-general-edit').click();
    expect(await digitar(page, 'provider-general-taxId-input', TAX_A)).toBe(TAX_A);
    await page.getByTestId('provider-general-save').click();
    await expect(page.getByTestId('provider-general-error')).toHaveText('Ya existe una obra social con ese CUIT/CNPJ.');
    expect(scalar(`SELECT count(*) FROM insurance_providers WHERE tax_id = '${TAX_A}'`)).toBe('1');

    // (b) a "Particular" (catálogo) só admite o tipo "Particular": a mensagem do CHECK, e o tipo não muda.
    const antes = scalar(`SELECT coalesce(payer_kind, 'NULL') FROM insurance_providers WHERE code = 'PRIVATE'`);
    expect(antes, 'a obra social "Particular" (code PRIVATE) existe no catálogo semeado').not.toBe('');
    await page.goto('/admin/obras-sociales/PRIVATE');
    await expect(page.getByTestId('provider-general-view')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('provider-general-edit').click();
    await escolher(page, 'provider-general-payerKind-input', 'Obra Social');
    await page.getByTestId('provider-general-save').click();
    await expect(page.getByTestId('provider-general-error')).toHaveText('La obra social "Particular" solo puede tener el tipo de pagador "Particular".');
    expect(scalar(`SELECT coalesce(payer_kind, 'NULL') FROM insurance_providers WHERE code = 'PRIVATE'`)).toBe(antes);
  });
});
