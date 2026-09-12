/**
 * worker-journey-postularse.regression.ts — FATIA 3 da jornada worker contra PRODUÇÃO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FATIA 3 de 3 — "postularse: worker is_test REGISTERED → vaga is_test → WJA INVITED".
 * ─────────────────────────────────────────────────────────────────────────────
 * Arquivo PRÓPRIO (não estende worker-journey.regression.ts) por causa do limite de
 * 400 linhas: as Fatias 1 e 2 vivem em worker-journey.regression.ts (verdes em prod) e
 * NÃO são tocadas por esta fatia. O runner casa ambos por `*.regression.ts`.
 *
 * Prova, ponta-a-ponta em prod real, o fluxo de POSTULAÇÃO com segregação is_test:
 * um worker de teste REGISTERED se candidata a uma VAGA de teste e o backend cria a
 * WJA (worker_job_applications) com application_funnel_stage='INVITED'.
 *
 * SEQUÊNCIA:
 *   signup → init → ADMIN is_test → completa cadastro (→ REGISTERED) →
 *   ADMIN cria VAGA is_test (paciente REAL existente, sem criar/limpar paciente) →
 *   worker POSTULA (POST /api/worker-applications/track-channel) →
 *   assert WJA INVITED (via funnel do admin) →
 *   fidelidade request↔DOM (página pública renderiza dado da vaga que criamos) →
 *   cleanup verificado (worker E vaga sumiram).
 *
 * ── DECISÃO DE DESENHO: postularse via API, NÃO via UI ──────────────────────────
 *   O caminho que grava a WJA é `POST /api/worker-applications/track-channel`
 *   (WorkerApplicationsController.trackChannel:79 → CreateManualWjaWithEncuadreUseCase:51,
 *   INSERT com source='manual', stage='INVITED'). O gate `assertWorkerCanApply`
 *   (WorkerApplicationEligibility.ts:26) valida SÓ o worker (status REGISTERED, não
 *   DISABLED, não merged) — NÃO exige que a vaga seja pública/ativa. Logo dá pra
 *   postular a uma vaga is_test em draft (PENDING_ACTIVATION). Chamamos via o Bearer
 *   do worker (já temos do signup): é determinístico e não exige logar o worker no
 *   browser. Na UI, o trackChannel só dispara no `useEffect` quando o worker está
 *   autenticado E há `utm_source` no sessionStorage (PublicVacancyPage.tsx:292); como
 *   NÃO autenticamos o browser, a página pública nunca dispara um 2º write — a WJA é
 *   criada exclusivamente pela nossa chamada de API. Zero double-write, zero mock.
 *
 * ── FIDELIDADE request↔DOM (ponto seguro) ───────────────────────────────────────
 *   `GET /api/vacancies/:id` (PublicVacancyController.ts:57-78) FILTRA desde 25-30/08/2026
 *   (ver o docblock do próprio controller, "O que mudou em 25/08/2026"): exige
 *   `deleted_at IS NULL AND is_draft = false AND status = ANY(STATUS_PUBLICAVEL)`. NÃO
 *   filtra `is_test` — só status/is_draft.
 *   ✅ RESOLVIDO (12/09/2026, decisão do Gabriel — CONDICIONADO AO DEPLOY): `POST
 *   /vacancies` agora aceita `is_draft` no payload de criação, mas SÓ quando `is_test=true`
 *   (buildInsertParams, vacancyCrudHelpers.ts — vaga real continua sempre nascendo
 *   is_draft=true, o DEFAULT do banco / migration 168; a exceção não vaza pra produção).
 *   Por isso o PASSO 5 abaixo passa `is_draft: false` + um status de STATUS_PUBLICAVEL —
 *   a vaga de fixture nasce publicável SEM passar por `publish-talentum` (Talentum real +
 *   Groq, canais de terceiro sem teardown, proibidos nesta suíte). O PASSO 8 (fidelidade
 *   request↔DOM) só fica verde depois que este backend for deployado — antes disso, a vaga
 *   ainda nasce is_draft=true (default) e a asserção bateria 404. Ver "O que fica condicionado
 *   ao deploy" no relatório da mudança.
 *   SEGURANÇA: mesmo publicável, a vaga NÃO vaza no feed público `/api/public/v1/jobs` — o
 *   feed exige status IN (ACTIVE,SEARCHING,…) AND is_draft=false AND social_short_links ? 'site'
 *   AND is_test = false (PublicJobsQueryBuilder.ts:24-37). A nossa vaga agora bate status+
 *   is_draft=false, mas continua excluída por DOIS guards independentes: `is_test = false`
 *   no feed (a nossa é is_test=true) e a ausência de `social_short_links.site` — desde a
 *   decisão do Gabriel de 12/09/2026, `VacancyCrudController.tryEnsureShortLink` recusa criar
 *   short link para vaga is_test (`if (isTest) return;`, ANTES do check de status/serviço),
 *   então mesmo publicável ela nunca ganha o `social_short_links.site` que o feed exige.
 *   Só é alcançável por quem tem o UUID direto, e existe por segundos até o cleanup.
 *
 * ── SEGURANÇA DO MATCHMAKING (auto-invite: JÁ LIGADO hoje; a trava real é is_test) ──
 *   Verificado em origin/main 12/09/2026 — corrige a nota anterior deste arquivo, que dizia
 *   "hoje NÃO dispara": criar vaga insere `vacancy.created` cru, sem `pubsub.publish`
 *   (VacancyCrudController.createVacancy, ainda verdade), MAS o evento NÃO está mais fora
 *   do sweep de durabilidade — `SWEEP_SAFE_EVENTS` (InternalController.ts:50) inclui
 *   `'vacancy.created'` explicitamente, com o comentário do próprio arquivo dizendo
 *   "go-live do auto-invite: idempotência provada em 3 camadas". O Cloud Scheduler
 *   `events-sweep-safe` (terraform/environments/prd/events.tf) chama
 *   `POST /api/internal/events/sweep-safe` a cada 10 minutos; qualquer `vacancy.created`
 *   pendente mais velho que 5 min é processado por `sweepPendingByEvent`, chamando
 *   `VacancyAutoInviteHandler` de verdade. Não depende de nenhuma flag — está ligado.
 *   O que continua nos protegendo NÃO é o evento estar morto (não está): é que
 *   `VacancyAutoInviteHandler` (VacancyAutoInviteHandler.ts:90-101) TEM, sim, o guard de
 *   is_test — `if (row.is_test === true) return` ANTES de rodar matchmaking. A nota antiga
 *   dizia "o handler NÃO pula is_test, só implementa no comentário"; isso também mudou (ou
 *   nunca foi verificado direito) — está implementado e é o único ponto de entrada do
 *   handler, cobrindo matchmaking + WJA + outbox + WhatsApp de uma vez. Para a nossa vaga
 *   (is_test=true) isso já garante 0 matchmaking, 0 WhatsApp, MESMO SE o Cloud Scheduler
 *   processar o evento durante os segundos de vida do teste.
 *   Mantemos a MITIGAÇÃO DEFENSIVA por redundância, não porque seja a única trava: a vaga
 *   exige uma profissão que o worker de teste NÃO tem (worker=CAREGIVER;
 *   vaga=['PSYCHOLOGIST']) → ProfessionSpecification o excluiria no matchmaking mesmo que o
 *   guard de is_test algum dia regredisse. O postularse (manual, track-channel) NÃO checa
 *   profissão, então a WJA é criada normalmente por essa via.
 *   ⚠️ A memória `project_auto_invite_dead_vacancy_created_unpublished` (nome antigo) está
 *   desatualizada por este mesmo motivo — o evento não está mais "dead"; não foi corrigida
 *   aqui por estar fora do worktree do backend.
 *
 * REGRAS DA SUÍTE (e2e-prod/CLAUDE.md): zero page.route/mock; web-first assertions;
 * teardown por marca (is_test) + delete da conta Firebase; segredos nunca logados.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newAdminApiContext } from '../src/support/adminApi';
import { signUpWorker, newWorkerApiContext, deleteWorkerAuthAccount } from '../src/support/workerApi';
import { uniqueArMobile, completeCaregiverRegistration } from '../src/support/workerRegistration';

/**
 * Senha throwaway só-de-teste (idêntica às Fatias 1/2). NÃO é segredo de valor: a conta
 * é um alias descartável criado e apagado no mesmo run. Nunca é logada.
 */
const WORKER_PASSWORD = process.env.E2E_WORKER_PASSWORD ?? 'E2eProdWorker!2026#throwaway';

// Alias único por run com marca `-f3-` para o sweeper idempotente. Worker fresco,
// independente das Fatias 1/2.
const WORKER_EMAIL_F3 = `gabriel+e2e-worker-f3-${Date.now()}@gmail.com`;

// ── Shapes mínimos das respostas (ancorados no backend — ver report) ──
interface WorkerDetailBody {
  success: boolean;
  data: { id: string; status: string; isTest: boolean };
}
interface PatientsListBody {
  success: boolean;
  // caseNumber vem de patients.case_number (INTEGER, migration 164) — número ou null.
  data: Array<{ id: string; caseNumber: number | null }>;
  total: number;
}
interface CreateVacancyBody {
  success: boolean;
  data: { id: string; title: string; is_test: boolean; status: string };
}
interface FunnelItem {
  id: string;
  workerId: string | null;
  internalStage: string | null;
}
interface FunnelBody {
  success: boolean;
  data: { stages: Record<string, FunnelItem[]>; totalEncuadres: number };
}

test.describe('Jornada worker — FATIA 3 (postularse → WJA INVITED, vaga is_test)', () => {
  let adminCtx: APIRequestContext | undefined;
  let workerCtx: APIRequestContext | undefined;
  let workerIdToken: string | undefined;
  let workerId: string | undefined;
  let vacancyId: string | undefined;

  test.afterAll(async () => {
    // Teardown best-effort — afterAll NUNCA falha por causa de limpeza. O cleanup
    // is_test apaga TANTO o worker QUANTO a vaga (CleanupTestFixturesUseCase:
    // DELETE job_postings WHERE is_test + DELETE workers WHERE is_test + filhos).
    if (workerIdToken) await deleteWorkerAuthAccount(workerIdToken);
    if (adminCtx) {
      try {
        await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: {} });
      } catch {
        // best-effort.
      }
    }
    await workerCtx?.dispose();
    await adminCtx?.dispose();
  });

  test('worker is_test REGISTERED se postula a uma vaga is_test e o backend cria a WJA em INVITED', async ({ page }) => {
    // Guard: sem credenciais de admin/Firebase esta fatia não roda (writes reais em prod).
    test.skip(
      !process.env.E2E_ADMIN_EMAIL || !process.env.FIREBASE_API_KEY,
      'requer E2E_ADMIN_EMAIL + FIREBASE_API_KEY (writes autenticados em prod)',
    );

    // ── PASSO 1: signup + init do worker fresco (sem phone → sem claim/OTP) ──
    const { idToken, localId } = await signUpWorker(WORKER_EMAIL_F3, WORKER_PASSWORD);
    workerIdToken = idToken;
    workerCtx = await newWorkerApiContext(idToken);

    const initRes = await workerCtx.post('/api/workers/init', {
      data: { authUid: localId, email: WORKER_EMAIL_F3, lgpdOptIn: true, country: 'AR' },
    });
    expect(initRes.status(), 'POST /api/workers/init deve criar o worker (201)').toBe(201);
    const initBody = (await initRes.json()) as { success: boolean; data: { status: string; worker: { id: string } } };
    workerId = initBody.data.worker.id;
    expect(workerId, 'init retorna o id do worker criado').toBeTruthy();

    // ── PASSO 2: ADMIN marca is_test=true ANTES de qualquer save (mesma trava da Fatia 2) ──
    adminCtx = await newAdminApiContext();
    const flagRes = await adminCtx.patch(`/api/admin/workers/${workerId}/test-flag`, {
      data: { isTest: true },
    });
    expect(flagRes.status(), 'PATCH test-flag deve responder 200').toBe(200);

    // ── PASSO 3: completa o cadastro até REGISTERED (helper compartilhado) ──
    await completeCaregiverRegistration(workerCtx, uniqueArMobile());

    // Confirma que o worker chegou a REGISTERED (precondição do gate de postulação).
    const workerGet = await adminCtx.get(`/api/admin/workers/${workerId}`);
    expect(workerGet.status(), 'GET /api/admin/workers/:id deve responder 200').toBe(200);
    const workerBody = (await workerGet.json()) as WorkerDetailBody;
    expect(workerBody.data.status, 'worker completou o cadastro (REGISTERED) — pode postular').toBe('REGISTERED');
    expect(workerBody.data.isTest, 'worker continua is_test=true').toBe(true);

    // ── PASSO 4: ADMIN obtém um PACIENTE REAL existente (não cria nem limpa paciente) ──
    // A vaga is_test referencia um paciente real; a vaga NÃO casa worker real (realm TEST)
    // e o cleanup apaga a VAGA (não o paciente — patients não tem is_test).
    const patientsRes = await adminCtx.get('/api/admin/patients');
    expect(patientsRes.status(), 'GET /api/admin/patients deve responder 200').toBe(200);
    const patientsBody = (await patientsRes.json()) as PatientsListBody;
    const [patient] = patientsBody.data;
    if (!patient) {
      test.skip(true, 'prod não tem paciente para referenciar a vaga is_test');
      return;
    }

    // ── PASSO 5: ADMIN cria a VAGA is_test JÁ PUBLICÁVEL (is_draft=false, feed-safe) ──
    // `worker_attributes` é uma string única: é o valor que provaremos no DOM (fidelidade
    // request↔DOM, PASSO 8). Antes desta mudança o status era omitido de propósito → default
    // PENDING_ACTIVATION + is_draft=true (fixture nascia draft e o PASSO 8 batia 404 em prod).
    // Agora: `is_draft: false` só é honrado pelo backend porque `is_test: true` também está
    // presente (ver header, "FIDELIDADE request↔DOM") — vaga real nunca teria esse efeito.
    // `status: 'SEARCHING'` é o membro de STATUS_PUBLICAVEL mais fiel ao estado real de uma
    // vaga recém-criada (procurando candidato) — ACTIVE sugere já ocupada/em atendimento,
    // RAPID_RESPONSE e SEARCHING_REPLACEMENT sugerem urgência/substituição que não é o caso.
    const uniqueAttrs = `E2E-PERFIL-${Date.now()}`;
    const createRes = await adminCtx.post('/api/admin/vacancies', {
      data: {
        // case_number é INTEGER no job_postings (mig 014); UNIQUE já removida (mig 114/119),
        // então reusar o do paciente é permitido. Fallback 0 se o paciente não tiver.
        case_number: patient.caseNumber ?? 0,
        patient_id: patient.id,
        is_test: true,
        is_draft: false,
        status: 'SEARCHING',
        // SEGURANÇA: profissão que o worker (CAREGIVER) NÃO tem → o auto-invite (vivo, sem
        // skip de is_test) NÃO casa o nosso worker → 0 WhatsApp. Ver header. Postularse é
        // manual e não checa profissão, então a WJA é criada mesmo assim.
        required_professions: ['PSYCHOLOGIST'],
        worker_attributes: uniqueAttrs,
        age_range_min: 25,
        age_range_max: 60,
        providers_needed: '1',
      },
    });
    expect(createRes.status(), 'POST /api/admin/vacancies cria a vaga is_test (201)').toBe(201);
    const createBody = (await createRes.json()) as CreateVacancyBody;
    vacancyId = createBody.data.id;
    expect(vacancyId, 'create retorna o id da vaga').toBeTruthy();
    expect(createBody.data.is_test, 'vaga persistida como is_test=true (segregada do matchmaking real)').toBe(true);
    const vacancyTitle = createBody.data.title;
    expect(vacancyTitle, 'create retorna o título auto-gerado (CASO …)').toContain('CASO');

    // ── PASSO 6: worker POSTULA (o caminho real que grava a WJA) ──
    const applyRes = await workerCtx.post('/api/worker-applications/track-channel', {
      data: { jobPostingId: vacancyId, channel: 'site' },
    });
    expect(applyRes.status(), 'POST track-channel deve responder 200 (worker REGISTERED elegível)').toBe(200);
    const applyBody = (await applyRes.json()) as { success: boolean };
    expect(applyBody.success, 'postularse retorna success=true').toBe(true);

    // ── PASSO 7: assert WJA INVITED — observável via funnel do admin da vaga ──
    // stage='INVITED' + source='manual' → coluna INICIADO (deriveKanbanColumn), mas o
    // stage BRUTO da WJA é 'INVITED' (internalStage). Provamos AMBOS: o item existe para
    // o nosso workerId E seu internalStage é 'INVITED'.
    const funnelRes = await adminCtx.get(`/api/admin/vacancies/${vacancyId}/funnel`);
    expect(funnelRes.status(), 'GET /api/admin/vacancies/:id/funnel deve responder 200').toBe(200);
    const funnelBody = (await funnelRes.json()) as FunnelBody;
    const allItems = Object.values(funnelBody.data.stages).flat();
    const ourItem = allItems.find(it => it.workerId === workerId);
    expect(ourItem, 'a postulação criou uma WJA para o nosso worker na vaga').toBeTruthy();
    expect(ourItem!.internalStage, 'a WJA foi criada com application_funnel_stage=INVITED').toBe('INVITED');
    // Postulação manual (source=manual) cai na coluna INICIADO do Kanban.
    expect(
      (funnelBody.data.stages.INICIADO ?? []).some(it => it.workerId === workerId),
      'postulação manual aparece na coluna INICIADO do Kanban',
    ).toBe(true);

    // ── PASSO 8: FIDELIDADE request↔DOM — a página pública renderiza dado que criamos ──
    // Render read-only, SEM auth (GET /api/vacancies/:id é público). Provamos que o valor
    // que ENVIAMOS no POST (worker_attributes) e o título auto-gerado chegam ao DOM real.
    // ⚠️ CONDICIONADO AO DEPLOY do backend (is_draft aceito no create quando is_test=true,
    // ver header) — antes do deploy a vaga nasce is_draft=true (default) e este passo bate
    // 404. Não rodamos este arquivo agora por esse motivo exato (ver relatório da mudança).
    await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByText(uniqueAttrs),
      'worker_attributes enviado no request aparece no DOM da página pública',
    ).toBeVisible();
    await expect(
      page.getByText(vacancyTitle).first(),
      'título auto-gerado da vaga (CASO …) aparece no DOM',
    ).toBeVisible();

    // ── PASSO 9: TEARDOWN VERIFICADO — cleanup apaga worker E vaga is_test; provamos ──
    const cleanupRes = await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: {} });
    expect(cleanupRes.status(), 'cleanup is_test deve responder 200').toBe(200);
    const workerGone = await adminCtx.get(`/api/admin/workers/${workerId}`);
    expect(workerGone.status(), 'após cleanup, o worker is_test sumiu (404)').toBe(404);
    const vacancyGone = await adminCtx.get(`/api/admin/vacancies/${vacancyId}`);
    expect(vacancyGone.status(), 'após cleanup, a vaga is_test sumiu (404)').toBe(404);
  });
});
