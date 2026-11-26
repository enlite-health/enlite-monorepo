/**
 * semaforo-da-vaga-humano.integration.e2e.ts @integration — change semaforo-da-vaga, F3 (D811, P1/P2/P4): o círculo e o filtro por cor
 * na LISTA DE VAGAS e no KANBAN DE PACIENTES, lidos da tela.
 *
 * E2E DE TELA, sem mock de resposta (nenhum `page.route` de dado; o único swap é o token do `loginAs`): frontend + API + Postgres
 * reais, engine OFF, clique e teclado de humano, valor lido do DOM. SQL só MONTA o cenário. Nada aqui toca canal real
 * (nenhum Talentum/WhatsApp/Ana Care: `activate-recruitment` só cria o rascunho da vaga).
 *
 * Massa: 10 prestadores aptos (a mesma pessoa pode estar em vagas diferentes, mas UMA vez por vaga).
 *   vaga R: 2 em Seleccionado/Respuesta rápida  → n=2  → vermelha
 *   vaga Y: 9 em Seleccionado/Respuesta rápida + 1 em Completado (apto) → n=9  → amarela
 *   vaga G: 10 em Seleccionado/Respuesta rápida → n=10 → verde
 *   paciente P: serviço 1 (vaga com 10 em Seleccionado → verde) e serviço 2 (vaga sem ninguém → vermelha)
 *
 *  FELIZ — a lista mostra o círculo certo e o n em cada uma das 3 vagas semeadas; o filtro "Verde" (clique) deixa só a verde.
 *  ALT 1 — no Kanban de pacientes, P (serviços verde e vermelho) mostra 🔴 no card (a PIOR cor) e os dois círculos nos subcards;
 *          o filtro "Rojo" o mantém e "Verde" o tira (o filtro olha a pior cor, nunca o primeiro serviço).
 *  ALT 2 — no funil da vaga Y, mover o prestador de Completado para Seleccionado (menu "Mover a…", clique e TECLADO) e, ao
 *          voltar à lista, a vaga de 9 (amarela) vira 10 (verde).
 */
import { test, expect, type Page } from '@playwright/test';
import { insertAptoWorker } from '../helpers/eligibility-worker-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { criarVagas, candidatar, limparMassa, novaMassa } from '../helpers/bloqueados-067-helper';
import { insertWJA, upsertEncuadre } from '../helpers/wja-test-helper';
import { gotoVacancyDetail } from '../helpers/compativeis-e2e-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import {
  LANCAMENTO_VIEWPORT_ES_AR,
  mockAdminUserFor,
  useLancamentoStaff,
  seedLaunchablePatient,
  type SeedLaunchablePatientResult,
} from '../helpers/lancamento-e2e-helper';
import { activateRecruitmentViaApi, createServiceViaApi, cleanupItinerary } from '../helpers/itinerario-e2e-helper';
import { openPatientKanban } from '../helpers/kanban-subcard-e2e-helper';

const RUN = Date.now().toString(36).toUpperCase();
const MARCA = `SEM${RUN}`;
const STAFF = mockAdminUserFor('semaforo-humano');
const massa = novaMassa();
const workers: string[] = [];
let vagas: string[] = []; // [R, Y, G]
let wjaCompletado = ''; // o card de Completado da vaga Y (o que o alt 2 move)
let paciente: SeedLaunchablePatientResult | null = null;
let servicoVerde = '';
let servicoVermelho = '';
let vagaDoServicoVerde = '';

const dotDe = (page: Page, vagaId: string) => page.getByTestId(`vacancies-row-${vagaId}-semaphore`).getByTestId('vacancy-semaphore-dot');

/** Abre a lista, busca pelo marcador (digitando) e espera as 3 linhas da massa. */
async function abrirListaEBuscar(page: Page): Promise<void> {
  await page.goto('/admin/vacancies');
  const busca = page.getByPlaceholder(/Buscar/).first();
  await busca.click();
  await busca.pressSequentially(MARCA, { delay: 30 });
  await expect(page.locator('tbody tr[data-testid^="vacancy-row-"]')).toHaveCount(3, { timeout: 20_000 });
}

/** Escolhe uma cor no combobox de filtro como humano: clica o gatilho e clica a opção pelo rótulo. */
async function escolherCor(page: Page, gatilho: ReturnType<Page['getByTestId']>, rotulo: string): Promise<void> {
  if ((await gatilho.getAttribute('aria-expanded')) !== 'true') await gatilho.click(); // multi: o painel pode ficar aberto
  await page.getByRole('option', { name: rotulo }).locator('button').click();
}

test.use({ video: 'on' });

test.describe('semáforo da vaga — lista de vagas e Kanban de pacientes (F3) @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, viewport: { width: 1600, height: 900 } });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  useLancamentoStaff(STAFF, 'E2E Semaforo Humano');

  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000);
    vagas = criarVagas(massa, 3, MARCA);
    const [vagaR, vagaY, vagaG] = vagas;
    for (let i = 0; i < 10; i++) {
      const w = insertAptoWorker({ docs: 'validated' });
      massa.workerIds.push(w.workerId);
      workers.push(w.workerId);
    }
    const ocupa = (i: number) => (i % 2 === 0 ? 'SELECTED' : 'QUICK_RESPONSE_TEAM'); // as DUAS colunas contam para o n
    workers.slice(0, 2).forEach((w, i) => candidatar(w, vagaR, ocupa(i)));
    workers.slice(0, 9).forEach((w, i) => candidatar(w, vagaY, ocupa(i)));
    wjaCompletado = insertWJA({ workerId: workers[9], jobPostingId: vagaY, funnelStage: 'COMPLETED', source: 'system' });
    upsertEncuadre({ workerId: workers[9], jobPostingId: vagaY });
    workers.forEach((w, i) => candidatar(w, vagaG, ocupa(i)));

    // Paciente com 2 serviços: o 1º (verde: a vaga dele tem os 10 prestadores) e o 2º (vermelho: vaga sem ninguém).
    paciente = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -53.81, lng: -67.81 });
    servicoVerde = paciente.serviceId;
    servicoVermelho = await createServiceViaApi(request, paciente.patientId, {
      addressId: paciente.addressId,
      schedule: [{ dayOfWeek: 3, startTime: '08:00', durationMinutes: 240 }], // o 1º serviço usa a segunda; sem horário o foguete recusa (SERVICE_SCHEDULE)
    });
    vagaDoServicoVerde = await activateRecruitmentViaApi(request, paciente.patientId, servicoVerde);
    await activateRecruitmentViaApi(request, paciente.patientId, servicoVermelho);
    workers.forEach((w, i) => candidatar(w, vagaDoServicoVerde, ocupa(i)));
  });

  test.afterAll(() => {
    if (paciente) {
      runSQL(`DELETE FROM worker_job_applications WHERE job_posting_id = '${vagaDoServicoVerde}'`);
      cleanupItinerary(paciente.patientId);
      paciente.cleanup();
    }
    limparMassa(massa);
  });

  test('FELIZ — a lista mostra o círculo e o n certos nas 3 vagas; o filtro "Verde" deixa só a verde', async ({ page }) => {
    await loginAs(page, STAFF);
    await abrirListaEBuscar(page);
    const [vagaR, vagaY, vagaG] = vagas;

    for (const [vaga, cor, n] of [[vagaR, 'red', '2'], [vagaY, 'yellow', '9'], [vagaG, 'green', '10']] as const) {
      await expect(dotDe(page, vaga)).toHaveAttribute('data-color', cor);
      await expect(page.getByTestId(`vacancies-row-${vaga}-semaphore`)).toHaveText(n);
    }
    await expect(page.getByTestId('vacancies-col-semaphore')).toHaveText('Semáforo');
    await expect(page.getByTestId('vacancies-col-semaphore')).toHaveScreenshot('semaforo-feliz-cabecalho.png', { maxDiffPixelRatio: 0.05 });

    // O filtro: clique no gatilho, clique em "Verde"; a requisição leva `semaphore=green` e só a vaga verde fica.
    const pedido = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/admin/vacancies' && new URL(r.url()).searchParams.get('semaphore') === 'green');
    await escolherCor(page, page.getByTestId('vacancy-filter-semaphore'), 'Verde');
    await pedido;
    await expect(page.locator('tbody tr[data-testid^="vacancy-row-"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId(`vacancy-row-${vagaG}`)).toBeVisible();
    await expect(dotDe(page, vagaG)).toHaveAttribute('data-color', 'green');
    await expect(dotDe(page, vagaG)).toHaveScreenshot('semaforo-feliz-filtro-verde.png', { maxDiffPixelRatio: 0.05 });
  });

  test('ALT 1 — no Kanban de pacientes, o card mostra a PIOR cor, os subcards a de cada serviço, e o filtro "Rojo" mantém / "Verde" tira o paciente', async ({ page }) => {
    const { patientId } = paciente!;
    await loginAs(page, STAFF);
    await openPatientKanban(page);

    const card = page.getByTestId(`patient-kanban-card-${patientId}`);
    await card.scrollIntoViewIfNeeded();
    await expect(page.getByTestId(`patient-kanban-card-${patientId}-semaphore`)).toHaveAttribute('data-color', 'red');
    const subVerde = card.locator(`[data-testid="patient-kanban-subcard"][data-service-id="${servicoVerde}"]`).getByTestId('patient-kanban-subcard-semaphore');
    const subVermelho = card.locator(`[data-testid="patient-kanban-subcard"][data-service-id="${servicoVermelho}"]`).getByTestId('patient-kanban-subcard-semaphore');
    await expect(subVerde).toHaveAttribute('data-color', 'green');
    await expect(subVerde).toHaveText('10');
    await expect(subVermelho).toHaveAttribute('data-color', 'red');
    await expect(subVermelho).toHaveText('0');
    await expect(card).toHaveScreenshot('semaforo-alt1-card.png', {
      mask: [card.getByTestId(`patient-kanban-card-${patientId}-open`), card.locator('span', { hasText: /^Caso #/ })],
      maxDiffPixelRatio: 0.05,
    });

    const filtro = page.getByTestId('patient-semaphore-filter').getByRole('combobox');
    await escolherCor(page, filtro, 'Rojo');
    await expect(card).toBeVisible(); // a pior cor do paciente é vermelha
    await escolherCor(page, filtro, 'Verde'); // multi: Rojo + Verde → ainda aparece
    await expect(card).toBeVisible();
    await escolherCor(page, filtro, 'Rojo'); // tira o Rojo: sobra só "Verde"
    await expect(card).toHaveCount(0); // o serviço 1 é verde, mas a pior cor do paciente não é: o filtro não olha o 1º serviço
  });

  test('ALT 2 — mover 1 prestador de Completado para Seleccionado (clique e teclado) faz a vaga de 9 virar 10 e verde na lista', async ({ page }) => {
    await loginAs(page, STAFF);
    const vagaY = vagas[1];
    await abrirListaEBuscar(page);
    await expect(dotDe(page, vagaY)).toHaveAttribute('data-color', 'yellow');
    await expect(page.getByTestId(`vacancies-row-${vagaY}-semaphore`)).toHaveText('9');

    await gotoVacancyDetail(page, vagaY);
    const cartao = page.getByTestId(`kanban-card-${wjaCompletado}`);
    await expect(cartao).toBeVisible();
    await cartao.getByTestId('move-to-button').click();
    await expect(page.getByTestId('move-to-menu')).toBeVisible();
    await page.keyboard.press('Tab'); // 1ª opção: Invitados
    await page.keyboard.press('Tab'); // 2ª opção: Seleccionado
    await expect(cartao.getByTestId('move-to-option-SELECTED')).toBeFocused();
    await page.keyboard.press('Enter');
    // Seleccionado pede o papel do prestador (modal): escolhe Titular e confirma, por clique.
    await expect(page.getByTestId('role-modal')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('role-option-titular').getByRole('radio').click();
    const [put] = await Promise.all([
      page.waitForResponse((r) => /\/move$/.test(r.url()) && r.request().method() === 'PUT'),
      page.getByTestId('role-confirm').click(),
    ]);
    expect(put.ok(), `PUT move deveria ser 2xx, veio ${put.status()}`).toBe(true);

    await abrirListaEBuscar(page);
    await expect(dotDe(page, vagaY)).toHaveAttribute('data-color', 'green');
    await expect(page.getByTestId(`vacancies-row-${vagaY}-semaphore`)).toHaveText('10');
    await expect(dotDe(page, vagaY)).toHaveScreenshot('semaforo-alt2-circulo-verde.png', { maxDiffPixelRatio: 0.05 });
  });
});
