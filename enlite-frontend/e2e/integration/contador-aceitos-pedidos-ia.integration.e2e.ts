/**
 * contador-aceitos-pedidos-ia.integration.e2e.ts @integration — spec 081 F4 (T098, D601): os dois contadores de
 * "aceita sin contestar" no topo de `/admin/pedidos-ia`.
 *
 * E2E DE TELA: navegador real -> API real -> Postgres real, login MOCK do stack de CI (`loginComoStaffMock`: click + `keyboard.type`),
 * engine ABAC desligado (as rotas caem no papel ADMIN). Massa SINTÉTICA por SQL, datas relativas a now() — ver a TABELA em
 * `helpers/pedidos-ia-contador-seed.ts` (11 pedidos, 10 na janela de 28 semanas + 1 FORA, 3 semanas de contestação/validade).
 *
 * NÚMEROS ESPERADOS na tela (lidos do DOM; a massa é a do helper):
 *   contador 1: semanas "2" · "2 de 4 semanas seguidas" · "Todavía no alcanzó la regla" (data-atingiu=false) ·
 *               "Última contestación: semana del <segunda da semana -8>" · "Pedidos: 7" · "Pendientes: 1"
 *   contador 2: semanas "1" · "1 de 26 semanas seguidas" · "Sin contestaciones" · "Pedidos: 3" · "Pendientes: 0"
 *   (o pedido FORA, 30 semanas atrás, é uma contestação: se a janela o incluísse, o contador 2 cairia a 0 e teria "última contestación".)
 *
 *  feliz  — a massa vira os números acima; o bloco está ACIMA da lista de pedidos.
 *  alt 1  — janela sem pedidos com origem: "0" nos dois, estado vazio visível, sem régua/percentual e sem erro.
 *  alt 2  — MUDANÇA REAL DE ESTADO pela tela: massa com 3 semanas válidas + 1 pedido PENDENTE da semana -5 (tabela em `MASSA_NEGAR`);
 *           ANTES: contador 1 = "3 de 4", "Sin contestaciones", Pendientes: 1 · o humano acha o pedido na lista, clica Negar, digita o motivo
 *           (click + `keyboard.type`) e confirma · recarrega · DEPOIS: "0 de 4", "Última contestación: semana del <segunda da semana -5>",
 *           Pendientes: 0, Pedidos: 7 (o 1º evento `negar` vira contestação na semana e ZERA a sequência). Nada é interceptado nem mockado.
 *
 * ISOLAMENTO entre os testes (serial): `beforeEach` apaga a rodada (`limparMassaContador`, pela marca única TAG) -> cada teste semeia o
 * que precisa e o `afterAll` apaga de novo. O alt 1 ainda CONFERE por SQL que nenhuma outra rodada deixou pedido com origem na janela
 * (se deixou, falha com a contagem — não finge janela vazia). Pedidos sem origem (os do spec irmão) nunca entram nos contadores.
 *
 * Escrito para o job padrão do CI (`pr-gate.yml`, `grep:` — casa `pedidos-ia\.integration`). Quem prova que PASSA é o CI.
 */
import { test, expect, type Page } from '@playwright/test';
import { escolherNoCombo } from '../helpers/combobox';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';
import { contarEventos, sqlViaDocker, ultimoEvento } from '../helpers/pedidos-ia-seed';
import {
  contarPedidosNaJanela, ESPERADO, ESPERADO_NEGAR, limparMassaContador, seedMassaContador, seedMassaNegar, segundaBA,
} from '../helpers/pedidos-ia-contador-seed';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const TAG = `ar-ctr-${RUN}`;
const STAFF: MockUser = { uid: `e2e-ctr-${RUN}`, email: `ctr.${RUN}@e2e.test`, role: 'admin', country: 'AR' };

/** Login (click + teclado) + abre a tela. */
async function abrirTela(page: Page): Promise<void> {
  await loginComoStaffMock(page, STAFF, 'E2E Contador');
  await page.goto('/admin/pedidos-ia');
  await expect(page.getByTestId('pedidos-ia-page')).toBeVisible({ timeout: 30_000 });
}

test.describe('pedidos-ia 081 — contadores de aceitos sem contestar @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeEach(() => limparMassaContador(sqlViaDocker, TAG));
  test.afterAll(() => limparMassaContador(sqlViaDocker, TAG));

  test('feliz: a massa sintética aparece como os números esperados dos dois contadores, acima da lista', async ({ page }, testInfo) => {
    seedMassaContador(sqlViaDocker, TAG);
    await abrirTela(page);
    const bloco = page.getByTestId('contador-aceitos');
    await expect(bloco).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('contador-aceitos-erro')).toHaveCount(0);

    const c1 = page.getByTestId('contador-1');
    await expect(c1).toBeVisible();
    await expect(page.getByTestId('contador-1-semanas')).toHaveText(ESPERADO.c1.semanas);
    await expect(page.getByTestId('contador-1-regua')).toHaveText(ESPERADO.c1.regua);
    await expect(c1).toHaveAttribute('data-atingiu', 'false');
    await expect(page.getByTestId('contador-1-atingiu')).toHaveText('Todavía no alcanzó la regla');
    await expect(page.getByTestId('contador-1-ultima-contestacao')).toHaveText(`Última contestación: semana del ${segundaBA(ESPERADO.c1.ultimaSemanasAtras)}`);
    await expect(page.getByTestId('contador-1-pedidos')).toHaveText(ESPERADO.c1.pedidos);
    await expect(page.getByTestId('contador-1-pendentes')).toHaveText(ESPERADO.c1.pendentes);
    await expect(page.getByTestId('contador-1-vazio')).toHaveCount(0);

    const c2 = page.getByTestId('contador-2');
    await expect(c2).toBeVisible();
    await expect(page.getByTestId('contador-2-semanas')).toHaveText(ESPERADO.c2.semanas);
    await expect(page.getByTestId('contador-2-regua')).toHaveText(ESPERADO.c2.regua);
    await expect(c2).toHaveAttribute('data-atingiu', 'false');
    await expect(page.getByTestId('contador-2-ultima-contestacao')).toHaveText(ESPERADO.c2.ultima); // o FORA (30 sem.) não entrou
    await expect(page.getByTestId('contador-2-pedidos')).toHaveText(ESPERADO.c2.pedidos);
    await expect(page.getByTestId('contador-2-pendentes')).toHaveText(ESPERADO.c2.pendentes);

    // Posição: o bloco fica ACIMA da lista de pedidos (e dos filtros que a governam).
    await expect(page.getByTestId('pedidos-lista')).toBeVisible({ timeout: 30_000 });
    const yBloco = (await bloco.boundingBox())?.y ?? Number.POSITIVE_INFINITY;
    const yLista = (await page.getByTestId('pedidos-lista').boundingBox())?.y ?? Number.NEGATIVE_INFINITY;
    expect(yBloco).toBeLessThan(yLista);
    await page.screenshot({ path: testInfo.outputPath('01-contadores.png'), fullPage: true });
  });

  test('alt 1: sem pedidos na janela mostra "0" nos dois, estado vazio, sem percentual e sem erro', async ({ page }) => {
    // Isolamento: a rodada foi apagada no beforeEach; nenhuma OUTRA rodada pode ter deixado pedido com origem na janela.
    expect(contarPedidosNaJanela(sqlViaDocker), 'sobrou pedido com origem na janela (outra rodada) — alt 1 não é medível').toBe(0);
    await abrirTela(page);
    await expect(page.getByTestId('contador-aceitos')).toBeVisible({ timeout: 30_000 });
    for (const n of [1, 2]) {
      await expect(page.getByTestId(`contador-${n}`)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(`contador-${n}-semanas`)).toHaveText('0');
      await expect(page.getByTestId(`contador-${n}-vazio`)).toBeVisible();
      await expect(page.getByTestId(`contador-${n}-vazio`)).toHaveText('Sin pedidos en el período.');
      await expect(page.getByTestId(`contador-${n}-regua`)).toHaveCount(0);
      await expect(page.getByTestId(`contador-${n}-atingiu`)).toHaveCount(0);
      await expect(page.getByTestId(`contador-${n}-pedidos`)).toHaveCount(0);
    }
    await expect(page.getByTestId('contador-aceitos-erro')).toHaveCount(0);
    expect(await page.getByTestId('contador-aceitos').innerText()).not.toContain('%'); // sem percentual
  });

  test('alt 2: negar pela tela o pedido pendente da sequência derruba o contador 1 a 0 e a última contestação passa a ser a semana dele', async ({ page }) => {
    const pendente = seedMassaNegar(sqlViaDocker, TAG); // ver a TABELA em MASSA_NEGAR: 3 semanas válidas + 1 pedido pendente na semana -5
    await abrirTela(page);
    await escolherNoCombo(page, page.getByTestId('pedidos-filtro-area'), TAG);

    // ANTES (lido da tela): 3 de 4, sem contestação, 1 pendente.
    await expect(page.getByTestId('contador-1-semanas')).toHaveText(ESPERADO_NEGAR.antes.semanas, { timeout: 30_000 });
    await expect(page.getByTestId('contador-1-regua')).toHaveText(ESPERADO_NEGAR.antes.regua);
    await expect(page.getByTestId('contador-1-ultima-contestacao')).toHaveText(ESPERADO_NEGAR.antes.ultima);
    await expect(page.getByTestId('contador-1-pedidos')).toHaveText(ESPERADO_NEGAR.antes.pedidos);
    await expect(page.getByTestId('contador-1-pendentes')).toHaveText(ESPERADO_NEGAR.antes.pendentes);
    await expect(page.getByTestId('contador-2-vazio')).toBeVisible();

    // Decisão HUMANA pela tela: achar o pedido na lista, Negar, motivo por teclado, confirmar.
    const post = page.getByTestId(`pedido-post-${pendente}`);
    await expect(post).toBeVisible();
    await expect(post.getByTestId('pedido-status')).toHaveText('Nuevo');
    await post.getByTestId('pedido-negar').click();
    const campo = page.getByTestId('decisao-texto');
    await campo.click();
    await expect(campo).toBeFocused();
    await page.keyboard.type('motivo sintetico do alt 2');
    await expect(campo).toHaveValue('motivo sintetico do alt 2');
    await page.getByTestId('decisao-confirmar').click();
    await expect(post.getByTestId('pedido-status')).toHaveText('Negado', { timeout: 20_000 });
    expect(contarEventos(sqlViaDocker, pendente)).toBe(1);
    expect(ultimoEvento(sqlViaDocker, pendente)).toBe(`negar|${STAFF.uid}|humano`);

    // DEPOIS de recarregar: o contador 1 zerou e a última contestação é a semana do pedido negado.
    await page.reload();
    await expect(page.getByTestId('pedidos-ia-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('contador-1-semanas')).toHaveText(ESPERADO_NEGAR.depois.semanas, { timeout: 30_000 });
    await expect(page.getByTestId('contador-1-regua')).toHaveText(ESPERADO_NEGAR.depois.regua);
    await expect(page.getByTestId('contador-1')).toHaveAttribute('data-atingiu', 'false');
    await expect(page.getByTestId('contador-1-ultima-contestacao')).toHaveText(
      `Última contestación: semana del ${segundaBA(ESPERADO_NEGAR.depois.ultimaSemanasAtras)}`,
    );
    await expect(page.getByTestId('contador-1-pedidos')).toHaveText(ESPERADO_NEGAR.depois.pedidos);
    await expect(page.getByTestId('contador-1-pendentes')).toHaveText(ESPERADO_NEGAR.depois.pendentes);
    await expect(page.getByTestId('contador-aceitos-erro')).toHaveCount(0);
  });
});
