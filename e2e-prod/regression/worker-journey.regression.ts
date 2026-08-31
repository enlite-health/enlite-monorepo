/**
 * worker-journey.regression.ts — Jornada REAL do worker contra PRODUÇÃO (enlite-prd).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FATIA 1 de 3 — "o encanamento" (a PARTE SEGURA da jornada).
 * ─────────────────────────────────────────────────────────────────────────────
 * Prova, ponta-a-ponta e SEM navegador (tudo programático/API nesta fatia), que a
 * espinha dorsal da jornada worker funciona em prod real:
 *
 *   1. SIGNUP Firebase de um alias FRESCO por run (não pré-criado, não é o admin).
 *   2. POST /api/workers/init  → cria a ficha do worker (status INCOMPLETE_REGISTER).
 *   3. ADMIN marca is_test=true (PATCH .../test-flag) — o marcador de teardown/sweeper.
 *   4. ADMIN verifica (GET .../:id): worker existe, isTest=true e status é
 *      INCOMPLETE_REGISTER — provando que PARAMOS ANTES de REGISTERED.
 *
 * Por que parar antes de REGISTERED: só ao virar REGISTERED o backend dispara o
 * espelho AnaCare (sync PII → parceiro externo). Como esta fatia nunca chega a
 * REGISTERED, ela tem ZERO efeito colateral externo — é segura pra rodar contra prod
 * quantas vezes for preciso. As fatias seguintes cobrem o resto, já dependendo do
 * gate is_test que hoje impede o espelho de contas de teste:
 *   • FATIA 2 — completar o cadastro via UI real (general-info + service-area +
 *     availability + docs) até REGISTERED, e ASSERTAR `ana_care_id IS NULL` (o gate
 *     is_test barrou o espelho).
 *   • FATIA 3 — postularse a uma vaga is_test e validar o gate/fluxo de WhatsApp.
 *
 * DOIS PAPÉIS (desenho firmado, decisoes.md 2026-07-13):
 *   • admin  = conta staff FIXA (E2E_ADMIN_*, via newAdminApiContext) — faz os passos
 *              de bastidor (marcar is_test, verificar). NÃO é o worker.
 *   • worker = SIGNUP fresco por run (alias único), senha só-de-teste. NÃO pré-criado.
 *
 * REGRAS DA SUÍTE (e2e-prod/CLAUDE.md): zero page.route/mock; web-first assertions;
 * sem waitForTimeout cru; teardown garantido por marca (is_test) + delete da conta
 * Firebase; segredos (senha/token) nunca logados nem gravados em trace.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newAdminApiContext } from '../src/support/adminApi';
import {
  signUpWorker,
  signInWorker,
  newWorkerApiContext,
  deleteWorkerAuthAccount,
} from '../src/support/workerApi';
import {
  readTinyDocumentPng,
  uniqueArMobile,
  buildCaregiverGeneralInfo,
  buildServiceArea,
  buildAvailability,
  uploadWorkerDocument,
} from '../src/support/workerRegistration';
import {
  registerWorkerViaUi,
  openWorkerProfile,
  fillGeneralInfoViaUi,
  fillServiceAreaViaUi,
  fillAvailabilityViaUi,
  uploadDocumentsViaUi,
  findWorkerIdByEmail,
} from '../src/support/workerRegistrationUi';

/**
 * Senha throwaway só-de-teste. NÃO é segredo de valor (a conta é um alias descartável
 * criado e apagado no mesmo run). Sobrescrevível por E2E_WORKER_PASSWORD se algum
 * ambiente exigir política de senha mais forte. Nunca é logada.
 */
const WORKER_PASSWORD = process.env.E2E_WORKER_PASSWORD ?? 'E2eProdWorker!2026#throwaway';

// Alias único por run — Date.now() é seguro aqui (é teste Playwright, não workflow
// script). Marca inequívoca (`gabriel+e2e-worker-`) pro sweeper idempotente.
const WORKER_EMAIL = `gabriel+e2e-worker-${Date.now()}@gmail.com`;

// Alias PRÓPRIO da Fatia 2 (prefixo `-f2-`): a Fatia 2 faz signup fresco e NÃO
// compartilha estado com a Fatia 1, mesmo que Date.now() coincida no load do módulo.
const WORKER_EMAIL_F2 = `gabriel+e2e-worker-f2-${Date.now()}@gmail.com`;

// ── Shapes mínimos das respostas (ancorados no backend — ver report) ──
interface InitOkBody {
  success: boolean;
  data: { status: string; worker: { id: string } };
}
interface TestFlagBody {
  success: boolean;
  data: { isTest: boolean };
}
interface WorkerDetailBody {
  success: boolean;
  data: { id: string; status: string; isTest: boolean };
}

test.describe('Jornada worker — FATIA 1 (encanamento: signup → init → is_test)', () => {
  let adminCtx: APIRequestContext | undefined;
  let workerCtx: APIRequestContext | undefined;
  let workerIdToken: string | undefined;
  let workerId: string | undefined;

  test.afterAll(async () => {
    // Teardown best-effort — afterAll NUNCA deve falhar por causa de limpeza.
    // (1) Remove a CREDENCIAL Firebase do worker (accounts:delete). A linha no banco
    //     fica marcada is_test=true, que é o marcador do sweeper e já a exclui do
    //     matchmaking (hard filter is_test).
    if (workerIdToken) await deleteWorkerAuthAccount(workerIdToken);

    // (2) Forward-compat: quando o endpoint de purga de fixtures for deployado, esta
    //     chamada apaga a linha is_test do banco também. HOJE (branch
    //     feat/e2e-prod-worker-journey) esse endpoint NÃO existe — verificado por grep
    //     em 2026-07-13. A chamada é tolerante (Playwright não lança em 404; só o status
    //     é observável), então funcionará sem alteração de código quando ele chegar.
    if (adminCtx) {
      try {
        await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: { onlyTestWorkers: true } });
      } catch {
        // best-effort — endpoint ainda não existe nesta branch.
      }
    }

    await workerCtx?.dispose();
    await adminCtx?.dispose();
  });

  test('cria worker fresco, marca is_test e confirma que PAROU em INCOMPLETE_REGISTER (antes do espelho AnaCare)', async () => {
    // Guard: sem credenciais de admin/Firebase esta fatia não roda (é write real em prod).
    test.skip(
      !process.env.E2E_ADMIN_EMAIL || !process.env.FIREBASE_API_KEY,
      'requer E2E_ADMIN_EMAIL + FIREBASE_API_KEY (writes autenticados em prod)',
    );

    // ── PASSO 1: signup Firebase do worker fresco ──
    const { idToken, localId } = await signUpWorker(WORKER_EMAIL, WORKER_PASSWORD);
    workerIdToken = idToken;
    workerCtx = await newWorkerApiContext(idToken);

    // ── PASSO 2: POST /api/workers/init (contrato: authUid + email obrigatórios) ──
    // authUid = localId (UID Firebase). Enviamos o Bearer do worker (a rota é pública,
    // mas espelhamos o cliente real). Omitimos `phone` de propósito: sem telefone não
    // há caminho de claim/OTP (imported-worker match) — mantém a fatia determinística.
    const initRes = await workerCtx.post('/api/workers/init', {
      data: { authUid: localId, email: WORKER_EMAIL, lgpdOptIn: true, country: 'AR' },
    });
    expect(initRes.status(), 'POST /api/workers/init deve criar o worker (201)').toBe(201);
    const initBody = (await initRes.json()) as InitOkBody;
    expect(initBody.success).toBe(true);
    expect(initBody.data.status, 'init retorna status "ok" (não claim_pending)').toBe('ok');
    workerId = initBody.data.worker.id;
    expect(workerId, 'init retorna o id do worker criado').toBeTruthy();

    // ── PASSO 3: ADMIN marca is_test=true (PATCH .../test-flag, body { isTest: boolean }) ──
    adminCtx = await newAdminApiContext();
    const flagRes = await adminCtx.patch(`/api/admin/workers/${workerId}/test-flag`, {
      data: { isTest: true },
    });
    expect(flagRes.status(), 'PATCH test-flag deve responder 200').toBe(200);
    const flagBody = (await flagRes.json()) as TestFlagBody;
    expect(flagBody.success).toBe(true);
    expect(flagBody.data.isTest, 'test-flag ecoa isTest=true').toBe(true);

    // ── PASSO 4: ADMIN verifica (GET .../:id) — existe, isTest=true, NÃO REGISTERED ──
    const getRes = await adminCtx.get(`/api/admin/workers/${workerId}`);
    expect(getRes.status(), 'GET /api/admin/workers/:id deve responder 200').toBe(200);
    const getBody = (await getRes.json()) as WorkerDetailBody;
    expect(getBody.success).toBe(true);
    expect(getBody.data.id, 'GET retorna o mesmo worker').toBe(workerId);
    expect(getBody.data.isTest, 'worker persistido como is_test=true').toBe(true);
    // A prova central da FATIA 1: paramos ANTES de REGISTERED, logo o espelho AnaCare
    // nunca foi disparado. O worker recém-criado nasce INCOMPLETE_REGISTER.
    expect(getBody.data.status, 'worker parou em INCOMPLETE_REGISTER').toBe('INCOMPLETE_REGISTER');
    expect(getBody.data.status, 'worker NÃO chegou a REGISTERED (sem espelho AnaCare)').not.toBe('REGISTERED');

    // ── PASSO 5: TEARDOWN VERIFICADO — cleanup apaga o worker is_test e PROVAMOS que sumiu ──
    // "teardown obrigatório" é regra da suíte: aqui a limpeza é ASSERTADA (não só best-effort).
    // O afterAll continua como rede de segurança (Firebase delete + cleanup tolerante).
    // NOTA: o cleanup apaga TODO is_test (faxina global) — ok em execução sequencial; se um dia
    // a suíte rodar journeys em paralelo, trocar por purga escopada ao workerId.
    const cleanupRes = await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: {} });
    expect(cleanupRes.status(), 'cleanup is_test deve responder 200').toBe(200);
    const goneRes = await adminCtx.get(`/api/admin/workers/${workerId}`);
    expect(goneRes.status(), 'após cleanup, o worker is_test foi APAGADO do banco (404)').toBe(404);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * FATIA 2 de 3 — "completar o cadastro até REGISTERED como is_test".
 * ─────────────────────────────────────────────────────────────────────────────
 * Leva um worker de teste FRESCO até o status REGISTERED em prod real e prova que
 * chegou lá JÁ MARCADO is_test — que é a PRECONDIÇÃO do gate AnaCare
 * (MirrorWorkerService: `if (row.is_test === true) return 'skipped'`). Como o gate
 * está deployado em prod, um worker is_test que vira REGISTERED NÃO é espelhado, e
 * portanto `workers.ana_care_id` permanece NULL.
 *
 * SEQUÊNCIA SEGURA (ordem importa — is_test ANTES de qualquer save que leve a REGISTERED):
 *   signup → init → ADMIN marca is_test → general-info → service-area → availability →
 *   2 docs (identity_document + criminal_record) → o último save vira REGISTERED →
 *   assert status=REGISTERED + isTest=true → (assert ana_care — ver BLOCKER abaixo) →
 *   cleanup verificado.
 *
 * Escolha da profissão: CAREGIVER (classe CUIDADOR, não-AT). O gate de documentos só
 * exige 2 arquivos para não-AT (identity_document + criminal_record); AT exigiria +CV
 * +certificado. Minimiza fixtures. Ancorado em migration 212 (trigger) +
 * workerDocumentPolicy.ts + constraint valid_profession_values (migration 064).
 *
 * ⚠️ BLOCKER conhecido — `ana_care_id` NÃO é observável via API admin hoje.
 *   `GET /api/admin/workers/:id` (getWorkerById → buildWorkerDetailResponse) NÃO expõe
 *   `ana_care_id` nem `ana_care_synced_at` no JSON (verificado em
 *   AdminWorkersDetailBuilder.ts — o objeto de resposta não inclui esses campos). A
 *   coluna existe (migrations 014/231) e é lida internamente (WorkerRepository.
 *   findByIdWithPii, que NÃO tem callers HTTP), mas nenhuma rota admin a retorna.
 *   Como a suíte é no-mock e roda só via HTTP em prod (sem acesso ao banco), a asserção
 *   direta `ana_care_id IS NULL` fica CAPABILITY-GATED: se/quando o backend expuser o
 *   campo, o assert abaixo passa a valer automaticamente; até lá, a prova é indireta
 *   (REGISTERED + is_test=true + gate deployado). Fix necessário: incluir
 *   `anaCareId`/`anaCareSyncedAt` em buildWorkerDetailResponse (+ deploy).
 */
interface WorkerDetailF2 {
  success: boolean;
  data: {
    id: string;
    status: string;
    isTest: boolean;
    /** Lido de volta para provar que o valor escolhido NA TELA chegou ao banco. */
    yearsExperience?: string | null;
    // Ainda NÃO retornados por buildWorkerDetailResponse — presença é o gatilho do
    // assert direto de ana_care. Tipados como opcionais para o capability-gate.
    anaCareId?: string | null;
    anaCareSyncedAt?: string | null;
  };
}

test.describe('Jornada worker — FATIA 2 (cadastro → REGISTERED como is_test, sem espelho AnaCare)', () => {
  let adminCtx: APIRequestContext | undefined;
  let workerCtx: APIRequestContext | undefined;
  let workerIdToken: string | undefined;
  let workerId: string | undefined;

  test.afterAll(async () => {
    // Teardown best-effort — afterAll NUNCA falha por causa de limpeza.
    if (workerIdToken) await deleteWorkerAuthAccount(workerIdToken);
    try {
      // A conta nasce na TELA, então ela pode existir mesmo se o teste morreu antes
      // do passo que marca is_test — e o cleanup só apaga o que está marcado. Sem
      // esta rede, uma falha no meio deixa worker REAL em prod (aconteceu 2×).
      adminCtx ??= await newAdminApiContext();
      const orphanId = workerId ?? (await findWorkerIdByEmail(adminCtx, WORKER_EMAIL_F2));
      await adminCtx.patch(`/api/admin/workers/${orphanId}/test-flag`, { data: { isTest: true } });
    } catch {
      // Sem worker para marcar (o cadastro nem chegou a criar) — nada a limpar.
    }
    if (adminCtx) {
      try {
        await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: { onlyTestWorkers: true } });
      } catch {
        // best-effort — endpoint pode não existir nesta branch.
      }
    }
    await workerCtx?.dispose();
    await adminCtx?.dispose();
  });

  test('completa o cadastro NA TELA até REGISTERED e confirma que o espelho AnaCare foi barrado', async ({ page }) => {
    // Guard: sem credenciais de admin/Firebase esta fatia não roda (writes reais em prod).
    test.skip(
      !process.env.E2E_ADMIN_EMAIL || !process.env.FIREBASE_API_KEY,
      'requer E2E_ADMIN_EMAIL + FIREBASE_API_KEY (writes autenticados em prod)',
    );

    // ── PASSO 1: a conta nasce NA TELA de cadastro (/register) ──
    // A RegisterPage cria a conta Firebase e chama `initWorker` sozinha; parar em
    // /login é a prova de que a linha em `workers` existe. Sem WhatsApp de propósito:
    // com telefone o init pode cair no ramo claim_pending (OTP), que é outro fluxo.
    await registerWorkerViaUi(page, WORKER_EMAIL_F2, WORKER_PASSWORD);

    // ── PASSO 2: ADMIN marca is_test IMEDIATAMENTE ──
    // Antes de qualquer save que possa levar a REGISTERED — é o que garante que o
    // gate do MirrorWorkerService já esteja no banco e o espelho AnaCare seja pulado.
    adminCtx = await newAdminApiContext();
    workerId = await findWorkerIdByEmail(adminCtx, WORKER_EMAIL_F2);
    const flagRes = await adminCtx.patch(`/api/admin/workers/${workerId}/test-flag`, {
      data: { isTest: true },
    });
    expect(flagRes.status(), 'PATCH test-flag deve responder 200').toBe(200);
    const flagBody = (await flagRes.json()) as { success: boolean; data: { isTest: boolean } };
    expect(flagBody.data.isTest, 'test-flag ecoa isTest=true').toBe(true);

    // Token do worker só para o TEARDOWN (apagar a conta Firebase no afterAll).
    // Não é usado para gravar nada: quem grava, daqui em diante, é a tela.
    const { idToken } = await signInWorker(WORKER_EMAIL_F2, WORKER_PASSWORD);
    workerIdToken = idToken;

    // ── PASSO 3: o prestador abre o próprio perfil (o cadastro já autenticou) ──
    await openWorkerProfile(page);

    // ── PASSO 4: aba "Información General" — campo a campo, cada um com seu save ──
    // Nenhum blur de resgate. Se um campo não disparar o autosave sozinho, o
    // waitForResponse daquele campo estoura e o teste aponta QUAL campo quebrou.
    const { yearsExperience } = await fillGeneralInfoViaUi(page, {
      phone: uniqueArMobile(),
      cuil: `20-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}-9`,
      profession: 'CAREGIVER',
    });

    // ── PASSO 5: endereço, pelo autocomplete real do Google ──
    await fillServiceAreaViaUi(page);

    // ── PASSO 6: disponibilidade ──
    await fillAvailabilityViaUi(page);

    // ── PASSO 7: documentos pelo input de arquivo (2 para não-AT). O último save
    //            cumpre o gate e o recalculateStatus leva o worker a REGISTERED. ──
    await uploadDocumentsViaUi(page, ['identity_document', 'criminal_record']);

    // ── PASSO 8: ADMIN verifica — worker chegou a REGISTERED, ainda is_test ──
    const getRes = await adminCtx.get(`/api/admin/workers/${workerId}`);
    expect(getRes.status(), 'GET /api/admin/workers/:id deve responder 200').toBe(200);
    const getBody = (await getRes.json()) as WorkerDetailF2;
    expect(getBody.data.id, 'GET retorna o mesmo worker').toBe(workerId);
    // Prova central da FATIA 2: o worker completou o cadastro e virou REGISTERED…
    expect(getBody.data.status, 'worker completou o cadastro e chegou a REGISTERED').toBe('REGISTERED');
    // …E chegou lá marcado is_test — a precondição do gate AnaCare (mirror pulado).
    expect(getBody.data.isTest, 'worker continua is_test=true (gate AnaCare barra o espelho)').toBe(true);

    // Prova de ida-e-volta do campo que quebrou em 31/08: o valor que a TELA
    // escolheu tem de estar no banco. `status < 400` no PUT não prova isso — foi
    // justamente o que o helper antigo assertava enquanto o campo se perdia.
    expect(
      getBody.data.yearsExperience,
      'o "años de experiencia" escolhido na tela chegou ao banco',
    ).toBe(yearsExperience);

    // ── PASSO 9: assert DIRETO de não-espelho AnaCare (PR #134 expôs o campo no admin) ──
    // O gate is_test (MirrorWorkerService) barrou o espelho ANTES de qualquer chamada ao
    // provider, então `workers.ana_care_id` nunca foi setado. Prova em prod, via HTTP:
    // o worker is_test chegou a REGISTERED SEM ser espelhado no AnaCare real.
    // Hard-assert: se o campo sumir do admin ou vier não-NULL (gate regrediu), QUEBRA.
    expect('anaCareId' in getBody.data, 'GET admin worker expõe anaCareId (#134 deployado)').toBe(true);
    expect(getBody.data.anaCareId ?? null, 'gate segurou: ana_care_id NULL (worker is_test NÃO espelhado)').toBeNull();
    expect(getBody.data.anaCareSyncedAt ?? null, 'gate segurou: ana_care_synced_at NULL').toBeNull();

    // ── PASSO 10: TEARDOWN VERIFICADO — cleanup apaga o worker is_test e provamos que sumiu ──
    const cleanupRes = await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: {} });
    expect(cleanupRes.status(), 'cleanup is_test deve responder 200').toBe(200);
    const goneRes = await adminCtx.get(`/api/admin/workers/${workerId}`);
    expect(goneRes.status(), 'após cleanup, o worker is_test foi APAGADO do banco (404)').toBe(404);
  });
});
