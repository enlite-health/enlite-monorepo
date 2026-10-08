/**
 * lista-vacantes-046-ordenacao.integration.e2e.ts @integration
 *
 * Spec 046 F4 — a lista de Vacantes ordena pelo cabeçalho. Stack real (Vite + API do docker com
 * USE_MOCK_AUTH + Postgres); sem `page.route` e sem nada de WhatsApp/Google/Ana Care — a identidade
 * entra por `loginAs` (mock token), como os irmãos. O banco do CI é compartilhado: toda asserção
 * fica restrita às vagas semeadas aqui, isoladas pela BUSCA (título com marcador único).
 *
 *   feliz — A14: clica em "Completado" e lê a ORDEM REAL das linhas (asc, depois desc).
 *   alt 1 — A15: clica em "Caso" e "Status" -> nenhuma requisição nova de lista, nenhum ícone.
 *   alt 2 — A16: na página 3, ordenar volta para a página 1.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { seedVacancyWithCards } from '../helpers/funnel-move-e2e-helper';
import { loginAs, type MockUser } from '../helpers/abac-stack-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-046-f4-ordenacao',
  email: 'staff.046.f4.ordenacao@e2e.test',
  role: 'admin',
  country: 'AR',
};

const MARCA_ORDEM = 'ORD046F4A';
const MARCA_PAGINA = 'ORD046F4B';
const TOTAL_PAGINADAS = 23; // com 10 por página (escolhido na UI) -> página 3 existe (21–23)

/** Contagens de "Completado" semeadas, em ordem de criação (embaralhadas de propósito). */
const COMPLETADOS = [2, 0, 3, 1];

test.describe('046 F4 — ordenação pelo cabeçalho @integration', () => {
  test.use({ viewport: { width: 1366, height: 768 }, locale: 'es-AR' });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  const seeds: Array<{ cleanup: () => void }> = [];
  let pagPatientId = '';

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Staff 046 F4');

    for (const n of COMPLETADOS) {
      const seed = seedVacancyWithCards(Array.from({ length: n }, () => ({ stage: 'COMPLETED' })));
      runSQL(`UPDATE job_postings SET title = '${MARCA_ORDEM}-${n}' WHERE id = '${seed.vacancyId}'`);
      seeds.push(seed);
    }

    const { patientId, addressId } = insertTestPatient({ withAddress: true, firstName: 'Ord046', lastName: `Pag-${Date.now()}` });
    pagPatientId = patientId;
    for (let i = 0; i < TOTAL_PAGINADAS; i++) {
      const id = insertBaseVacancy({ patientId, patientAddressId: addressId!, caseNumber: 947000 + i, status: 'SEARCHING', isDraft: false });
      runSQL(`UPDATE job_postings SET title = '${MARCA_PAGINA}-${i}' WHERE id = '${id}'`);
    }
  });

  test.afterAll(() => {
    for (const s of seeds) {
      try { s.cleanup(); } catch (e) { console.error('[cleanup] semente', e); }
    }
    try { if (pagPatientId) cleanupTestPatient(pagPatientId); } catch (e) { console.error('[cleanup] paciente', e); }
    try { cleanupMockStaff(MOCK_STAFF); } catch (e) { console.error('[cleanup] staff', e); }
  });

  /** Requisições de LISTA (não conta filter-options nem stats). */
  function contaListas(page: Page): { urls: string[] } {
    const urls: string[] = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.pathname === '/api/admin/vacancies') urls.push(req.url());
    });
    return { urls };
  }

  async function abreEBusca(page: Page, marca: string) {
    await loginAs(page, MOCK_STAFF);
    await page.goto('/admin/vacancies');
    const busca = page.getByPlaceholder(/Buscar/).first();
    await busca.click();
    await busca.pressSequentially(marca, { delay: 30 });
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 15_000 });
  }

  const completados = (page: Page) => page.locator('tbody tr [data-testid$="-stage-COMPLETED"]').allTextContents();
  const cabecalho = (page: Page, col: string) => page.getByTestId(`vacancies-col-${col}`);

  test('feliz (A14): clique em Completado ordena as linhas desc (maior para o menor) e, no 2º clique, asc', async ({ page }) => {
    const listas = contaListas(page);
    await abreEBusca(page, MARCA_ORDEM);
    await expect.poll(() => completados(page)).toHaveLength(COMPLETADOS.length);

    const th = cabecalho(page, 'COMPLETED');
    await expect(th).toHaveAttribute('aria-sort', 'none');
    await expect(th.locator('[data-sort-icon]')).toHaveCount(0);

    await th.getByRole('button').click();
    await expect(th).toHaveAttribute('aria-sort', 'descending');
    await expect(th.locator('[data-sort-icon="desc"]')).toBeVisible();
    await expect.poll(() => completados(page)).toEqual(['03', '02', '01', '00']);
    expect(listas.urls[listas.urls.length - 1]).toContain('sort=completed&order=desc');

    await th.getByRole('button').click();
    await expect(th).toHaveAttribute('aria-sort', 'ascending');
    await expect(th.locator('[data-sort-icon="asc"]')).toBeVisible();
    await expect.poll(() => completados(page)).toEqual(['00', '01', '02', '03']);
    expect(listas.urls[listas.urls.length - 1]).toContain('sort=completed&order=asc');
  });

  test('alt 1 (A15): clicar em Caso e Status não faz nada (sem requisição, sem ícone)', async ({ page }) => {
    const listas = contaListas(page);
    await abreEBusca(page, MARCA_ORDEM);
    await expect.poll(() => completados(page)).toHaveLength(COMPLETADOS.length);
    await page.waitForTimeout(1000); // deixa assentar qualquer requisição em voo da digitação
    const antes = listas.urls.length;
    const ordemAntes = await completados(page);

    for (const col of ['case', 'status']) {
      await cabecalho(page, col).click();
      await expect(cabecalho(page, col).getByRole('button')).toHaveCount(0);
    }
    await page.waitForTimeout(1000);

    expect(listas.urls.length).toBe(antes);
    expect(await completados(page)).toEqual(ordemAntes);
    await expect(page.locator('thead [data-sort-icon]')).toHaveCount(0);
  });

  test('alt 2 (A16): na página 3, ordenar volta para a página 1', async ({ page }) => {
    await abreEBusca(page, MARCA_PAGINA);
    // A tela abre com 20 por página (useState('20')): com 23 vagas só haveria 2 páginas.
    // Escolhe o menor "itens por página" (10) pelo seletor da tela, como o usuário.
    const itensPorPagina = page.locator('select', { has: page.locator('option[value="50"]') });
    await itensPorPagina.selectOption('10');
    await expect(itensPorPagina).toHaveValue('10');
    await expect(page.getByText(/^1–10 de 23$/)).toBeVisible({ timeout: 15_000 });

    const proxima = page.getByRole('button', { name: 'Página siguiente' });
    await proxima.click();
    await expect(page.getByText(/^11–20 de 23$/)).toBeVisible();
    await proxima.click();
    await expect(page.getByText(/^21–23 de 23$/)).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(3);

    await cabecalho(page, 'INVITED').getByRole('button').click();
    await expect(page.getByText(/^1–10 de 23$/)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await expect(cabecalho(page, 'INVITED')).toHaveAttribute('aria-sort', 'descending');
  });

  test('teclado (A18): Enter e Espaço no botão do cabeçalho ordenam', async ({ page }) => {
    await abreEBusca(page, MARCA_ORDEM);
    await expect.poll(() => completados(page)).toHaveLength(COMPLETADOS.length);
    const botao = cabecalho(page, 'COMPLETED').getByRole('button');
    await botao.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => completados(page)).toEqual(['03', '02', '01', '00']);
    await page.keyboard.press('Space');
    await expect.poll(() => completados(page)).toEqual(['00', '01', '02', '03']);
  });
});
