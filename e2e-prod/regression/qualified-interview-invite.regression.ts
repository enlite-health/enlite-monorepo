/**
 * qualified-interview-invite.regression.ts — o fluxo D224 ponta a ponta, contra PRODUÇÃO,
 * ATÉ A ÚLTIMA LINHA ANTES DO ENVIO.
 *
 * POR QUE EXISTE
 *   Arrastar a tarjeta para QUALIFIED dispara convite de entrevista por WhatsApp
 *   (D224, decisão do Gabriel em 30/08 — vai a produção disparando). Era o único
 *   caminho da release da planning 26/08 que ENVIA mensagem real e que nunca tinha
 *   sido verificado ponta a ponta: o deploy provava que o código subiu, não que o
 *   fluxo funciona.
 *
 * O QUE ESTE TESTE PROVA (a cadeia inteira, um elo por vez)
 *   1. vaga is_test com SLOT RECORRENTE resolve horário futuro  → sem isso o handler
 *      pula com NO_FUTURE_SLOT (era a causa de 304/307 pulos em prod, diário 29/08);
 *   2. mover a tarjeta emite `funnel_stage.qualified` (FunnelStageEventEmitter);
 *   3. o DomainEventProcessor entrega ao QualifiedInterviewHandler com `meta.eventId`
 *      da LINHA (D187);
 *   4. o handler ENFILEIRA em `messaging_outbox` com o template certo;
 *   5. o OutboxProcessor NÃO envia, porque o worker é is_test → status 'suppressed'.
 *
 * POR QUE NÃO ENVIA (e por que isso não é trapaça)
 *   O passo 5 é um GUARD DE PRODUÇÃO, não um mock: o `OutboxProcessor` passou a checar
 *   `workers.is_test` no mesmo ponto único de defesa do opt-out. Antes dele, fixture de
 *   teste em prod virava mensagem real e a Twilio cobrava — e a única defesa era escolher
 *   uma profissão que não desse match (ver o comentário "SEGURANÇA" em
 *   worker-journey-postularse.regression.ts), o que testava o não-envio por acidente.
 *   Aqui o envio é EXERCITADO e bloqueado no último metro, com a razão registrada.
 *
 * ⚠️ ORDEM OBRIGATÓRIA — NÃO INVERTA
 *   Este teste EXERCITA o envio de propósito: ele arrasta a tarjeta e deixa o convite
 *   chegar até a `messaging_outbox`. Quem impede a mensagem de sair é o guard de
 *   `is_test` no OutboxProcessor. Enquanto esse guard NÃO estiver DEPLOYADO em produção,
 *   rodar este spec ENVIA WhatsApp de verdade — e `uniqueArMobile()` gera um número AR
 *   sintético que pode pertencer a uma pessoa real.
 *
 *   Por isso guard e spec vão no MESMO PR: quando o monitor (Cloud Run Job) é
 *   reconstruído a partir do `main`, o guard já está no ar. Rodar
 *   `npm run test:regression` de um branch cujo guard ainda não subiu é o único jeito
 *   de causar o dano — e exige E2E_ADMIN_EMAIL + FIREBASE_API_KEY, ou seja, é ato
 *   deliberado. Não faça.
 *
 * ZERO MOCK (regra do monitor): tudo é HTTP real contra a API de produção.
 *
 * TEARDOWN: `POST /api/admin/test-fixtures/cleanup` apaga worker + vaga + a linha de
 * `messaging_outbox` (DELETE ... WHERE worker_id IN (is_test)). As 2 tabelas novas da
 * release (interview_invite_skips, funnel_stage_message_log) são ON DELETE CASCADE.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newAdminApiContext } from '../src/support/adminApi';
import { signUpWorker, newWorkerApiContext, deleteWorkerAuthAccount } from '../src/support/workerApi';
import { uniqueArMobile, completeCaregiverRegistration } from '../src/support/workerRegistration';

const STAMP = Date.now();
const WORKER_EMAIL = `e2e-qualified-${STAMP}@enlite.import`;
const WORKER_PASSWORD = 'E2eQualified!2026';

/** Template que o QualifiedInterviewHandler enfileira. */
const EXPECTED_TEMPLATE = 'qualified_worker_request';

type PatientsListBody = { data: { id: string; caseNumber: number | null }[] };
type CreateVacancyBody = { data: { id: string; is_test: boolean } };
type FunnelBody = { data: { stages: Record<string, { id: string; encuadreId: string | null; workerId: string | null; internalStage: string | null }[]> } };
type DeliveryBody = {
  data: {
    wjaStage: string | null;
    outbox: { status: string; deliveryStatus: string | null; twilioSid: string | null; channel: string | null; templateSlug: string } | null;
  };
};

test.describe('D224 — arrasto para QUALIFIED enfileira o convite e o guard is_test barra o envio', () => {
  let adminCtx: APIRequestContext | undefined;
  let workerCtx: APIRequestContext | undefined;
  let workerIdToken: string | undefined;
  let workerId: string | undefined;
  let vacancyId: string | undefined;

  test.afterAll(async () => {
    // afterAll NUNCA falha por limpeza (best-effort), mas o teste principal PROVA a limpeza.
    if (workerIdToken) await deleteWorkerAuthAccount(workerIdToken);
    if (adminCtx) {
      try {
        await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: {} });
      } catch {
        // best-effort
      }
    }
    await workerCtx?.dispose();
    await adminCtx?.dispose();
  });

  test('[@route:PUT /api/admin/encuadres/:id/move @depth:happy][@route:GET /api/admin/vacancies/:vacancyId/workers/:workerId/delivery-status @depth:happy] QUALIFIED → outbox enfileirado com o template certo → NÃO enviado (suppressed: is_test)', async () => {
    test.skip(
      !process.env.E2E_ADMIN_EMAIL || !process.env.FIREBASE_API_KEY,
      'requer E2E_ADMIN_EMAIL + FIREBASE_API_KEY (writes autenticados em prod)',
    );

    adminCtx = await newAdminApiContext();

    // ── 1. worker fresco, REGISTERED (track-channel exige) ──────────────────────
    const { idToken, localId } = await signUpWorker(WORKER_EMAIL, WORKER_PASSWORD);
    workerIdToken = idToken;
    workerCtx = await newWorkerApiContext(idToken);

    const initRes = await workerCtx.post('/api/workers/init', {
      data: { authUid: localId, email: WORKER_EMAIL, lgpdOptIn: true, country: 'AR' },
    });
    expect(initRes.status(), 'POST /api/workers/init cria o worker (201)').toBe(201);
    // ⚠️ `/api/workers/init` devolve `{ status, worker }` — NÃO `{ id }`.
    // Medido em 31/08 lendo `InitWorkerOutput` (união discriminada) depois de prod
    // devolver `invalid input syntax for type uuid: "undefined"`: a extração `.data.id`
    // dava `undefined`, que virava a STRING "undefined" na URL do passo seguinte.
    // O `worker-journey`, que roda verde todo dia, sempre fez assim — e assere as duas
    // coisas abaixo, que é o que transforma o defeito num erro no lugar certo.
    const initBody = (await initRes.json()) as { data: { status: string; worker: { id: string } } };
    expect(initBody.data.status, 'init retorna status "ok" (não claim_pending)').toBe('ok');
    workerId = initBody.data.worker.id;
    expect(workerId, 'init retorna o id do worker criado').toBeTruthy();

    await completeCaregiverRegistration(workerCtx, uniqueArMobile());

    // ── 2. marca is_test ANTES de qualquer coisa que possa enfileirar mensagem ──
    // A ORDEM IMPORTA: o guard do OutboxProcessor lê is_test no momento do envio, mas
    // marcar depois de enfileirar seria apostar na corrida. Marca-se primeiro.
    const flagRes = await adminCtx.patch(`/api/admin/workers/${workerId}/test-flag`, {
      data: { isTest: true },
    });
    expect(flagRes.status(), 'PATCH /workers/:id/test-flag marca is_test (200)').toBe(200);

    // ── 3. vaga is_test referenciando um paciente REAL (não criamos paciente) ───
    const patientsRes = await adminCtx.get('/api/admin/patients');
    expect(patientsRes.status(), 'GET /api/admin/patients responde 200').toBe(200);
    const [patient] = ((await patientsRes.json()) as PatientsListBody).data;
    if (!patient) {
      test.skip(true, 'prod não tem paciente para referenciar a vaga is_test');
      return;
    }

    const createRes = await adminCtx.post('/api/admin/vacancies', {
      data: {
        case_number: patient.caseNumber ?? 0,
        patient_id: patient.id,
        is_test: true,
        required_professions: ['CAREGIVER'],
        worker_attributes: `E2E-QUALIFIED-${STAMP}`,
        age_range_min: 25,
        age_range_max: 60,
        providers_needed: '1',
      },
    });
    expect(createRes.status(), 'POST /api/admin/vacancies cria a vaga is_test (201)').toBe(201);
    const createBody = (await createRes.json()) as CreateVacancyBody;
    vacancyId = createBody.data.id;
    expect(createBody.data.is_test, 'vaga persistida como is_test=true').toBe(true);

    // ── 4. SLOT RECORRENTE — sem horário futuro o handler pula com NO_FUTURE_SLOT ──
    // Feature da release (migration 291). `meet_links` é obrigatório no schema mesmo
    // quando só o recorrente muda.
    const slotRes = await adminCtx.put(`/api/admin/vacancies/${vacancyId}/meet-links`, {
      data: {
        meet_links: [null, null, null],
        recurring: { weekday: 1, time: '08:30', link: 'https://meet.google.com/rte-stee-000' },
      },
    });
    expect(slotRes.status(), 'PUT /meet-links grava o slot recorrente (200)').toBe(200);
    const slotBody = (await slotRes.json()) as { data: { meet_recurring: { weekday: number } | null } };
    expect(slotBody.data.meet_recurring?.weekday, 'o slot recorrente persistiu').toBe(1);

    // ── 5. o worker se postula (cria a WJA) ────────────────────────────────────
    const applyRes = await workerCtx.post('/api/worker-applications/track-channel', {
      data: { jobPostingId: vacancyId, channel: 'site' },
    });
    expect(applyRes.status(), 'POST track-channel cria a WJA (200)').toBe(200);

    // ── 6. o ARRASTO: mover a tarjeta para QUALIFIED ───────────────────────────
    const funnelRes = await adminCtx.get(`/api/admin/vacancies/${vacancyId}/funnel`);
    expect(funnelRes.status(), 'GET /vacancies/:id/funnel responde 200').toBe(200);
    const items = Object.values(((await funnelRes.json()) as FunnelBody).data.stages).flat();
    const card = items.find(it => it.workerId === workerId);
    expect(card, 'a postulação criou a tarjeta do nosso worker').toBeTruthy();

    // ⚠️ `card.id` é o id da LINHA do funil; a rota do move quer o `encuadreId`, que é
    // outro campo (`KanbanBoard.tsx:249` usa `enc.encuadreId`). Usar `id` aqui devolve
    // 404 "Encuadre not found". Medido em 31/08, na 1ª execução real deste fluxo — este
    // spec nasceu bloqueado pela pré-condição e nunca tinha rodado contra prod.
    // O encuadre nasce DEPOIS da postulação, então espera-se pela CONDIÇÃO.
    await expect
      .poll(
        async () => {
          const r = await adminCtx!.get(`/api/admin/vacancies/${vacancyId}/funnel`);
          if (r.status() !== 200) return null;
          const todos = Object.values(((await r.json()) as FunnelBody).data.stages).flat();
          return todos.find((it) => it.workerId === workerId)?.encuadreId ?? null;
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 5_000], message: 'o encuadre da postulação nunca apareceu' },
      )
      .not.toBeNull();

    const funnelRes2 = await adminCtx.get(`/api/admin/vacancies/${vacancyId}/funnel`);
    const encuadreId = Object.values(((await funnelRes2.json()) as FunnelBody).data.stages)
      .flat()
      .find((it) => it.workerId === workerId)!.encuadreId!;

    const moveRes = await adminCtx.put(`/api/admin/encuadres/${encuadreId}/move`, {
      data: { targetStage: 'QUALIFIED' },
    });
    expect(moveRes.status(), 'PUT /encuadres/:id/move para QUALIFIED responde 200').toBe(200);

    // ── 7. a cadeia assíncrona: evento → handler → outbox ──────────────────────
    // Pub/Sub + processor são assíncronos; espera-se pela CONDIÇÃO, nunca por sleep cru.
    let delivery: DeliveryBody['data'] | undefined;
    await expect
      .poll(
        async () => {
          const r = await adminCtx!.get(`/api/admin/vacancies/${vacancyId}/workers/${workerId}/delivery-status`);
          if (r.status() !== 200) return null;
          delivery = ((await r.json()) as DeliveryBody).data;
          return delivery.outbox?.status ?? null;
        },
        {
          timeout: 90_000,
          intervals: [1_000, 2_000, 5_000],
          message: 'o convite deveria ter sido ENFILEIRADO na messaging_outbox após o arrasto',
        },
      )
      .not.toBeNull();

    // ── 8. ASSERÇÃO A — o convite foi realmente ENFILEIRADO, com o template certo ──
    expect(delivery!.wjaStage, 'a WJA está em QUALIFIED').toBe('QUALIFIED');
    expect(delivery!.outbox, 'existe linha na messaging_outbox para o par (worker, vaga)').toBeTruthy();
    expect(delivery!.outbox!.templateSlug, 'o template é o do convite de entrevista').toBe(EXPECTED_TEMPLATE);

    // ── 9. ASSERÇÃO B — e NÃO foi enviado, pela razão de teste ────────────────
    // Este é o ponto do teste: exercitamos o caminho INTEIRO e paramos no último metro.
    await expect
      .poll(
        async () => {
          const r = await adminCtx!.get(`/api/admin/vacancies/${vacancyId}/workers/${workerId}/delivery-status`);
          if (r.status() !== 200) return null;
          delivery = ((await r.json()) as DeliveryBody).data;
          return delivery.outbox?.status ?? null;
        },
        {
          timeout: 90_000,
          intervals: [2_000, 5_000],
          message: 'o OutboxProcessor deveria ter marcado suppressed (guard de is_test), não enviado',
        },
      )
      .toBe('suppressed');

    expect(delivery!.outbox!.twilioSid, 'NENHUMA mensagem saiu — sem SID da Twilio').toBeNull();

    // ── 10. teardown PROVADO (não "rodou sem erro") ───────────────────────────
    const cleanupRes = await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: {} });
    expect(cleanupRes.status(), 'cleanup is_test responde 200').toBe(200);

    const goneRes = await adminCtx.get(`/api/admin/vacancies/${vacancyId}`);
    expect(goneRes.status(), 'após o cleanup a vaga is_test sumiu (404)').toBe(404);
  });
});
