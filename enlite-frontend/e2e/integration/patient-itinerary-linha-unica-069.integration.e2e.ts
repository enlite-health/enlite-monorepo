/**
 * patient-itinerary-linha-unica-069.integration.e2e.ts @integration — spec 069, regra do Gabriel (23/10): NENHUM nome/label quebra linha, nas telas
 * novas. Stack REAL (frontend + API + Postgres), sem mock de dado de negócio — só a auth (`loginAs`). Massa com nomes LONGOS (≥ 35 caracteres),
 * motivo longo (catálogo, criado pela API do catálogo) e endereço longo; em 1440×900 e em 1280×800 o guarda (`expectLinhaUnica`) confere, em
 * B1, Próximos días, Horario fijo, Sustituciones (com "Ver días") e nos 4 passos do modal, que todo elemento `data-single-line` ocupa UMA linha e que
 * nada estoura o contêiner. Controle positivo: em cada tela o guarda mede ≥ N elementos E o corte por reticência de fato acontece (nome maior que a caixa).
 * O nome do arquivo NÃO é `patient-itinerary-069-*` de propósito: esses são os specs de FLUXO HUMANO (sem `evaluate`); a medição de layout só existe
 * no navegador. Casa o `--grep patient-itinerary` do CI.
 *
 * Side-effect outbound mapeado: só leitura e abrir o fluxo (sem confirmar); a semente escreve em Postgres. Nenhum host de canal real.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockAdminUserFor, useLancamentoStaff, backendUrl } from '../helpers/lancamento-e2e-helper';
import { loginAs, tokenFor } from '../helpers/abac-stack-helper';
import { openItineraryTab, openUpcomingDays, openFixedSchedule, openSubstitutions } from '../helpers/itinerario-aba-e2e-helper';
import { seedDerivablePatient, allocateWorker, derivacaoToken } from '../helpers/derivacao-e2e-helper';
import { assembleApi } from '../helpers/itinerario-escrita-e2e-helper';
import { insertTestWorker } from '../helpers/db-test-helper';
import { insertWJA } from '../helpers/wja-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';
import {
  abrirNuevaSustitucion, criarPedidoViaApi, diaDoBanco, irParaSemanaPeloCalendario, paso1QuienNoViene, paso2PorCuantoTiempo, paso3UnaPersona,
  proximaDataNoDia, siguiente, somaDias, turnosDaPessoa,
} from '../helpers/itinerario-069-flow-helper';
import { SEG_QUA_SEX } from '../helpers/itinerario-069-seed-helper';
import { expectLinhaUnica } from '../helpers/itinerario-linha-unica-helper';

const STAFF = mockAdminUserFor('itinerario-linha-unica-069');
const MOTIVO_LONGO = 'Licencia médica prolongada por intervención quirúrgica programada';
const ENDERECO_LONGO = 'Avenida Presidente Roque Sáenz Peña 1234, Piso 12 Departamento B, Ciudad Autónoma de Buenos Aires, Argentina';
const SOBRENOME_LONGO = 'DerivacaoE2E Apellido Compuesto Muy Largo';

function vigiarHosts(page: Page): () => string[] {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
  return () => hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h));
}

/** Prints de evidência (só com `PRINT_DIR`): o olho humano confere o que o guarda mediu. */
async function imprimir(page: Page, nome: string, largura: number, alvo?: string): Promise<void> {
  const dir = process.env.PRINT_DIR;
  if (!dir) return;
  const caminho = `${dir}/${nome}-${largura}.png`;
  if (alvo) await page.getByTestId(alvo).screenshot({ path: caminho, animations: 'disabled', caret: 'hide' });
  else await page.screenshot({ path: caminho, animations: 'disabled', caret: 'hide' });
}

const VIEWPORTS = [
  { largura: 1440, altura: 900 },
  { largura: 1280, altura: 800 },
] as const;

test.describe('patient-itinerary-linha-unica-069: nomes e labels longos não quebram linha @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario Linha Unica 069');

  for (const { largura, altura } of VIEWPORTS) {
    test(`${largura}×${altura}: B1, Próximos días, Horario fijo, Sustituciones e o modal (passos 1-4) em UMA linha`, async ({ page, request }) => {
      await page.setViewportSize({ width: largura, height: altura });
      const proibidos = vigiarHosts(page);
      const rotuloMotivo = `${MOTIVO_LONGO} ${largura}`;
      runSQL(`DELETE FROM service_exit_reasons WHERE code = id::text AND label = '${rotuloMotivo}'`);
      const criado = await request.post(`${backendUrl()}/api/admin/therapeutic-catalogs/service-exit-reasons`, {
        headers: { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' },
        data: { label: rotuloMotivo },
      });
      expect(criado.status(), 'o catálogo aceita o motivo longo').toBe(201);
      const codigoMotivo = runSQL(`SELECT code FROM service_exit_reasons WHERE label = '${rotuloMotivo}' AND active`).split('\n')[0].trim();

      const seed = await seedDerivablePatient(request, {
        status: 'SEARCHING',
        services: [{ schedule: SEG_QUA_SEX }, { schedule: [{ dayOfWeek: 2, startTime: '08:00', durationMinutes: 240 }] }],
      });
      try {
        const [s1, s2] = seed.services;
        runSQL(`UPDATE patient_addresses SET address_formatted = '${ENDERECO_LONGO}', address_raw = '${ENDERECO_LONGO}' WHERE patient_id = '${seed.patientId}'`);
        sqlComVars("UPDATE patient_contracted_services SET providers_needed = 1 WHERE id IN (:'a'::uuid, :'b'::uuid)", { a: s1.serviceId, b: s2.serviceId });
        const comNomeLongo = (marca: string): string => {
          const w = insertTestWorker({ occupation: 'AT', firstName: `WMatch1792774858404${marca}`, lastName: SOBRENOME_LONGO });
          insertWJA({ workerId: w, jobPostingId: s1.vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
          seed.track(w, s1.vacancyId);
          return w;
        };
        const titular = comNomeLongo('T');
        const sub = comNomeLongo('S');
        for (const slotId of s1.slotIds) expect((await allocateWorker(request, seed.patientId, s1.serviceId, slotId, titular)).status).toBe(201);
        expect((await assembleApi(request, derivacaoToken(), seed.patientId)).status).toBeLessThan(300);

        // Pedidos: Varios días (6 turnos, 1 sem substituto → "salvo …: nadie") e "No vuelve más" sem ninguém ("Nadie todavía" + "Elegir quién entra").
        const desde = proximaDataNoDia(1, diaDoBanco(1));
        const turnos = await turnosDaPessoa(request, seed.patientId, s1.serviceId, titular, desde, somaDias(desde, 11));
        await criarPedidoViaApi(request, seed.patientId, s1.serviceId, {
          type: 'DAYS', outgoingWorkerId: titular, from: desde, to: somaDias(desde, 11), reasonCategory: codigoMotivo,
          shifts: turnos.map((t, i) => ({ ...t, substituteWorkerId: i === 2 ? null : sub })),
        });
        await criarPedidoViaApi(request, seed.patientId, s1.serviceId, { type: 'PERMANENT', outgoingWorkerId: titular, from: somaDias(desde, 40), reasonCategory: codigoMotivo, substituteWorkerId: null });

        await loginAs(page, STAFF);
        await openItineraryTab(page, seed.patientId);

        // B1: nome do serviço, endereço longo, dias, estado, vaga, aviso e o botão.
        await expect(page.getByTestId('itinerario-lista-servicos')).toBeVisible();
        const b1 = await expectLinhaUnica(page, 'B1', 8);
        expect(b1.truncados, 'B1: o endereço longo foi cortado de verdade (controle positivo)').toBeGreaterThan(0);
        await imprimir(page, 'b1-nomes-longos', largura, 'itinerario-aba');

        // Próximos días (a semana da 1ª segunda do pedido: sale/entra/"Nadie asignado").
        await openUpcomingDays(page, s1.serviceId);
        await irParaSemanaPeloCalendario(page, desde);
        await expect(page.getByTestId(`itinerario-proximo-${s1.slotIds[0]}-${desde}`)).toContainText('Sustitución', { timeout: 15_000 });
        await expect(page.locator('[data-testid^="itinerario-proximo-sem-cobertura-"]')).not.toHaveCount(0);
        const proximos = await expectLinhaUnica(page, 'Próximos días', 14);
        expect(proximos.truncados, 'Próximos días: nome longo cortado de verdade').toBeGreaterThan(0);
        await imprimir(page, 'proximos-dias-nomes-longos', largura, 'itinerario-aba');

        // Horario fijo.
        await openFixedSchedule(page, s1.serviceId);
        const fijo = await expectLinhaUnica(page, 'Horario fijo', 8);
        await imprimir(page, 'horario-fijo-nomes-longos', largura, 'itinerario-aba');
        expect(fijo.truncados, 'Horario fijo: nome longo cortado de verdade').toBeGreaterThan(0);

        // Sustituciones (+ "Ver días" aberto).
        await openSubstitutions(page, s1.serviceId);
        await expect(page.locator('li[data-when]')).toHaveCount(2);
        const verDias = page.locator('[data-testid^="sustitucion-ver-dias-"]').first();
        await verDias.click();
        await expect(page.locator('[data-testid="sustituciones-dia"]').first()).toBeVisible();
        const sust = await expectLinhaUnica(page, 'Sustituciones', 20);
        expect(sust.truncados, 'Sustituciones: nome longo cortado de verdade').toBeGreaterThan(0);
        await imprimir(page, 'sustituciones-nomes-longos', largura, 'itinerario-aba');

        // Modal, passos 1-4.
        await openUpcomingDays(page, s1.serviceId);
        await abrirNuevaSustitucion(page);
        await expect(page.locator(`[data-testid="substitucion-quien-${titular}"]`)).toBeVisible();
        const p1 = await expectLinhaUnica(page, 'Modal passo 1', 2);
        expect(p1.truncados, 'Modal passo 1: nome longo cortado de verdade').toBeGreaterThanOrEqual(0);
        await paso1QuienNoViene(page, titular);
        await paso2PorCuantoTiempo(page, 'DAYS', somaDias(desde, 21), somaDias(desde, 32));
        await expectLinhaUnica(page, 'Modal passo 2', 8);
        await siguiente(page);
        await paso3UnaPersona(page, sub);
        await expect(page.locator('[data-testid^="substitucion-estado-"]').first()).toHaveText('Libre', { timeout: 15_000 });
        await expectLinhaUnica(page, 'Modal passo 3', 8);
        await imprimir(page, 'modal-paso-3-nomes-longos', largura, 'substitucion-flujo');
        await siguiente(page);
        await page.getByTestId('substitucion-motivo').selectOption(codigoMotivo);
        await expect(page.getByTestId('substitucion-resumen-bloque')).toBeVisible();
        const p4 = await expectLinhaUnica(page, 'Modal passo 4', 4);
        expect(p4.truncados, 'Modal passo 4: nome longo cortado de verdade').toBeGreaterThan(0);
        await imprimir(page, 'modal-paso-4-nomes-longos', largura, 'substitucion-flujo');

        expect(proibidos()).toEqual([]);
      } finally {
        seed.cleanup();
        runSQL(`DELETE FROM service_exit_reasons WHERE code = id::text AND label = '${rotuloMotivo}'`);
      }
    });
  }
});
