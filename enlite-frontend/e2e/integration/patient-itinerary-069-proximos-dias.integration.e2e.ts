/**
 * patient-itinerary-069-proximos-dias.integration.e2e.ts @integration — spec 069, F7 (US2): a aba "Próximos días" do serviço (B2) — tabela da
 * semana, seletor de semana com calendário e turnos "Sin cubrir". Stack REAL, sem mock de dado de negócio (só a auth, `loginAs`). Régua humana:
 * cliques reais (setas, calendário, "Ir a esta semana", "Asignar"); a API só monta o cenário e é o oráculo (as ocorrências lidas da rota).
 *
 * Side-effect outbound mapeado ANTES de clicar: leitura + abrir o editor de faixa (sem salvar); nenhum envio. Mesmo assim cada teste registra todo
 * host que a PÁGINA pede e exige que nenhum seja de canal real.
 *
 *   1. FELIZ — a semana corrente em tabela (Día · Horario · Quién atiende · Acción), uma linha por turno, e a seguinte pela seta;
 *   2. ALTERNATIVO 1 — calendário: uma data 20 semanas à frente mostra essa semana ("En 20 semanas") e "Ir a esta semana" volta à corrente;
 *   3. ALTERNATIVO 2 — faixa sem ninguém (titular saiu SEM substituto) → "Nadie asignado" + "Asignar", que abre o editor da faixa.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openItineraryTab, openUpcomingDays } from '../helpers/itinerario-aba-e2e-helper';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';
import { criarPedidoViaApi, diaDoBanco, hojeDoBanco, irParaSemanaPeloCalendario, segundaDaSemana, somaDias } from '../helpers/itinerario-069-flow-helper';
import { nomeDe, semearTitularSegQuaSex } from '../helpers/itinerario-069-seed-helper';

const STAFF = mockAdminUserFor('itinerario-069-proximos');

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

test.use({ video: 'on' }); // evidência: o vídeo da execução vai anexado ao relatório (top-level: `video` força worker novo)

test.describe('patient-itinerary-069-proximos-dias: tabela da semana e seletor de semana @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.describe.configure({ mode: 'serial' }); // um `beforeAll` de staff por arquivo: os 3 testes ficam no mesmo worker (o CI roda com 1)
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario 069 Proximos');

  test('FELIZ: a semana corrente em tabela; a semana seguinte (seta) traz as 3 faixas do titular, com o nome dele', async ({ page, request }, testInfo) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      const nomeTitular = await nomeDe(request, m.patientId, m.serviceId, m.titular);
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);
      await openUpcomingDays(page, m.serviceId);

      await expect(page.getByTestId('itinerario-aba-upcoming')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('itinerario-semana-relativo')).toHaveText('Esta semana');
      const cabecalho = page.getByTestId('itinerario-proximos-tabela').getByRole('columnheader');
      await expect(cabecalho).toHaveText(['Día', 'Horario', 'Quién atiende', 'Acción']);

      // Semana seguinte (seta real): seg, qua e sex — uma linha por turno, todas com o titular e a ação "Cambiar".
      await page.getByTestId('itinerario-semana-seguinte').click();
      await expect(page.getByTestId('itinerario-semana-relativo')).toHaveText('La semana que viene');
      const segundaSeguinte = somaDias(segundaDaSemana(hojeDoBanco()), 7);
      for (const [i, slotId] of m.slotIds.entries()) {
        const data = somaDias(segundaSeguinte, [0, 2, 4][i]);
        const linha = page.getByTestId(`itinerario-proximo-${slotId}-${data}`);
        await expect(linha).toBeVisible({ timeout: 15_000 });
        await expect(linha).toContainText(nomeTitular);
        await expect(linha).toContainText('Titular');
        await expect(page.getByTestId(`itinerario-proximo-horario-${slotId}-${data}`)).toHaveText('08:00 – 12:00');
        await expect(page.getByTestId(`itinerario-proximo-cambiar-${slotId}-${data}`)).toBeVisible();
      }
      await expect(page.locator('[data-testid^="itinerario-proximo-cambiar-"]')).toHaveCount(3);

      await page.getByTestId('itinerario-semana-atual').click();
      await expect(page.getByTestId('itinerario-semana-relativo')).toHaveText('Esta semana');
      await expect(page.getByTestId('itinerario-servico-tela-' + m.serviceId)).toHaveScreenshot('proximos-dias.png', {
        maxDiffPixelRatio: 0.05,
        mask: [page.locator('.break-words'), page.getByTestId('itinerario-proximos-painel'), page.getByTestId('itinerario-servico-reserva')], // tabela: datas e nomes mudam
      });
      await testInfo.attach('proximos-dias', { body: await page.screenshot({ animations: 'disabled', caret: 'hide' }), contentType: 'image/png' });
      expect(proibidos(), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 1: calendário 20 semanas à frente mostra essa semana e "Ir a esta semana" volta à corrente', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      const alvo = somaDias(segundaDaSemana(hojeDoBanco()), 20 * 7);
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);
      await openUpcomingDays(page, m.serviceId);

      const relativo = await irParaSemanaPeloCalendario(page, alvo);
      expect(relativo).toBe('En 20 semanas');
      // A tabela mostra ESSA semana: o titular tem as 3 faixas, sem teto de horizonte.
      for (const [i, slotId] of m.slotIds.entries()) {
        await expect(page.getByTestId(`itinerario-proximo-${slotId}-${somaDias(alvo, [0, 2, 4][i])}`)).toBeVisible({ timeout: 15_000 });
      }
      // O rótulo da semana lido da TELA traz o dia inicial da semana escolhida.
      await expect(page.getByTestId('itinerario-semana-rotulo')).toContainText(String(Number(alvo.slice(8, 10))));

      await page.getByTestId('itinerario-semana-atual').click();
      await expect(page.getByTestId('itinerario-semana-relativo')).toHaveText('Esta semana');
      await expect(page.getByTestId(`itinerario-proximo-${m.slotIds[0]}-${alvo}`)).toHaveCount(0);
      expect(proibidos()).toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });

  test('ALTERNATIVO 2: titular sai SEM substituto → as faixas ficam "Nadie asignado" com "Asignar", que abre o editor da faixa', async ({ page, request }) => {
    const proibidos = vigiarHosts(page);
    const m = await semearTitularSegQuaSex(request);
    try {
      const desde = diaDoBanco(1);
      await criarPedidoViaApi(request, m.patientId, m.serviceId, { type: 'PERMANENT', outgoingWorkerId: m.titular, from: desde, substituteWorkerId: null, destination: undefined });
      await loginAs(page, STAFF);
      await openItineraryTab(page, m.patientId);
      await openUpcomingDays(page, m.serviceId);

      // Duas semanas depois da saída ninguém cobre: "Nadie asignado" em cada faixa, e a ação é "Asignar" (não "Cambiar").
      const alvo = somaDias(segundaDaSemana(desde), 14);
      await irParaSemanaPeloCalendario(page, alvo);
      for (const [i, slotId] of m.slotIds.entries()) {
        const data = somaDias(alvo, [0, 2, 4][i]);
        const semCobertura = page.getByTestId(`itinerario-proximo-sem-cobertura-${slotId}-${data}`);
        await expect(semCobertura).toBeVisible({ timeout: 15_000 });
        await expect(semCobertura).toContainText('Nadie asignado');
        await expect(page.getByTestId(`itinerario-proximo-asignar-${slotId}-${data}`)).toBeVisible();
      }
      await expect(page.locator('[data-testid^="itinerario-proximo-cambiar-"]')).toHaveCount(0);

      // "Asignar" num turno SEM falta (faixa sem alocação) leva ao editor da faixa em "Horario fijo".
      await page.getByTestId(`itinerario-proximo-asignar-${m.slotIds[0]}-${alvo}`).click();
      await expect(page.getByTestId('itinerario-editar-modal')).toBeVisible({ timeout: 10_000 });
      expect(proibidos()).toEqual([]);
    } finally {
      m.seed.cleanup();
    }
  });
});
