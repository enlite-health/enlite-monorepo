/**
 * patient-itinerary-069-horario-fijo.integration.e2e.ts @integration — spec 069, F7 (US2, P1): a aba "Horario fijo" é a agenda de sempre, agora por
 * serviço. Stack REAL, sem mock de dado de negócio (só a auth, `loginAs`). Régua humana: cliques reais, `selectOption` real, texto lido da TELA; a API
 * só monta o cenário e é o oráculo.
 *
 * Side-effect outbound mapeado ANTES de clicar: "Quitar" só escreve em Postgres (alocação, registro de trocas, marca, derivação); a edição do horário
 * do serviço só escreve em Postgres. Cada teste registra todo host que a PÁGINA pede e exige que nenhum seja de canal real.
 *
 *   1. FELIZ — a agenda igual à de hoje: dia, faixa, duração e prestador de cada linha batem com a rota; "Sin atención: …" lista os dias sem faixa;
 *   2. ALTERNATIVO 1 (P1) — faixa com pedido futuro: editar o horário do serviço é RECUSADO (422 SLOT_HAS_ACTIVE_ALLOCATION) e a agenda não muda;
 *   3. ALTERNATIVO 2 — "Quitar del itinerario" segue funcionando pela tela (motivo + destino) e a faixa fica sem prestador.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openFixedSchedule, openItineraryTab } from '../helpers/itinerario-aba-e2e-helper';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { criarPedidoViaApi, diaDoBanco, proximaDataNoDia, turnosDaPessoa } from '../helpers/itinerario-069-flow-helper';
import { nomeDe, semearTitularSegQuaSex, servicoDaRota } from '../helpers/itinerario-069-seed-helper';
import { escolherNoComboPorValor } from '../helpers/combobox';

const STAFF = mockAdminUserFor('itinerario-069-horario-fijo');

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

const NOMES_DOS_DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

test.use({ video: 'on' }); // evidência: o vídeo da execução vai anexado ao relatório (top-level: `video` força worker novo)

test.describe('patient-itinerary-069-horario-fijo: a agenda semanal do serviço @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.describe.configure({ mode: 'serial' }); // um `beforeAll` de staff por arquivo: os 3 testes ficam no mesmo worker (o CI roda com 1)
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario 069 Horario Fijo');

  test('FELIZ: a agenda é a de hoje — dia, faixa, duração e prestador de cada linha batem com a rota; "Sin atención" lista os outros dias', async ({ page, request }, testInfo) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      const rota = await servicoDaRota(request, m.patientId, m.serviceId);
      const nomeTitular = await nomeDe(request, m.patientId, m.serviceId, m.titular);
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);
      await openFixedSchedule(page, m.serviceId);

      expect(rota.slots).toHaveLength(3);
      for (const slot of rota.slots) {
        const linha = page.getByTestId(`itinerario-dia-${m.serviceId}-${slot.weekday}-${slot.id}`);
        await expect(linha).toBeVisible();
        await expect(linha).toContainText(NOMES_DOS_DIAS[slot.weekday]);
        await expect(page.getByTestId(`itinerario-slot-horario-${slot.id}`)).toHaveText(`${slot.startTime} – ${slot.endTime}`);
        await expect(page.getByTestId(`itinerario-slot-duracao-${slot.id}`)).toHaveText('4 h');
        await expect(page.getByTestId(`itinerario-slot-prestador-${slot.id}-${m.titular}`)).toContainText(nomeTitular);
        await expect(page.getByTestId(`itinerario-slot-editar-${slot.id}`)).toBeVisible();
      }
      await expect(page.getByTestId('itinerario-sin-atencion')).toHaveText('Sin atención: domingo, martes, jueves y sábado');
      await expect(page.getByTestId('itinerario-horario-fijo')).toHaveScreenshot('horario-fijo.png', {
        maxDiffPixelRatio: 0.05,
        mask: [page.locator('[data-testid^="itinerario-slot-prestador-"]')], // o nome do prestador muda a cada massa
      });
      await testInfo.attach('horario-fijo', { body: await page.screenshot({ animations: 'disabled', caret: 'hide' }), contentType: 'image/png' });
      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 1 (P1): faixa com pedido futuro → editar o horário do serviço é recusado e a agenda não muda', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      const segunda = proximaDataNoDia(1, diaDoBanco(1));
      const turnos = await turnosDaPessoa(request, m.patientId, m.serviceId, m.titular, segunda, segunda);
      await criarPedidoViaApi(request, m.patientId, m.serviceId, {
        type: 'ONE_DAY', outgoingWorkerId: m.titular, from: segunda, shifts: turnos.map((t) => ({ ...t, substituteWorkerId: m.sub })),
      });
      const antes = await servicoDaRota(request, m.patientId, m.serviceId);

      await loginAs(page, STAFF);
      await page.goto(`/admin/patients/${m.patientId}`);
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
      await page.getByTestId(`contracted-service-edit-${m.serviceId}`).click();
      await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible();
      // A faixa de segunda 08:00-12:00 passa a começar às 09:00 (clique no TimeSelect + na opção, como a pessoa).
      await page.getByTestId('svc-shift-start-1-1-0').click();
      await page.getByTestId('svc-shift-start-1-1-0-option-09:00').click();
      await expect(page.getByTestId('svc-shift-start-1-1-0')).toContainText('09:00');
      const [patch] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/contracted-services/${m.serviceId}`)),
        page.getByTestId(`contracted-service-save-${m.serviceId}`).click(),
      ]);
      expect(patch.status()).toBe(422);
      expect(((await patch.json()) as { code?: string }).code).toBe('SLOT_HAS_ACTIVE_ALLOCATION');

      // Nada mudou: a rota devolve as mesmas faixas e o "Horario fijo" mostra 08:00 – 12:00 na segunda.
      expect((await servicoDaRota(request, m.patientId, m.serviceId)).slots).toEqual(antes.slots);
      await page.goto(`/admin/patients/${m.patientId}`);
      await openItineraryTab(page, m.patientId);
      await openFixedSchedule(page, m.serviceId);
      await expect(page.getByTestId(`itinerario-slot-horario-${m.slotIds[0]}`)).toHaveText('08:00 – 12:00');
      expect(proibidos()).toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 2: "Quitar del itinerario" segue funcionando — motivo + destino → a faixa fica sem prestador', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);
      await openFixedSchedule(page, m.serviceId);

      await page.getByTestId(`itinerario-slot-editar-${m.slotIds[1]}`).click();
      await expect(page.getByTestId('itinerario-editar-modal')).toBeVisible();
      await page.getByTestId(`itinerario-quitar-${m.titular}`).click();
      await expect(page.getByTestId('itinerario-quitar-painel')).toBeVisible();
      await expect(page.getByTestId('itinerario-quitar-confirmar')).toBeDisabled();
      await escolherNoComboPorValor(page, page.getByTestId('itinerario-quitar-motivo'), 'OTHER');
      await page.getByTestId('itinerario-quitar-destino-RESERVE').click();
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /\/itinerary\/allocations\/[^/]+\/end$/.test(r.url())),
        page.getByTestId('itinerario-quitar-confirmar').click(),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.getByTestId('itinerario-quitar-painel')).toHaveCount(0, { timeout: 10_000 });

      await expect(page.getByTestId(`itinerario-slot-sem-prestador-${m.slotIds[1]}`)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId(`itinerario-slot-prestador-${m.slotIds[1]}-${m.titular}`)).toHaveCount(0);
      await expect(page.getByTestId(`itinerario-slot-prestador-${m.slotIds[0]}-${m.titular}`)).toBeVisible(); // as outras faixas seguem com ele
      expect(
        sqlComVars("SELECT kind || '/' || destination FROM patient_itinerary_change_log WHERE contracted_service_id = :'s'::uuid", { s: m.serviceId }),
      ).toBe('REMOVE/RESERVE');
      expect(proibidos()).toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });
});
