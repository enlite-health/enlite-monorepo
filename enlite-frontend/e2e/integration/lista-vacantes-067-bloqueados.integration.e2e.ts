/**
 * lista-vacantes-067-bloqueados.integration.e2e.ts @integration — spec 067 (FR-08): a coluna e a ORDENAÇÃO "Bloqueados" da lista de vagas do admin.
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais (USE_MOCK_AUTH=true), engine OFF, clique de humano. SQL só MONTA o
 * cenário (3 vagas, prestadores, candidaturas em Completado). O banco do CI é compartilhado: toda asserção fica restrita às vagas semeadas
 * aqui, isoladas pela BUSCA (título com marcador único), como `lista-vacantes-046-ordenacao`.
 *
 *  Massa (marcador B067): vaga 0 = 2 prestadores NÃO aptos em Completado; vaga 1 = 1 não apto; vaga 2 = 1 APTO (nenhum bloqueado).
 *  FELIZ — a coluna Bloqueados mostra a contagem certa por vaga ("02", "01", "00") e Completado não conta os não aptos.
 *  ALT 1 — clicar no cabeçalho "Bloqueados" ORDENA as linhas (desc: 02, 01, 00; 2º clique: asc), com a requisição `sort=bloqueados`.
 *  ALT 2 — a vaga sem bloqueados mostra "00" (nunca célula vazia); depois que o admin valida os documentos na ficha (clique), a vaga
 *          de 1 bloqueado também passa a "00" e o Completado dela sobe a "01" (o inverso).
 *
 * Outbound: nada (validar documento não envia). Dados SINTÉTICOS (@test.local), sem PII.
 * Pré-condições: API em localhost:8080 (USE_MOCK_AUTH=true), Vite em localhost:5173, Postgres no contêiner `E2E_PG_CONTAINER`.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertAptoWorker } from '../helpers/eligibility-worker-helper';
import { loginAs, type MockUser } from '../helpers/abac-stack-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import { criarVagas, candidatar, limparMassa, novaMassa, validarOsDoisDocumentos } from '../helpers/bloqueados-067-helper';

const RUN = Date.now().toString(36).toUpperCase();
const MARCA = `B067${RUN}`;
const STAFF: MockUser = { uid: `e2e-int-lista-bloq-067-${RUN}`, email: `lista.bloq.067.${RUN}@e2e.test`, role: 'admin', country: 'AR' };
const massa = novaMassa();
let vagas: string[] = [];
let workerDaVaga1 = '';

const lista = {
  bloqueados: (page: Page) => page.locator('tbody tr [data-testid$="-stage-BLOQUEADO"]').allTextContents(),
  completados: (page: Page) => page.locator('tbody tr [data-testid$="-stage-COMPLETED"]').allTextContents(),
  celula: (page: Page, vaga: string, col: 'BLOQUEADO' | 'COMPLETED') => page.getByTestId(`vacancy-row-${vaga}-stage-${col}`),
  cabecalho: (page: Page) => page.getByTestId('vacancies-col-BLOQUEADO'),
};

/** Abre a lista, busca pelo marcador (digitando) e espera as 3 linhas da massa. */
async function abrirEBuscar(page: Page): Promise<void> {
  await loginAs(page, STAFF);
  await page.goto('/admin/vacancies');
  const busca = page.getByPlaceholder(/Buscar/).first();
  await busca.click();
  await busca.pressSequentially(MARCA, { delay: 30 });
  await expect.poll(() => lista.bloqueados(page), { timeout: 20_000 }).toHaveLength(3);
}

test.describe('Lista de vagas — coluna e ordenação Bloqueados (spec 067) @integration', () => {
  test.use({ viewport: { width: 1600, height: 900 }, locale: 'es-AR' });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(150_000);

  test.beforeAll(() => {
    seedMockStaff(STAFF, 'E2E Lista Bloq 067');
    vagas = criarVagas(massa, 3, MARCA);
    const novoPrestador = (docs: 'validated' | 'unvalidated') => {
      const w = insertAptoWorker({ docs });
      massa.workerIds.push(w.workerId);
      return w.workerId;
    };
    candidatar(novoPrestador('unvalidated'), vagas[0], 'QUALIFIED');
    candidatar(novoPrestador('unvalidated'), vagas[0], 'COMPLETED');
    workerDaVaga1 = novoPrestador('unvalidated');
    candidatar(workerDaVaga1, vagas[1], 'QUALIFIED');
    candidatar(novoPrestador('validated'), vagas[2], 'QUALIFIED');
  });

  test.afterAll(() => {
    limparMassa(massa);
    cleanupMockStaff(STAFF);
  });

  test('FELIZ — a coluna Bloqueados mostra a contagem certa por vaga e Completado não conta os não aptos', async ({ page }) => {
    await abrirEBuscar(page);
    await expect(lista.celula(page, vagas[0], 'BLOQUEADO')).toHaveText('02');
    await expect(lista.celula(page, vagas[1], 'BLOQUEADO')).toHaveText('01');
    await expect(lista.celula(page, vagas[2], 'BLOQUEADO')).toHaveText('00');
    await expect(lista.celula(page, vagas[0], 'COMPLETED')).toHaveText('00');
    await expect(lista.celula(page, vagas[1], 'COMPLETED')).toHaveText('00');
    await expect(lista.celula(page, vagas[2], 'COMPLETED')).toHaveText('01');
    await expect(lista.cabecalho(page)).toContainText('Bloqueados');
    await expect(page.locator('thead')).toHaveScreenshot('lista-vacantes-067-feliz-cabecalho.png', { maxDiffPixelRatio: 0.05 }); // só o cabeçalho: o corpo carrega nº de caso/datas que variam
  });

  test('ALT 1 — clicar no cabeçalho "Bloqueados" ORDENA as linhas (desc, depois asc) e pede sort=bloqueados ao servidor', async ({ page }) => {
    const pedidos: string[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/admin/vacancies') pedidos.push(r.url()); });
    await abrirEBuscar(page);

    const th = lista.cabecalho(page);
    await expect(th).toHaveAttribute('aria-sort', 'none');
    await th.getByRole('button').click();
    await expect(th).toHaveAttribute('aria-sort', 'descending');
    await expect.poll(() => lista.bloqueados(page)).toEqual(['02', '01', '00']);
    expect(pedidos[pedidos.length - 1]).toContain('sort=bloqueados&order=desc');
    await expect(page.locator('thead')).toHaveScreenshot('lista-vacantes-067-alt1-cabecalho-ordenado-desc.png', { maxDiffPixelRatio: 0.05 });

    await th.getByRole('button').click();
    await expect(th).toHaveAttribute('aria-sort', 'ascending');
    await expect.poll(() => lista.bloqueados(page)).toEqual(['00', '01', '02']);
    expect(pedidos[pedidos.length - 1]).toContain('sort=bloqueados&order=asc');

    // teclado: Enter no botão do cabeçalho volta a ordenar (desc de novo)
    await th.getByRole('button').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => lista.bloqueados(page)).toEqual(['02', '01', '00']);
  });

  test('ALT 2 — a vaga sem bloqueados mostra "00"; validar os documentos na ficha (clique) leva a vaga de 1 bloqueado a "00" e o Completado dela a "01"', async ({ page }) => {
    await abrirEBuscar(page);
    await expect(lista.celula(page, vagas[2], 'BLOQUEADO')).toHaveText('00'); // sem bloqueados: zero escrito, nunca vazio
    await expect(lista.celula(page, vagas[1], 'BLOQUEADO')).toHaveText('01');

    await validarOsDoisDocumentos(page, workerDaVaga1);

    await page.goto('/admin/vacancies');
    const busca = page.getByPlaceholder(/Buscar/).first();
    await busca.click();
    await busca.pressSequentially(MARCA, { delay: 30 });
    await expect(lista.celula(page, vagas[1], 'BLOQUEADO')).toHaveText('00', { timeout: 20_000 });
    await expect(lista.celula(page, vagas[1], 'COMPLETED')).toHaveText('01');
    await expect(lista.celula(page, vagas[0], 'BLOQUEADO')).toHaveText('02'); // a outra vaga não mudou
  });
});
