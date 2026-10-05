/**
 * patient-itinerary-quitar.integration.e2e.ts @integration — Fase 4 da change
 * itinerario-trocas-motivos-e-figma: "Quitar del itinerario" (motivo + destino) pela aba Itinerario,
 * exercitado por um HUMANO contra o stack REAL (frontend + API + Postgres), sem mock de dado de negócio —
 * só a auth é o mock do stack (`loginAs`). Régua humana (memória `e2e-humano-nao-e-fill`): click +
 * `keyboard.type`, valores lidos da TELA; nenhum preenchimento programático de campo. O estado do paciente
 * é lido da API, do banco E da coluna do Kanban na MESMA execução.
 *
 * Side-effect outbound mapeado ANTES de clicar: `RemoveFromItineraryUseCase` → `endWith`, registro de trocas,
 * `rejectWith` e `PatientStatusDerivation` só escrevem em Postgres (nenhum import de Twilio/Periskope/
 * Talentum/Ana Care/ClickUp/e-mail/fila nos 17 arquivos do caminho; os triggers das tabelas escritas não têm
 * `pg_notify`/HTTP). Mesmo assim cada teste registra todo host que a PÁGINA pede e exige que nenhum seja de
 * canal real (`CADEIA_FORBIDDEN_HOSTS`).
 *
 * A semente (paciente derivável, prestador em Selecionado, alocação e montagem) usa os helpers da derivação
 * (API do stack); o que é PROVADO — tirar do itinerário — passa só pela tela.
 *
 * Os 3 testes (o nome do arquivo casa o `--grep patient-itinerary` do job padrão do `pr-gate.yml`):
 *   1. FELIZ — itinerário montado, Ana única → Editar → "Quitar del itinerario" → motivo → "Sigue como reserva"
 *      → Confirmar: horas cobertas 4/4 → 0/4 na tela, estado → Búsqueda (API + banco + coluna do Kanban), Ana
 *      em Seleccionado no Encuadre, 1 registro REMOVE;
 *   2. ALTERNATIVO 1 — Confirmar desabilitado sem motivo, só com motivo (sem destino) e só com destino (sem
 *      motivo); nenhuma requisição `…/end` sai e nada muda no banco;
 *   3. ALTERNATIVO 2 — "Sale del encuadre de este servicio" → Ana em Rechazado no Encuadre, com o RÓTULO do motivo.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR, readPatientKanbanColumn,
} from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openItineraryTab } from '../helpers/itinerario-aba-e2e-helper';
import { assembleApi } from '../helpers/itinerario-escrita-e2e-helper';
import {
  seedDerivablePatient, selectedWorker, allocateWorker, readStatusBoth, coveredHours, derivacaoToken,
  type DerivableSeed,
} from '../helpers/derivacao-e2e-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';

const STAFF = mockAdminUserFor('itinerario-quitar');

/** 1 serviço de 4 h/semana com UMA faixa de 4 h: 1 prestador cobre 100% (cobertura total → ACTIVE). */
const QUATRO_HORAS = { weeklyHours: 4, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] };
const MOTIVO_DESISTENCIA = 'El prestador desistió'; // DESISTENCIA_DO_PRESTADOR
const MOTIVO_PERFIL = 'Perfil no adecuado al servicio'; // PERFIL_INADEQUADO_AO_SERVICO

interface Montado {
  seed: DerivableSeed;
  serviceId: string;
  slotId: string;
  workerId: string;
}

/** Paciente derivável com Ana única alocada e o itinerário montado (estado ACTIVE, lido da API e do banco). */
async function semearMontado(request: Parameters<typeof seedDerivablePatient>[0]): Promise<Montado> {
  const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [QUATRO_HORAS] });
  try {
    const [svc] = seed.services;
    const workerId = selectedWorker(seed, svc.vacancyId);
    const alocacao = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[0], workerId);
    expect(alocacao.status, `allocate ${alocacao.status} ${alocacao.code ?? ''}`).toBe(201);
    const montar = await assembleApi(request, derivacaoToken(), seed.patientId);
    expect(montar.status).toBe(201);
    const estado = await readStatusBoth(request, seed.patientId);
    expect(estado).toEqual({ api: 'ACTIVE', db: 'ACTIVE' });
    return { seed, serviceId: svc.serviceId, slotId: svc.slotIds[0], workerId };
  } catch (err) {
    seed.cleanup();
    throw err;
  }
}

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

/** Contagens por serviço lidas do banco: registro de trocas, marcas de rejeição ativas, alocações vigentes. */
function contagens(serviceId: string): { registros: number; marcas: number; vigentes: number } {
  const n = (sql: string): number => Number(runSQL(sql).trim());
  return {
    registros: n(`SELECT count(*) FROM patient_itinerary_change_log WHERE contracted_service_id = '${serviceId}'`),
    marcas: n(`SELECT count(*) FROM contracted_service_rejections WHERE service_id = '${serviceId}' AND reverted_at IS NULL`),
    vigentes: n(
      `SELECT count(*) FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id ` +
        `WHERE s.contracted_service_id = '${serviceId}' AND a.status = 'ACTIVE'`,
    ),
  };
}

/** Itinerario → Editar a faixa → "Quitar del itinerario" do prestador atual: o painel abre. */
async function abrirPainelQuitar(page: Page, m: Montado): Promise<void> {
  await openItineraryTab(page, m.seed.patientId);
  await expect(page.getByTestId(`itinerario-servico-par-${m.serviceId}`)).toContainText('4/4');
  await page.getByTestId(`itinerario-slot-editar-${m.slotId}`).click();
  await expect(page.getByTestId('itinerario-editar-modal')).toBeVisible();
  await page.getByTestId(`itinerario-quitar-${m.workerId}`).click();
  await expect(page.getByTestId('itinerario-quitar-painel')).toBeVisible();
}

function postsDeEnd(page: Page): string[] {
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/itinerary\/allocations\/[^/]+\/end$/.test(r.url())) posts.push(r.url());
  });
  return posts;
}

test.describe('patient-itinerary-quitar: "Quitar del itinerario" pela tela @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario Quitar');

  test('FELIZ: Ana única → motivo + "Sigue como reserva" → 0/4 na tela, estado Búsqueda, Ana em Seleccionado, 1 REMOVE', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearMontado(request);
    try {
      await loginAs(page, STAFF);
      const colunaAntes = await readPatientKanbanColumn(page, m.seed.patientId);
      await abrirPainelQuitar(page, m);

      await expect(page.getByTestId('itinerario-quitar-confirmar')).toBeDisabled();
      await page.getByTestId('itinerario-quitar-motivo').selectOption({ label: MOTIVO_DESISTENCIA });
      await page.getByTestId('itinerario-quitar-destino-RESERVE').click();
      const confirmar = page.getByTestId('itinerario-quitar-confirmar');
      await expect(confirmar).toBeEnabled();
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /\/itinerary\/allocations\/[^/]+\/end$/.test(r.url())),
        confirmar.click(),
      ]);
      expect(resp.status()).toBe(200);
      expect(resp.request().postDataJSON()).toEqual({ reasonCategory: 'DESISTENCIA_DO_PRESTADOR', destination: 'RESERVE' });

      // Na tela: o painel e o modal fecham; as horas cobertas caem a 0.
      await expect(page.getByTestId('itinerario-quitar-painel')).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByTestId('itinerario-editar-modal')).toHaveCount(0);
      await expect(page.getByTestId(`itinerario-servico-par-${m.serviceId}`)).toContainText('0/4', { timeout: 15_000 });
      await expect(page.getByTestId(`itinerario-slot-prestador-${m.slotId}-${m.workerId}`)).toHaveCount(0);

      // Estado lido da API, do banco e do Kanban na MESMA execução: Búsqueda.
      expect(await coveredHours(request, m.seed.patientId)).toBe(0);
      expect(await readStatusBoth(request, m.seed.patientId)).toEqual({ api: 'SEARCHING', db: 'SEARCHING' });
      expect(await readPatientKanbanColumn(page, m.seed.patientId)).not.toBe(colunaAntes);
      expect(contagens(m.serviceId)).toEqual({ registros: 1, marcas: 0, vigentes: 0 });
      expect(
        runSQL(`SELECT kind || '/' || destination || '/' || reason_code FROM patient_itinerary_change_log WHERE contracted_service_id = '${m.serviceId}'`).trim(),
      ).toBe('REMOVE/RESERVE/DESISTENCIA_DO_PRESTADOR');

      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 1: Confirmar desabilitado sem motivo, sem destino e sem os dois; nenhuma requisição …/end e nada muda', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const posts = postsDeEnd(page);
    const m = await semearMontado(request);
    try {
      const antes = contagens(m.serviceId);
      expect(antes).toEqual({ registros: 0, marcas: 0, vigentes: 1 });

      await loginAs(page, STAFF);
      await abrirPainelQuitar(page, m);
      const confirmar = page.getByTestId('itinerario-quitar-confirmar');
      const motivo = page.getByTestId('itinerario-quitar-motivo');

      await expect(confirmar).toBeDisabled(); // nem motivo nem destino
      await page.getByTestId('itinerario-quitar-destino-LEAVE_SERVICE').click();
      await expect(confirmar).toBeDisabled(); // com destino e SEM motivo

      // O motivo escolhido não se "desescolhe" (o placeholder do select some): painel novo para o outro caso.
      await abrirPainelQuitar(page, m);
      await expect(confirmar).toBeDisabled();
      await motivo.selectOption({ label: MOTIVO_PERFIL });
      await expect(confirmar).toBeDisabled(); // com motivo e SEM destino
      await expect(page.getByTestId('itinerario-quitar-painel')).toHaveClass(/translate-x-0/); // animação de entrada (300 ms) terminou
      // Clique de mouse real no centro do botão desabilitado (o `click({force})` do Playwright o acusa fora da viewport).
      const box = await confirmar.boundingBox();
      if (!box) throw new Error('itinerario-quitar-confirmar sem caixa');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1_000);

      expect(posts).toHaveLength(0);
      expect(contagens(m.serviceId)).toEqual(antes);
      expect(await readStatusBoth(request, m.seed.patientId)).toEqual({ api: 'ACTIVE', db: 'ACTIVE' });
      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 2: "Sale del encuadre de este servicio" → marca de Rechazado gravada com o código do motivo, estado Búsqueda', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearMontado(request);
    try {
      await loginAs(page, STAFF);
      await abrirPainelQuitar(page, m);
      await page.getByTestId('itinerario-quitar-motivo').selectOption({ label: MOTIVO_PERFIL });
      await page.getByTestId('itinerario-quitar-destino-LEAVE_SERVICE').click();
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /\/itinerary\/allocations\/[^/]+\/end$/.test(r.url())),
        page.getByTestId('itinerario-quitar-confirmar').click(),
      ]);
      expect(resp.status()).toBe(200);
      expect(resp.request().postDataJSON()).toEqual({ reasonCategory: 'PERFIL_INADEQUADO_AO_SERVICO', destination: 'LEAVE_SERVICE' });
      await expect(page.getByTestId(`itinerario-servico-par-${m.serviceId}`)).toContainText('0/4', { timeout: 15_000 });

      // Banco: a marca ativa leva o MESMO código do motivo; o estado vira Búsqueda.
      expect(contagens(m.serviceId)).toEqual({ registros: 1, marcas: 1, vigentes: 0 });
      expect(
        runSQL(`SELECT reject_reason_category FROM contracted_service_rejections WHERE service_id = '${m.serviceId}' AND reverted_at IS NULL`).trim(),
      ).toBe('PERFIL_INADEQUADO_AO_SERVICO');
      expect(await readStatusBoth(request, m.seed.patientId)).toEqual({ api: 'SEARCHING', db: 'SEARCHING' });

      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });
});
