/**
 * pedidos-ia.integration.e2e.ts @integration — spec 078, M3b-1.4: a tela `/admin/pedidos-ia` (pedidos do Sol como posts).
 *
 * E2E DE TELA, sem mock de resposta de negócio: navegador real -> API real -> Postgres real, login MOCK do stack de CI
 * (`loginComoStaffMock`, click + `keyboard.type`), engine ABAC DESLIGADO (as rotas caem no papel ADMIN: `untilEnforced: 'admin'`).
 * Pedido SINTÉTICO por SQL (ÁREA única por rodada — não existe rota que crie pedido; quem cria é o Sol). Interação humana:
 * clique + teclado, valor LIDO da tela; a prova do efeito é a tela E o banco (linha em `agentes.pedido_eventos`).
 *
 *  feliz  — a lista mostra o pedido (GRAVE + NOVO) -> "Ver detalle" mostra a atitude -> Aceptar -> status "Aceptado" e o evento
 *           aparece no histórico; o banco tem exatamente 1 evento (humano, uid do staff).
 *  alt 1  — Negar sem motivo: o botão do modal fica DESABILITADO (nem só espaços vale) e o banco segue com 0 eventos; com motivo -> "Negado".
 *  alt 2  — Descrever o que fazer: pede comentário; status "Redirigido", comentário no histórico; os botões continuam (o Sol redige a próxima versão).
 *  visual — 1280 e 390 px: sem rolagem horizontal e NENHUM texto abaixo de 7:1 (AAA).
 *
 * Escrito para o job padrão do CI (`pr-gate.yml`, `grep:`). Rodar local = o stack do CI; quem prova que PASSA é o CI.
 */
import { test, expect, type Page } from '@playwright/test';
import { escolherNoCombo } from '../helpers/combobox';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { scanContrastViolations } from '../helpers/contrast-helper';
import type { MockUser } from '../helpers/abac-stack-helper';
import { contarEventos, limparPedidos, seedPedido, sqlViaDocker, ultimoEvento } from '../helpers/pedidos-ia-seed';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const AREA = `ar-e2e-${RUN}`;
const STAFF: MockUser = { uid: `e2e-pia-${RUN}`, email: `pia.${RUN}@e2e.test`, role: 'admin', country: 'AR' };

let feliz = '';
let negar = '';
let descrever = '';

async function abrirTela(page: Page): Promise<void> {
  await loginComoStaffMock(page, STAFF, 'E2E Pedidos');
  await page.goto('/admin/pedidos-ia');
  await expect(page.getByTestId('pedidos-ia-page')).toBeVisible({ timeout: 30_000 });
  // O filtro por área isola o cenário desta rodada (as opções vêm do que a lista já trouxe).
  await escolherNoCombo(page, page.getByTestId('pedidos-filtro-area'), AREA);
}

test.describe('pedidos-ia 078 — tela dos pedidos do Sol (aceitar, negar, descrever) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeAll(() => {
    limparPedidos(sqlViaDocker, AREA);
    feliz = seedPedido(sqlViaDocker, { assunto: `Feliz ${RUN}`, area: AREA, grave: 'dado' });
    negar = seedPedido(sqlViaDocker, { assunto: `Negar ${RUN}`, area: AREA });
    descrever = seedPedido(sqlViaDocker, { assunto: `Descrever ${RUN}`, area: AREA });
  });

  test.afterAll(() => limparPedidos(sqlViaDocker, AREA));

  test('feliz: a lista mostra o pedido grave e novo, o detalhe mostra a atitude e Aceptar muda o status e grava 1 evento', async ({ page }, testInfo) => {
    await abrirTela(page);
    const post = page.getByTestId(`pedido-post-${feliz}`);
    await expect(post).toBeVisible();
    await expect(post.getByTestId('pedido-grave')).toBeVisible();
    await expect(post.getByTestId('pedido-novo')).toBeVisible();
    await expect(post.getByTestId('pedido-status')).toHaveText('Nuevo');
    await expect(page.getByTestId(`pedido-post-${negar}`).getByTestId('pedido-grave')).toHaveCount(0); // controle: sem gatilho, sem etiqueta

    await post.getByTestId('pedido-toggle').click();
    await expect(post.getByTestId('pedido-detalhe')).toContainText('conteudo sintetico');
    await expect(post.getByTestId('pedido-detalhe')).toContainText('caso sintetico');
    expect(contarEventos(sqlViaDocker, feliz)).toBe(0); // ver não grava nada

    await post.getByTestId('pedido-aceitar').click();
    await expect(post.getByTestId('pedido-status')).toHaveText('Aceptado', { timeout: 20_000 });
    await expect(post.getByTestId('pedido-eventos')).toContainText('Aceptó');
    await expect(post.getByTestId('pedido-aceitar')).toHaveCount(0); // decidido: sem botões
    expect(contarEventos(sqlViaDocker, feliz)).toBe(1);
    expect(ultimoEvento(sqlViaDocker, feliz)).toBe(`aceitar|${STAFF.uid}|humano`);
    await page.screenshot({ path: testInfo.outputPath('01-aceitar.png'), fullPage: true });
  });

  test('alt 1: Negar sem motivo fica bloqueado (nem só espaços vale) e nada é gravado; com motivo, vira Negado', async ({ page }, testInfo) => {
    await abrirTela(page);
    const post = page.getByTestId(`pedido-post-${negar}`);
    await post.getByTestId('pedido-negar').click();
    const confirmar = page.getByTestId('decisao-confirmar');
    await expect(page.getByTestId('decisao-modal')).toBeVisible();
    await expect(confirmar).toBeDisabled();
    const campo = page.getByTestId('decisao-texto');
    await campo.click();
    await expect(campo).toBeFocused();
    await page.keyboard.type('   ');
    await expect(confirmar).toBeDisabled();
    expect(contarEventos(sqlViaDocker, negar)).toBe(0);
    await page.keyboard.type('fora do escopo');
    await expect(campo).toHaveValue('   fora do escopo');
    await expect(confirmar).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('02-negar-modal.png') });
    await confirmar.click();
    await expect(post.getByTestId('pedido-status')).toHaveText('Negado', { timeout: 20_000 });
    await expect(page.getByTestId('decisao-modal')).toHaveCount(0);
    await post.getByTestId('pedido-toggle').click();
    await expect(post.getByTestId('pedido-eventos')).toContainText('fora do escopo');
    expect(contarEventos(sqlViaDocker, negar)).toBe(1);
    expect(ultimoEvento(sqlViaDocker, negar)).toBe(`negar|${STAFF.uid}|humano`);
  });

  test('alt 2: Descrever o que fazer exige comentário, redireciona o pedido e os botões continuam', async ({ page }) => {
    await abrirTela(page);
    const post = page.getByTestId(`pedido-post-${descrever}`);
    await post.getByTestId('pedido-descrever').click();
    await expect(page.getByTestId('decisao-confirmar')).toBeDisabled();
    const campo = page.getByTestId('decisao-texto');
    await campo.click();
    await expect(campo).toBeFocused();
    await page.keyboard.type('tente o degrau 2 com a plantilla aprovada');
    await page.getByTestId('decisao-confirmar').click();
    await expect(post.getByTestId('pedido-status')).toHaveText('Redirigido', { timeout: 20_000 });
    await post.getByTestId('pedido-toggle').click();
    await expect(post.getByTestId('pedido-eventos')).toContainText('tente o degrau 2');
    await expect(post.getByTestId('pedido-aceitar')).toBeVisible();
    expect(contarEventos(sqlViaDocker, descrever)).toBe(1);
    expect(ultimoEvento(sqlViaDocker, descrever)).toBe(`descrever|${STAFF.uid}|humano`);
  });

  for (const largura of [1280, 390]) {
    test(`visual ${largura}px: sem rolagem horizontal e nenhum texto abaixo de 7:1`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: largura, height: 900 });
      await abrirTela(page);
      await page.getByTestId(`pedido-post-${descrever}`).getByTestId('pedido-toggle').click();
      const sobra = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(sobra).toBeLessThanOrEqual(0);
      const violacoes = await scanContrastViolations(page.getByTestId('pedidos-ia-page'), 7);
      expect(violacoes, JSON.stringify(violacoes)).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`03-visual-${largura}.png`), fullPage: true });
    });
  }
});
