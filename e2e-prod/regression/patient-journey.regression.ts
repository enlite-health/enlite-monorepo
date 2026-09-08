/**
 * patient-journey.regression.ts — a jornada REAL do paciente contra PRODUÇÃO.
 *
 * O pedido do dono, ao pé da letra: "desde fazer cadastro no site, acompanhar
 * todos os logs para saber se realmente está cadastrando, se realmente está
 * gravando no calendar, se realmente está enviando mensagem, se realmente está
 * mudando o número do big number EM TELA — não quero saber de APENAS ver o
 * retorno".
 *
 * Por isso NENHUM passo aqui se contenta com o 200 da API. Cada afirmação tem uma
 * fonte independente do nosso próprio código:
 *
 *   cadastrou       → o LOG do backend em Cloud Logging + o registro visível
 *   gravou no calendar → o GOOGLE respondendo com o evento na agenda de admissão
 *   mandou mensagem → ver abaixo
 *   mudou o big number → o TEXTO renderizado em /admin/dashboard, lido do DOM
 *                        depois de um reload de verdade
 *
 * ── Sobre a mensagem ──────────────────────────────────────────────────────────
 * O envio é Twilio DIRETO (sem outbox) e cobra por mensagem. Pior que o custo:
 * se o telefone sintético colidisse com um número real, este teste mandaria
 * WhatsApp para uma pessoa de verdade todo dia às 3h. Por isso o backend nunca
 * envia para paciente `is_test` (gate em RealAdmissionNotifier).
 *
 * Aqui a gente prova que o pipeline CHEGOU no notifier e que o gate segurou
 * (log `admission.notifier.skipped_test_patient`). Que o envio real está de pé é
 * medido pelo smoke `admission-whatsapp-health`, sobre pacientes REAIS, sem gastar
 * um centavo. As duas metades juntas respondem "está enviando?".
 *
 * ── Teardown ──────────────────────────────────────────────────────────────────
 * O passo final PURGA o paciente (endpoint que só aceita is_test) e confere que o
 * big number VOLTOU e que o evento SUMIU do Google. Um run que morre no meio deixa
 * o registro marcado is_test — o sweeper limpa na próxima execução.
 */
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { newAdminApiContext } from '../src/support/adminApi';
import { waitForLog, payloadString } from '../src/support/cloudLogging';
import { findAdmissionEventAtSlot, waitForSlotFree } from '../src/support/admissionCalendar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

const COUNTRY = 'AR' as const;

/**
 * Marca do run. O email leva o prefixo que o sweeper procura; o telefone fica numa
 * faixa obviamente sintética (55555 no meio) para nunca cair num celular real.
 */
const RUN_ID = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const LEAD_EMAIL = `gabriel+e2e-patient-${RUN_ID}@gmail.com`;
const LEAD_PHONE = `+54 9 11 5555 ${String(RUN_ID).slice(-4)}`;
/**
 * Nome E sobrenome: o campo virou obrigatório no form em 02/09 e a tela exige duas
 * palavras (`AdmisionPage`, refine `needsLastName`), espelhando o `publicLeadSchema`
 * do servidor. Com uma palavra só o zod barra ANTES do submit e nenhum POST sai — foi
 * o que deixou este passo vermelho de 03/09 a 07/09. Sintético e identificável, como
 * o email e o telefone acima.
 */
const LEAD_NAME = `E2E Paciente ${RUN_ID}`;

/** Estado que atravessa os passos (describe.serial). */
const journey: {
  patientId?: string;
  slotStartISO?: string;
  meetLink?: string;
  calendarEventId?: string;
  solicitantesAntes?: number;
  solicitantesDepois?: number;
} = {};

/** Lê o número renderizado num card do funil (o que o humano enxerga). */
async function lerBigNumber(page: Page, testId: string): Promise<number> {
  const card = page.getByTestId(testId);
  await expect(card).toBeVisible({ timeout: 30_000 });
  const texto = (await card.innerText()).replace(/\s+/g, ' ');
  const match = texto.match(/(\d+)/);
  expect(match, `card ${testId} sem número legível: "${texto}"`).not.toBeNull();
  return Number(match![1]);
}

/**
 * Abre o dashboard com a sessão admin e devolve o valor de Solicitantes NA TELA.
 *
 * Espera a resposta do funil ANTES de ler o DOM: o card renderiza `0` enquanto a
 * requisição está em voo, e ler nesse instante dá um zero falso (foi exatamente
 * o que aconteceu na primeira execução desta jornada).
 *
 * Além de devolver o número, confere que o que está PINTADO bate com o que a API
 * respondeu — se um dia a tela parar de refletir o dado, isto pega.
 */
async function lerSolicitantesNaTela(browser: Browser): Promise<number> {
  const ctx = await browser.newContext({ storageState: ADMIN_AUTH_FILE });
  const page = await ctx.newPage();
  try {
    const [resposta] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/admin/patients/funnel') && r.status() === 200,
        { timeout: 60_000 },
      ),
      page.goto('/admin/dashboard'),
    ]);
    const daApi = ((await resposta.json()) as { data: { solicitantes: number } }).data.solicitantes;

    await expect(page.getByTestId('mgmt-pacientes')).toBeVisible({ timeout: 40_000 });
    await expect
      .poll(() => lerBigNumber(page, 'funnel-solicitantes'), { timeout: 30_000 })
      .toBe(daApi);

    return daApi;
  } finally {
    await ctx.close();
  }
}

test.describe.serial('Jornada do paciente — do form no site ao big number na tela', () => {
  let adminCtx: APIRequestContext | undefined;

  test.beforeAll(async () => {
    adminCtx = await newAdminApiContext();
  });

  test.afterAll(async () => {
    // Rede de segurança: se um passo intermediário quebrou DEPOIS de criar o
    // paciente, o purge do passo final não rodou. Tenta aqui; o sweeper cobre o
    // resto. Nunca falha o run por causa da limpeza — o alerta é do teste.
    if (journey.patientId && adminCtx) {
      await adminCtx
        .delete(`/api/admin/patients/${journey.patientId}`)
        .catch(() => undefined);
    }
    await adminCtx?.dispose();
  });

  test('[@route:/admin/dashboard @depth:happy] 1. big number ANTES, lido na tela', async ({ browser }) => {
    journey.solicitantesAntes = await lerSolicitantesNaTela(browser);
    expect(journey.solicitantesAntes).toBeGreaterThanOrEqual(0);
    test.info().annotations.push({
      type: 'evidência',
      description: `Solicitantes na tela ANTES: ${journey.solicitantesAntes}`,
    });
  });

  test('[@route:/admission-ar @depth:happy] 2. cadastro E agendamento pela TELA do site', async ({ page }) => {
    await page.goto(`/admission-${COUNTRY.toLowerCase()}`);
    await expect(page.getByTestId('lead-form')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('lead-serviceType').selectOption('cuidadores');
    await page.getByTestId('lead-requesterType-patient').check();
    await page.getByTestId('lead-name').fill(LEAD_NAME);
    await page.getByTestId('lead-email').fill(LEAD_EMAIL);
    await page.getByTestId('lead-phone').fill(LEAD_PHONE);
    // O checkbox é exigido pelo form. Marcamos como um usuário marcaria — quem
    // impede a mensagem é o gate is_test no backend, não um atalho aqui.
    await page.getByTestId('lead-consent').check();

    const [leadResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/public/v1/leads') && r.request().method() === 'POST',
        { timeout: 45_000 },
      ),
      page.getByTestId('lead-submit').click(),
    ]);
    expect(leadResponse.status(), 'POST /leads deveria criar (201)').toBe(201);
    journey.patientId = ((await leadResponse.json()) as { data?: { id?: string } }).data?.id;
    expect(journey.patientId, 'a resposta do lead precisa trazer o id do paciente').toBeTruthy();

    // ⚠️ ORDEM CRÍTICA: marcar is_test AGORA, entre o lead e o agendamento.
    // O gate anti-WhatsApp do notifier lê a flag NO MOMENTO DO BOOKING. Marcar
    // depois do clique no horário chegaria tarde: a mensagem já teria saído, com
    // custo Twilio e risco de acertar um número real. Não mova isto para baixo.
    const flagRes = await adminCtx!.patch(
      `/api/admin/patients/${journey.patientId}/test-flag`,
      { data: { isTest: true } },
    );
    expect(flagRes.status(), await flagRes.text()).toBe(200);
    expect(((await flagRes.json()) as { data: { isTest: boolean } }).data.isTest).toBe(true);

    // A tela avança sozinha para a agenda — é o que o usuário vê.
    await expect(page.getByTestId('slot-picker')).toBeVisible({ timeout: 45_000 });

    // Escolhe o PRIMEIRO horário oferecido, clicando como uma pessoa clicaria.
    const opcoes = page.locator('[data-testid^="slot-option-"]');
    await expect(opcoes.first()).toBeVisible({ timeout: 45_000 });
    journey.slotStartISO = (await opcoes.first().getAttribute('data-testid'))!.replace(
      'slot-option-',
      '',
    );

    const [bookResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/public/v1/admission/book') && r.request().method() === 'POST',
        { timeout: 60_000 },
      ),
      opcoes.first().click(),
    ]);
    // 200 (não 201) e SEM appointmentId no corpo — contrato real do
    // AdmissionSchedulingController: { hostDisplayName, slotStartISO, meetLink }.
    expect(bookResponse.status(), await bookResponse.text()).toBe(200);
    const booked = (await bookResponse.json()) as {
      hostDisplayName: string | null;
      slotStartISO: string;
      meetLink: string;
    };
    journey.meetLink = booked.meetLink;
    expect(journey.meetLink).toMatch(/^https:\/\/meet\.google\.com\//);

    // E a confirmação aparece NA TELA, com o link do Meet — não só no JSON.
    await expect(page.getByTestId('booking-confirmation')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('confirmation-meet-link')).toBeVisible();
  });

  test('4. LOG prova que o cadastro chegou no backend', async () => {
    const entry = await waitForLog({
      message: 'create_lead.completed',
      withinMinutes: 15,
      match: { patientId: journey.patientId! },
    });
    expect(
      entry,
      'sem `create_lead.completed` com este patientId — o cadastro não chegou no backend',
    ).not.toBeNull();
  });

  test('6. o evento existe MESMO no Google Calendar (fonte externa)', async () => {
    const evento = await findAdmissionEventAtSlot(COUNTRY, journey.slotStartISO!);
    expect(
      evento,
      `o Google não tem evento na agenda de admissão ${COUNTRY} às ${journey.slotStartISO}`,
    ).not.toBeNull();
    expect(evento!.status).not.toBe('cancelled');
    journey.calendarEventId = evento!.id;
    // O Meet vem do próprio evento — se o link existe, a conferência foi criada.
    expect(journey.meetLink).toMatch(/^https:\/\/meet\.google\.com\//);
    test.info().annotations.push({
      type: 'evidência',
      description: `Evento no Google: ${evento!.id} — "${evento!.summary ?? ''}"`,
    });
  });

  test('7. o notifier rodou e NÃO mandou WhatsApp (paciente sintético)', async () => {
    const entry = await waitForLog({
      message: 'admission.notifier.skipped_test_patient',
      withinMinutes: 15,
      // por patientId: o corpo do book não expõe appointmentId, mas o log traz os dois.
      match: { patientId: journey.patientId! },
    });
    expect(
      entry,
      'sem `skipped_test_patient`: ou o notifier não rodou, ou o gate falhou e a Twilio foi cobrada',
    ).not.toBeNull();
    expect(payloadString(entry, 'appointmentId'), 'o log precisa identificar a entrevista').toBeTruthy();
  });

  test('[@route:/admin/dashboard @depth:happy] 8. o big number SUBIU na tela', async ({ browser }) => {
    journey.solicitantesDepois = await lerSolicitantesNaTela(browser);
    expect(
      journey.solicitantesDepois! - journey.solicitantesAntes!,
      `Solicitantes na tela: antes ${journey.solicitantesAntes}, depois ${journey.solicitantesDepois}`,
    ).toBeGreaterThanOrEqual(1);
    test.info().annotations.push({
      type: 'evidência',
      description: `Solicitantes na tela: ${journey.solicitantesAntes} → ${journey.solicitantesDepois}`,
    });
  });

  test('9. purge limpa tudo e o big number VOLTA na tela', async ({ browser }) => {
    const res = await adminCtx!.delete(`/api/admin/patients/${journey.patientId}`);
    expect(res.status(), await res.text()).toBe(200);
    const { data } = (await res.json()) as {
      data: { appointmentsCancelled: number; calendarEventsDeleted: number; calendarEventsFailed: number };
    };
    expect(data.appointmentsCancelled).toBeGreaterThanOrEqual(1);
    expect(data.calendarEventsFailed, 'evento ficou órfão no Google Calendar').toBe(0);
    expect(data.calendarEventsDeleted).toBeGreaterThanOrEqual(1);

    expect(
      await waitForSlotFree(COUNTRY, journey.slotStartISO!),
      'o horário continuou ocupado no Google Calendar depois do purge',
    ).toBe(true);

    const depoisDaLimpeza = await lerSolicitantesNaTela(browser);
    expect(
      journey.solicitantesDepois! - depoisDaLimpeza,
      `o big number tinha que cair depois da limpeza (era ${journey.solicitantesDepois}, ficou ${depoisDaLimpeza})`,
    ).toBeGreaterThanOrEqual(1);

    // Purgado: some do estado compartilhado para o afterAll não tentar de novo.
    journey.patientId = undefined;
  });
});
