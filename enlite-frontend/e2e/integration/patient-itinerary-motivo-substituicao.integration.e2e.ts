/**
 * patient-itinerary-motivo-substituicao.integration.e2e.ts @integration — Fase 2 da change
 * itinerario-trocas-motivos-e-figma: a substituição de um dia passa a pedir o
 * motivo de uma lista fechada, o CATÁLOGO de motivos de saída (Fase 1). Stack REAL (frontend + API +
 * Postgres), sem mock de dado — só a auth é o mock do stack (token `mock_*`, molde
 * `patient-itinerary-catalogo-motivos`). Régua humana (memória `e2e-humano-nao-e-fill`): click +
 * `keyboard.type` + valor lido da tela; nenhum `fill()`.
 *
 * Os 2 testes (serial, um `describe`):
 *   1. FELIZ — aba Itinerario, "Nuevo +" → faixa → data → substituto → motivo "Cambio de disponibilidad"
 *      (criado na semente do teste pela API do catálogo) → Confirmar; o card aparece e
 *      `GET …/itinerary/changes` tem 1 linha `ABSENCE` com esse `reasonCode` (lido na mesma execução);
 *   2. ALTERNATIVO 1 — sem motivo, "Confirmar" fica desabilitado e nenhuma requisição `POST …/absences` sai;
 *   (041 R3: o ALTERNATIVO 2, que provava o modal de rejeitar da aba Encuadre, saiu com a aba.)
 *
 * Re-executável: antes e depois remove o item criado (só o que o admin criou: `code = id::text`) e reativa
 * "Otro". O arquivo entra no `--grep patient-itinerary` do pr-gate (casa pelo caminho).
 */
import { test, expect, type Page } from '@playwright/test';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginAs, tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import { backendUrl } from '../helpers/lancamento-e2e-helper';
import { seedItinerary, seedTitularAllocation, cleanupItinerary, type ItinerarySeed } from '../helpers/itinerary-db-helper';
import { openUpcomingDays } from '../helpers/itinerario-aba-e2e-helper';
import { abrirNuevaSustitucion, confirmarPedido, paso1QuienNoViene, paso2PorCuantoTiempo, paso3UnaPersona, siguiente, somaDias, irParaSemanaPeloCalendario } from '../helpers/itinerario-069-flow-helper';

const STAMP = Date.now().toString(36);
const ADMIN: MockUser = { uid: `e2e-motivo-subst-${STAMP}`, email: `e2e.motivo.subst.${STAMP}@enlite.test`, role: 'admin', country: 'AR' };

const NOVO = 'Cambio de disponibilidad';
const ROTULO_ANTIGO = 'Sin disponibilidad horaria'; // INDISPONIBILIDADE_DE_HORARIO na carga inicial (F8)

function limpar(): void {
  // Só o que o admin criou (o trigger põe code = id::text); a carga inicial nunca é apagada.
  runSQL(`DELETE FROM service_exit_reasons WHERE code = id::text AND label = '${NOVO}'`);
  runSQL(`UPDATE service_exit_reasons SET active = true, deactivated_at = NULL WHERE code = 'OTHER'`);
}

function codigoDoNovo(): string {
  return runSQL(`SELECT code FROM service_exit_reasons WHERE label = '${NOVO}' AND active`).split('\n')[0].trim();
}

async function abrirAbaItinerario(page: Page, patientId: string, serviceId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await page.getByTestId('patient-profile-tabs').getByText('Itinerario', { exact: true }).click();
  await expect(page.getByTestId('itinerario-aba')).toBeVisible({ timeout: 15_000 });
  await openUpcomingDays(page, serviceId);
}

/** "Nueva sustitución" → ¿Quién? (o titular) → Un solo día (a 2ª segunda) → una persona (o substituto) → passo 4 aberto, motivo por escolher. */
async function preencherSubstituicao(page: Page, seed: ItinerarySeed, substitutoId: string): Promise<string> {
  const data = await segundaDeOutraSemana(seed);
  await abrirNuevaSustitucion(page);
  await paso1QuienNoViene(page, seed.titularWorkerId);
  await paso2PorCuantoTiempo(page, 'ONE_DAY', data);
  await siguiente(page);
  await paso3UnaPersona(page, substitutoId);
  await expect(page.locator('[data-testid^="substitucion-estado-"]')).toHaveText('Libre', { timeout: 15_000 });
  await siguiente(page);
  return data;
}

/** A 2ª segunda (a 1ª fica intacta, como no teste antigo): `nextMonday` + 7, calculada NO BANCO. */
async function segundaDeOutraSemana(seed: ItinerarySeed): Promise<string> {
  return somaDias(seed.nextMonday, 7);
}

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe('patient-itinerary — motivo obrigatório na substituição de um dia e na rejeição do Encuadre @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: ItinerarySeed;

  test.beforeAll(async ({ request }) => {
    limpar();
    // O login mock só entra se a conta existir em `users` como admin ativo.
    runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified, status) VALUES ('${ADMIN.uid}', '${ADMIN.email}', 'E2E Motivo Subst', 'admin', true, true, 'ACTIVE') ON CONFLICT (firebase_uid) DO NOTHING`);
    // Semente do item "Cambio de disponibilidad" PELA API do catálogo (a mesma que a tela da Fase 1 usa).
    const criado = await request.post(`${backendUrl()}/api/admin/therapeutic-catalogs/service-exit-reasons`, {
      headers: { Authorization: `Bearer ${tokenFor(ADMIN)}`, 'Content-Type': 'application/json' },
      data: { label: NOVO },
    });
    expect(criado.status(), 'o catálogo aceita o item novo').toBe(201);
    seed = seedItinerary();
    seedTitularAllocation(seed);
  });

  test.afterAll(() => {
    runSQL(`DELETE FROM contracted_service_rejections WHERE service_id = '${seed.serviceId}'`);
    cleanupItinerary(seed);
    limpar();
    runSQL(`DELETE FROM users WHERE firebase_uid = '${ADMIN.uid}'`);
  });

  test('FELIZ: "Nueva sustitución" com motivo do catálogo → o pedido sai e o registro de trocas tem 1 ABSENCE com esse motivo', async ({ page, request }) => {
    await loginAs(page, ADMIN);
    await abrirAbaItinerario(page, seed.patientId, seed.serviceId);
    const data = await preencherSubstituicao(page, seed, seed.freeSubstituteWorkerId);

    // O campo de motivo lista o catálogo ativo: o item criado pelo admin e os antigos.
    const opcoes = (await page.getByTestId('substitucion-motivo').locator('option').allInnerTexts()).map((t) => t.trim());
    expect(opcoes).toContain(NOVO);
    expect(opcoes).toContain(ROTULO_ANTIGO);

    await expect(page.getByTestId('substitucion-confirmar')).toBeDisabled(); // falta o motivo
    await page.getByTestId('substitucion-motivo').selectOption({ label: NOVO });
    await expect(page.getByTestId('substitucion-confirmar')).toBeEnabled();
    const resp = await confirmarPedido(page);
    expect(resp.status()).toBe(201);

    await expect(page.getByTestId('substitucion-flujo')).toHaveCount(0, { timeout: 10_000 });
    await irParaSemanaPeloCalendario(page, data);
    const turno = page.locator(`[data-testid^="itinerario-proximo-"][data-testid$="-${data}"]`).first();
    await expect(turno).toContainText(seed.names.free, { timeout: 10_000 });

    // Lido na MESMA execução: a API de leitura do registro de trocas.
    const res = await request.get(
      `${backendUrl()}/api/admin/patients/${seed.patientId}/contracted-services/${seed.serviceId}/itinerary/changes`,
      { headers: { Authorization: `Bearer ${tokenFor(ADMIN)}` } },
    );
    expect(res.status()).toBe(200);
    const { changes } = (await res.json()).data as { changes: Array<{ kind: string; reasonCode: string; reasonLabel: string; effectiveDate: string; incomingWorkerId: string | null }> };
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'ABSENCE', reasonCode: codigoDoNovo(), reasonLabel: NOVO, effectiveDate: data, incomingWorkerId: seed.freeSubstituteWorkerId });
  });

  test('ALTERNATIVO 1: sem motivo, "Confirmar" fica desabilitado e nenhum POST …/substitution-requests sai', async ({ page }) => {
    const postsDoPedido: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/substitution-requests')) postsDoPedido.push(r.url());
    });
    const antes = Number(runSQL(`SELECT count(*) FROM patient_itinerary_change_log WHERE contracted_service_id = '${seed.serviceId}'`));

    await loginAs(page, ADMIN);
    await abrirAbaItinerario(page, seed.patientId, seed.serviceId);
    // Paula já virou substituta no teste 1 (Em Atendimento); aqui serve outra Selecionada.
    await preencherSubstituicao(page, seed, seed.substituteWorkerId);

    const confirmar = page.getByTestId('substitucion-confirmar');
    await expect(confirmar).toBeDisabled();
    await confirmar.click({ force: true }); // um clique forçado num botão desabilitado não dispara nada
    await page.waitForTimeout(1_000);

    expect(postsDoPedido).toHaveLength(0);
    expect(Number(runSQL(`SELECT count(*) FROM patient_itinerary_change_log WHERE contracted_service_id = '${seed.serviceId}'`))).toBe(antes);
  });
});
