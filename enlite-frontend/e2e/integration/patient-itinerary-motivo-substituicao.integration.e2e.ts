/**
 * patient-itinerary-motivo-substituicao.integration.e2e.ts @integration — Fase 2 da change
 * itinerario-trocas-motivos-e-figma: a substituição de um dia e a rejeição do Encuadre passam a pedir o
 * motivo de uma lista fechada, o CATÁLOGO de motivos de saída (Fase 1). Stack REAL (frontend + API +
 * Postgres), sem mock de dado — só a auth é o mock do stack (token `mock_*`, molde
 * `patient-itinerary-catalogo-motivos`). Régua humana (memória `e2e-humano-nao-e-fill`): click +
 * `keyboard.type` + valor lido da tela; nenhum `fill()`.
 *
 * Os 3 testes (serial, um `describe`):
 *   1. FELIZ — aba Itinerario, "Nuevo +" → faixa → data → substituto → motivo "Cambio de disponibilidad"
 *      (criado na semente do teste pela API do catálogo) → Confirmar; o card aparece e
 *      `GET …/itinerary/changes` tem 1 linha `ABSENCE` com esse `reasonCode` (lido na mesma execução);
 *   2. ALTERNATIVO 1 — sem motivo, "Confirmar" fica desabilitado e nenhuma requisição `POST …/absences` sai;
 *   3. ALTERNATIVO 2 — no Encuadre, rejeitar mostra o item criado pelo admin E os 4 antigos; uma marca antiga
 *      semeada por SQL com `INDISPONIBILIDADE_DE_HORARIO` aparece como "Sin disponibilidad horaria".
 *
 * Re-executável: antes e depois remove o item criado (só o que o admin criou: `code = id::text`) e reativa
 * "Otro". O arquivo entra no `--grep patient-itinerary` do pr-gate (casa pelo caminho).
 */
import { test, expect, type Page } from '@playwright/test';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginAs, tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import { backendUrl } from '../helpers/lancamento-e2e-helper';
import { openEncuadreTab, selectServiceRow } from '../helpers/quadro-c-e2e-helper';
import { seedItinerary, seedTitularAllocation, cleanupItinerary, type ItinerarySeed } from '../helpers/itinerary-db-helper';

const STAMP = Date.now().toString(36);
const ADMIN: MockUser = { uid: `e2e-motivo-subst-${STAMP}`, email: `e2e.motivo.subst.${STAMP}@enlite.test`, role: 'admin', country: 'AR' };

const NOVO = 'Cambio de disponibilidad';
const ROTULO_ANTIGO = 'Sin disponibilidad horaria'; // INDISPONIBILIDADE_DE_HORARIO na carga inicial (F8)
const QUATRO_ANTIGOS = ['PERFIL_INADEQUADO_AO_SERVICO', 'INDISPONIBILIDADE_DE_HORARIO', 'DESISTENCIA_DO_PRESTADOR', 'OTHER'];

function limpar(): void {
  // Só o que o admin criou (o trigger põe code = id::text); a carga inicial nunca é apagada.
  runSQL(`DELETE FROM service_exit_reasons WHERE code = id::text AND label = '${NOVO}'`);
  runSQL(`UPDATE service_exit_reasons SET active = true, deactivated_at = NULL WHERE code = 'OTHER'`);
}

function codigoDoNovo(): string {
  return runSQL(`SELECT code FROM service_exit_reasons WHERE label = '${NOVO}' AND active`).split('\n')[0].trim();
}

async function abrirAbaItinerario(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await page.getByTestId('patient-profile-tabs').getByText('Itinerario', { exact: true }).click();
  await expect(page.getByTestId('itinerario-aba')).toBeVisible({ timeout: 15_000 });
}

/** "Nuevo +" → faixa (já vem pré-selecionada, 1 só) → data (a 2ª segunda) → substituto digitado na busca. */
async function preencherSubstituicao(page: Page, nomeDoSubstituto: string): Promise<string> {
  await page.getByTestId('itinerario-novo-btn').click();
  await expect(page.getByTestId('substitution-slot')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('substitution-date').selectOption({ index: 2 });
  const data = await page.getByTestId('substitution-date').inputValue();
  await page.getByTestId('substitution-worker').click();
  const busca = page.getByPlaceholder('Buscar...');
  await busca.click();
  await page.keyboard.type(nomeDoSubstituto.slice(0, 5));
  await page.getByRole('listbox').getByText(nomeDoSubstituto).click(); // dentro da lista do SearchableSelect (o <option> nativo de outro select não serve)
  return data;
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

  test('FELIZ: "Nuevo +" com motivo do catálogo → o card aparece e o registro de trocas tem 1 ABSENCE com esse motivo', async ({ page, request }) => {
    await loginAs(page, ADMIN);
    await abrirAbaItinerario(page, seed.patientId);
    const data = await preencherSubstituicao(page, seed.names.free);

    // O campo de motivo lista o catálogo ativo: o item criado pelo admin e os antigos.
    const opcoes = (await page.getByTestId('substitution-reason').locator('option').allInnerTexts()).map((t) => t.trim());
    expect(opcoes).toContain(NOVO);
    expect(opcoes).toContain(ROTULO_ANTIGO);

    await expect(page.getByTestId('substitution-confirm')).toBeDisabled(); // falta o motivo
    await page.getByTestId('substitution-reason').selectOption({ label: NOVO });
    await expect(page.getByTestId('substitution-confirm')).toBeEnabled();
    await page.getByTestId('substitution-confirm').click();

    await expect(page.getByTestId('substitution-modal')).toHaveCount(0, { timeout: 10_000 });
    const eventoPrestador = page.locator(`[data-testid^="itinerario-evento-prestador-"][data-testid$="-${data}"]`);
    await expect(eventoPrestador).toContainText(seed.names.free, { timeout: 10_000 });

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

  test('ALTERNATIVO 1: sem motivo, "Confirmar" fica desabilitado e nenhum POST …/absences sai', async ({ page }) => {
    const postsDeAusencia: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/absences')) postsDeAusencia.push(r.url());
    });
    const antes = Number(runSQL(`SELECT count(*) FROM patient_itinerary_change_log WHERE contracted_service_id = '${seed.serviceId}'`));

    await loginAs(page, ADMIN);
    await abrirAbaItinerario(page, seed.patientId);
    // Paula já virou substituta no teste 1 (Em Atendimento); aqui serve outra Selecionada.
    await preencherSubstituicao(page, seed.names.substitute);

    const confirmar = page.getByTestId('substitution-confirm');
    await expect(confirmar).toBeDisabled();
    await confirmar.click({ force: true }); // um clique forçado num botão desabilitado não dispara nada
    await page.waitForTimeout(1_000);

    expect(postsDeAusencia).toHaveLength(0);
    expect(Number(runSQL(`SELECT count(*) FROM patient_itinerary_change_log WHERE contracted_service_id = '${seed.serviceId}'`))).toBe(antes);
  });

  test('ALTERNATIVO 2: no Encuadre, rejeitar mostra o item do admin E os 4 antigos; a marca antiga aparece com o rótulo do catálogo', async ({ page }) => {
    // Marca ANTIGA semeada por SQL (como se viesse de antes da Fase 2): INDISPONIBILIDADE_DE_HORARIO.
    runSQL(
      `INSERT INTO contracted_service_rejections (service_id, worker_id, rejected_by, reject_reason_category, created_by, updated_by) ` +
        `VALUES ('${seed.serviceId}', '${seed.permanentWorkerId}', 'e2e', 'INDISPONIBILIDADE_DE_HORARIO', 'e2e', 'e2e')`,
    );

    await loginAs(page, ADMIN);
    await openEncuadreTab(page, seed.patientId);
    await selectServiceRow(page, seed.serviceId);

    const cardAntigo = page.getByTestId('kanban-column-REJECTED_FOR_SERVICE').getByTestId(`service-team-card-${seed.permanentWorkerId}`);
    await expect(cardAntigo).toBeVisible({ timeout: 15_000 });
    await expect(cardAntigo).toContainText(ROTULO_ANTIGO);
    await expect(cardAntigo).not.toContainText('INDISPONIBILIDADE_DE_HORARIO');

    await page.getByTestId(`service-team-reject-${seed.substituteWorkerId}`).click();
    await expect(page.getByTestId('service-team-reject-modal')).toBeVisible();
    const codigoNovo = codigoDoNovo();
    const opcao = (code: string) => page.getByTestId(`service-team-reject-option-${code.toLowerCase().replace(/_/g, '-')}`);
    for (const code of QUATRO_ANTIGOS) await expect(opcao(code)).toBeVisible();
    await expect(opcao(codigoNovo)).toContainText(NOVO);

    await opcao(codigoNovo).click();
    const rejeitou = page.waitForResponse((r) => r.request().method() === 'POST' && /\/team\/reject$/.test(r.url()) && r.ok());
    await page.getByTestId('service-team-reject-confirm').click();
    await rejeitou;

    const cardNovo = page.getByTestId('kanban-column-REJECTED_FOR_SERVICE').getByTestId(`service-team-card-${seed.substituteWorkerId}`);
    await expect(cardNovo).toContainText(NOVO, { timeout: 15_000 });
    expect(runSQL(`SELECT reject_reason_category FROM contracted_service_rejections WHERE service_id = '${seed.serviceId}' AND worker_id = '${seed.substituteWorkerId}' AND reverted_at IS NULL`).trim()).toBe(codigoNovo);
  });
});
