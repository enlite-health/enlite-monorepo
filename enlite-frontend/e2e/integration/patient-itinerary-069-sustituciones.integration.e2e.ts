/**
 * patient-itinerary-069-sustituciones.integration.e2e.ts @integration — spec 069, F7 (US6/US7): a aba "Sustituciones" (uma linha por PEDIDO, no formato
 * Cuándo · Sale ↓ · Entra ↑ · Acción), "Ver días", "Deshacer" e "Elegir quién entra". Stack REAL, sem mock de dado de negócio (só a auth,
 * `loginAs`). Régua humana: cliques reais, `selectOption` real, texto lido da TELA; a API só monta o cenário (os pedidos) e é o oráculo do banco.
 *
 * Side-effect outbound mapeado ANTES de clicar: desfazer/cobrir só escrevem em Postgres (ausências, registro de trocas); nenhum canal externo no
 * caminho. Mesmo assim cada teste registra todo host que a PÁGINA pede e exige que nenhum seja de canal real (`CADEIA_FORBIDDEN_HOSTS`).
 *
 *   1. FELIZ — pedido de 6 turnos: UMA linha, "Ver días" abre 6 itens com quem entra em cada um;
 *   2. ALTERNATIVO 1 — "Deshacer" → a linha vira "Deshecha" e os 6 turnos voltam ao titular em "Próximos días";
 *   3. ALTERNATIVO 2 — pedido "Nadie todavía" → "Elegir quién entra" → a pessoa escolhida passa a cobrir os turnos.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openItineraryTab, openSubstitutions, openUpcomingDays } from '../helpers/itinerario-aba-e2e-helper';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import {
  criarPedidoViaApi, diaDoBanco, irParaSemanaPeloCalendario, proximaDataNoDia, somaDias, turnosDaPessoa,
} from '../helpers/itinerario-069-flow-helper';
import { nomeDe, semearTitularSegQuaSex, type Cenario } from '../helpers/itinerario-069-seed-helper';
import { escolherNoComboPorValor } from '../helpers/combobox';

const STAFF = mockAdminUserFor('itinerario-069-sustituciones');

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

/** Pedido de Varios días (seg → sex da semana seguinte = 6 turnos) criado pela API; `substituto` = quem entra em todos (ou `null`). */
async function pedidoDeSeisTurnos(request: APIRequestContext, m: Cenario, substituto: string | null): Promise<{ requestId: string; desde: string; hasta: string }> {
  const desde = proximaDataNoDia(1, diaDoBanco(1));
  const hasta = somaDias(desde, 11);
  const turnos = await turnosDaPessoa(request, m.patientId, m.serviceId, m.titular, desde, hasta);
  expect(turnos).toHaveLength(6);
  const requestId = await criarPedidoViaApi(request, m.patientId, m.serviceId, {
    type: 'DAYS', outgoingWorkerId: m.titular, from: desde, to: hasta,
    shifts: turnos.map((t) => ({ ...t, substituteWorkerId: substituto })),
  });
  return { requestId, desde, hasta };
}

const ausenciasAbertas = (requestId: string): number =>
  Number(sqlComVars("SELECT count(*) FROM patient_itinerary_absence WHERE request_id = :'r'::uuid AND cancelled_at IS NULL", { r: requestId }));

test.use({ video: 'on' }); // evidência: o vídeo da execução vai anexado ao relatório (top-level: `video` força worker novo)

test.describe('patient-itinerary-069-sustituciones: a lista de pedidos do serviço @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.describe.configure({ mode: 'serial' }); // um `beforeAll` de staff por arquivo: os 3 testes ficam no mesmo worker (o CI roda com 1)
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario 069 Sustituciones');

  test('FELIZ: pedido de 6 turnos → UMA linha (Cuándo · Sale ↓ · Entra ↑ · Acción) e "Ver días" abre 6 itens', async ({ page, request }, testInfo) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      const { requestId } = await pedidoDeSeisTurnos(request, m, m.sub);
      const nomeTitular = await nomeDe(request, m.patientId, m.serviceId, m.titular);
      const nomeSub = await nomeDe(request, m.patientId, m.serviceId, m.sub);
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);
      await openSubstitutions(page, m.serviceId);

      await expect(page.locator('[data-testid^="sustitucion-"][data-when]')).toHaveCount(1); // UMA linha por pedido
      const linha = page.getByTestId(`sustitucion-${requestId}`);
      await expect(linha).toHaveAttribute('data-when', 'upcoming');
      await expect(linha).toContainText('Varios días · 6 turnos');
      await expect(page.getByTestId(`sustitucion-bloque-${requestId}-sale`)).toContainText(nomeTitular);
      await expect(page.getByTestId(`sustitucion-bloque-${requestId}-entra`)).toContainText(nomeSub);
      // O sentido não depende só da cor: ícone com rótulo acessível "Sale"/"Entra".
      await expect(linha.getByRole('img', { name: 'Sale' })).toBeVisible();
      await expect(linha.getByRole('img', { name: 'Entra' })).toBeVisible();
      await expect(page.getByTestId(`sustitucion-deshacer-${requestId}`)).toBeVisible();

      await page.getByTestId(`sustitucion-ver-dias-${requestId}`).click();
      const itens = page.getByTestId(`sustituciones-dias-${requestId}`).getByTestId('sustituciones-dia');
      await expect(itens).toHaveCount(6);
      for (const item of await itens.all()) await expect(item).toContainText(nomeSub);
      await expect(page.getByTestId('sustituciones-panel')).toHaveScreenshot('sustituciones.png', {
        maxDiffPixelRatio: 0.05,
        mask: [page.locator('.break-words'), page.locator('li[data-testid^="sustitucion-"] > div > div:first-child'), page.locator('[data-testid^="sustituciones-dias-"]')], // datas e nomes mudam
      });
      await testInfo.attach('sustituciones', { body: await page.screenshot({ animations: 'disabled', caret: 'hide' }), contentType: 'image/png' });

      await page.getByTestId(`sustitucion-ver-dias-${requestId}`).click(); // "Ocultar días"
      await expect(itens).toHaveCount(0);
      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 1: "Deshacer" → a linha vira "Deshecha" e os 6 turnos voltam ao titular em "Próximos días"', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      const { requestId, desde } = await pedidoDeSeisTurnos(request, m, m.sub);
      const nomeTitular = await nomeDe(request, m.patientId, m.serviceId, m.titular);
      expect(ausenciasAbertas(requestId)).toBe(6);
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);

      // Antes: o 1º turno da lista está "Sustitución" (quem atende é o substituto).
      await openUpcomingDays(page, m.serviceId);
      await irParaSemanaPeloCalendario(page, desde);
      await expect(page.getByTestId(`itinerario-proximo-${m.slotIds[0]}-${desde}`)).toContainText('Sustitución', { timeout: 15_000 });

      await openSubstitutions(page, m.serviceId);
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/substitution-requests/${requestId}/undo`)),
        page.getByTestId(`sustitucion-deshacer-${requestId}`).click(),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.getByTestId(`sustitucion-deshecha-${requestId}`)).toContainText('Deshecha', { timeout: 15_000 });
      await expect(page.getByTestId(`sustitucion-${requestId}`)).toHaveAttribute('data-undone', 'true');
      await expect(page.getByTestId(`sustitucion-deshacer-${requestId}`)).toHaveCount(0);
      expect(ausenciasAbertas(requestId)).toBe(0);

      // Depois: o turno voltou a quem atende (o titular, sem o selo "Sustitución").
      await openUpcomingDays(page, m.serviceId);
      await irParaSemanaPeloCalendario(page, desde);
      const turno = page.getByTestId(`itinerario-proximo-${m.slotIds[0]}-${desde}`);
      await expect(turno).toContainText(nomeTitular, { timeout: 15_000 });
      await expect(turno).not.toContainText('Sustitución');
      await expect(page.locator('[data-testid^="itinerario-proximo-sem-cobertura-"]')).toHaveCount(0);
      expect(proibidos()).toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 2: pedido "Nadie todavía" → "Elegir quién entra" → a pessoa escolhida passa a cobrir os 6 turnos', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      const { requestId } = await pedidoDeSeisTurnos(request, m, null);
      const nomeSub = await nomeDe(request, m.patientId, m.serviceId, m.sub);
      expect(ausenciasAbertas(requestId)).toBe(6);
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);
      await openSubstitutions(page, m.serviceId);

      // A informação de "sem cobertura" mora NO campo Entra (não num selo separado).
      const entra = page.getByTestId(`sustitucion-bloque-${requestId}-entra`);
      await expect(entra).toContainText('Nadie todavía');
      await entra.getByRole('button', { name: 'Elegir quién entra' }).click();
      await expect(page.getByTestId('sustitucion-cubrir')).toBeVisible();
      await expect(page.getByTestId('sustitucion-cubrir-confirmar')).toBeDisabled(); // sem pessoa

      await escolherNoComboPorValor(page, page.getByTestId('sustitucion-cubrir-persona'), m.sub);
      await expect(page.getByTestId('sustitucion-cubrir-elegida')).toContainText(nomeSub);
      const estados = page.locator('[data-testid^="sustitucion-cubrir-estado-"]');
      await expect(estados).toHaveCount(6);
      for (const estado of await estados.all()) await expect(estado).toHaveText('Libre', { timeout: 15_000 });
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/substitution-requests/${requestId}/cover`)),
        page.getByTestId('sustitucion-cubrir-confirmar').click(),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.getByTestId('sustitucion-cubrir')).toHaveCount(0, { timeout: 15_000 });

      await expect(page.getByTestId(`sustitucion-bloque-${requestId}-entra`)).toContainText(nomeSub, { timeout: 15_000 });
      await expect(page.getByTestId(`sustitucion-bloque-${requestId}-entra`)).not.toContainText('Nadie todavía');
      expect(
        Number(sqlComVars("SELECT count(*) FROM patient_itinerary_absence WHERE request_id = :'r'::uuid AND cancelled_at IS NULL AND substitute_worker_id = :'w'::uuid", { r: requestId, w: m.sub })),
      ).toBe(6);
      expect(proibidos()).toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });
});
