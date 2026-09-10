/**
 * blocked-attempt-live-reason.regression.ts — guarda EM PRODUÇÃO o bug que motivou
 * toda a frente `worker_blocked_applications` (D300, PR #324 + #326).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O BUG ORIGINAL, resumido: o card de "tentativa bloqueada" gravava o motivo no
 * INSTANTE da tentativa e nunca mais recalculava. Uma prestadora completava o
 * cadastro, era reativada, mudava de status — e o card seguia dizendo o motivo de
 * meses atrás. Medido em produção em 08/09/2026: 135 de 1.271 cards mentiam, 90
 * deles escondendo gente REGISTERED (elegível hoje) atrás de um rótulo velho.
 *
 * O CONSERTO (PR #324): o motivo passou a ser RECALCULADO A CADA LEITURA contra o
 * estado atual do worker (`liveBlockedReasonSql`), nunca lido do snapshot gravado
 * no momento da tentativa.
 *
 * O QUE ESTE TESTE PROVA, e por que só ISSO prova de verdade:
 *   1. cria um worker de teste, tenta postular INCOMPLETO → nasce bloqueado
 *      por 'registration_incomplete' (grava o INSTANTÂNEO, como sempre gravou);
 *   2. completa o cadastro do MESMO worker até REGISTERED — SEM postular de novo,
 *      ou seja, SEM tocar a linha de `worker_blocked_applications` outra vez;
 *   3. lê o motivo de novo pela MESMA API que a tela usa.
 *
 * Se o motivo em (3) ainda for 'registration_incomplete', o bug voltou: alguém
 * reintroduziu leitura do snapshot congelado (ex.: reverteu `liveBlockedReasonSql`
 * para `wba.blocked_reason`, ou um COALESCE preferiu a coluna errada na CONTRACT
 * do rename — ver migrations/pending/CONTRACT_drop_blocked_attempt_old_columns.sql).
 * NENHUM teste unitário ou de integração local pega essa classe de regressão: eles
 * rodam contra um banco que EU montei, e "o motivo é recalculado" é uma afirmação
 * sobre o CÓDIGO QUE ESTÁ SERVINDO EM PRODUÇÃO agora — só synthetic monitoring vê isso.
 *
 * ── DECISÃO DE DESENHO: verificação via API admin, não via UI ───────────────────
 *   `GET /api/admin/recruitment/blocked-attempts?workerId=…` (RecruitmentBlockedController
 *   → BlockedApplicationQueryRepository.list) é a MESMA consulta que alimenta a tela
 *   `/admin/recruitment/blocked-attempts` (coberta, smoke, por admin/admin-blocked-attempts.admin.ts).
 *   A tela não expõe filtro por workerId na URL (é estado de UI, dropdown i18n ES/EN),
 *   então dirigir isso pela UI seria frágil sem ganhar cobertura real: o dado que a
 *   tela renderiza É o JSON desta API. Testar a API é testar exatamente o que a tela
 *   mostra, sem acoplar a um seletor de dropdown que pode mudar de texto.
 *
 * ── SEGURANÇA / TEARDOWN (mesmo padrão de worker-journey-postularse.regression.ts) ──
 *   Worker + vaga nascem is_test=true. `POST /api/admin/test-fixtures/cleanup` apaga
 *   os DOIS *e também* a linha de `worker_blocked_applications` (CleanupTestFixturesUseCase,
 *   chave 'worker_blocked_applications': DELETE WHERE worker_id IN (workers is_test) OR
 *   job_posting_id IN (job_postings is_test)) — teardown único cobre as 3 tabelas.
 *   Vaga nasce PENDING_ACTIVATION/draft (feed-safe) com profissão que o worker (CAREGIVER)
 *   não tem, mesma mitigação defensiva contra auto-invite documentada na Fatia 3.
 *
 * REGRAS DA SUÍTE (e2e-prod/CLAUDE.md): zero page.route/mock; teardown por marca is_test
 * + sweeper; setup via API; segredos nunca logados.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { newAdminApiContext } from '../src/support/adminApi';
import { signUpWorker, newWorkerApiContext, deleteWorkerAuthAccount } from '../src/support/workerApi';
import { uniqueArMobile, completeCaregiverRegistration } from '../src/support/workerRegistration';

const WORKER_PASSWORD = process.env.E2E_WORKER_PASSWORD ?? 'E2eProdWorker!2026#throwaway';

// Marca `-liveblock-` própria, independente das Fatias 1-3 — sweeper idempotente casa
// por is_test, não por nome de arquivo.
const WORKER_EMAIL = `gabriel+e2e-worker-liveblock-${Date.now()}@gmail.com`;

interface WorkerInitBody {
  success: boolean;
  // ⚠️ `data.status` é o status da OPERAÇÃO ('ok' | 'claim_pending'), NÃO o status de
  // cadastro do worker (WorkerControllerV2.initWorker:115). Errar isso custou uma
  // execução em produção: eu assertava 'INCOMPLETE_REGISTER' aqui e o teste morria
  // logo depois do init — antes de marcar is_test, deixando worker órfão que o
  // sweeper (que acha por is_test=true) não pegava. A precondição real é lida do
  // admin, abaixo.
  data: { status: string; worker: { id: string } };
}
interface WorkerDetailBody {
  success: boolean;
  data: { id: string; status: string; isTest: boolean };
}
interface PatientsListBody {
  success: boolean;
  data: Array<{ id: string; caseNumber: number | null }>;
}
interface CreateVacancyBody {
  success: boolean;
  data: { id: string; is_test: boolean };
}
interface TrackChannelBlockedBody {
  success: false;
  error: string;
  code: string;
  reason: string;
  workerStatus: string | null;
  missingFields: string[];
}
interface BlockedAttemptItem {
  id: string;
  workerId: string;
  jobPostingId: string;
  blockedReason: string;
  missingFields: string[];
}
interface BlockedAttemptsListBody {
  success: boolean;
  data: BlockedAttemptItem[];
}

test.describe('Tentativa bloqueada — o motivo é AO VIVO, nunca o instantâneo (D300)', () => {
  let adminCtx: APIRequestContext | undefined;
  let workerCtx: APIRequestContext | undefined;
  let workerIdToken: string | undefined;
  let workerId: string | undefined;
  let vacancyId: string | undefined;

  test.afterAll(async () => {
    // Teardown best-effort — afterAll nunca falha por causa de limpeza.
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

  test('worker completa o cadastro depois de ser bloqueado → a MESMA linha para de aparecer como bloqueada', async () => {
    // Guard: sem credenciais de admin/Firebase esta regressão não roda (writes reais em prod).
    test.skip(
      !process.env.E2E_ADMIN_EMAIL || !process.env.FIREBASE_API_KEY,
      'requer E2E_ADMIN_EMAIL + FIREBASE_API_KEY (writes autenticados em prod)',
    );

    // ── PASSO 1: signup + init — worker nasce INCOMPLETE_REGISTER, de propósito ──
    // (é o estado que faz a postulação ser barrada: `assertWorkerCanApply` só aceita
    // status === 'REGISTERED'.)
    const { idToken, localId } = await signUpWorker(WORKER_EMAIL, WORKER_PASSWORD);
    workerIdToken = idToken;
    workerCtx = await newWorkerApiContext(idToken);

    const initRes = await workerCtx.post('/api/workers/init', {
      data: { authUid: localId, email: WORKER_EMAIL, lgpdOptIn: true, country: 'AR' },
    });
    expect(initRes.status(), 'POST /api/workers/init deve criar o worker (201)').toBe(201);
    const initBody = (await initRes.json()) as WorkerInitBody;
    workerId = initBody.data.worker.id;
    expect(workerId, 'init retorna o id do worker criado').toBeTruthy();

    // ── PASSO 2: ADMIN marca is_test=true — PRIMEIRA COISA depois do init ──
    // 🔒 NENHUMA asserção entre criar o worker e marcá-lo. O worker já existe em prod
    // a partir do init; enquanto `is_test` for false ele está FORA da rede do
    // `test-fixtures/cleanup` e do sweeper (os dois acham por is_test=true), então
    // qualquer falha nessa janela vira resíduo permanente — gente falsa no funil que
    // alguém teria de caçar à mão. Medido: uma asserção minha aqui deixou 2 órfãos em
    // produção em 10/09. Asserção sobre o estado do worker vem DEPOIS da marca.
    adminCtx = await newAdminApiContext();
    const flagRes = await adminCtx.patch(`/api/admin/workers/${workerId}/test-flag`, {
      data: { isTest: true },
    });
    expect(flagRes.status(), 'PATCH test-flag deve responder 200').toBe(200);

    // Agora sim a precondição, lida da fonte certa (o mesmo endpoint que o passo 6 usa).
    const preRes = await adminCtx.get(`/api/admin/workers/${workerId}`);
    expect(preRes.status(), 'GET /api/admin/workers/:id deve responder 200').toBe(200);
    const preBody = (await preRes.json()) as WorkerDetailBody;
    expect(preBody.data.status, 'precondição do bloqueio: worker ainda NÃO é REGISTERED').not.toBe(
      'REGISTERED',
    );
    expect(preBody.data.isTest, 'worker está marcado is_test — dentro da rede do cleanup').toBe(true);

    // ── PASSO 3: ADMIN obtém um paciente real e cria a vaga is_test (draft, feed-safe) ──
    const patientsRes = await adminCtx.get('/api/admin/patients');
    expect(patientsRes.status(), 'GET /api/admin/patients deve responder 200').toBe(200);
    const patientsBody = (await patientsRes.json()) as PatientsListBody;
    const [patient] = patientsBody.data;
    if (!patient) {
      test.skip(true, 'prod não tem paciente para referenciar a vaga is_test');
      return;
    }

    const createRes = await adminCtx.post('/api/admin/vacancies', {
      data: {
        case_number: patient.caseNumber ?? 0,
        patient_id: patient.id,
        is_test: true,
        // Mitigação defensiva contra auto-invite (mesmo motivo da Fatia 3): o worker é
        // CAREGIVER, a vaga pede PSYCHOLOGIST — 0 candidatos mesmo se o auto-invite
        // for religado antes do cleanup.
        required_professions: ['PSYCHOLOGIST'],
        worker_attributes: `E2E-LIVEBLOCK-${Date.now()}`,
        age_range_min: 25,
        age_range_max: 60,
        providers_needed: '1',
      },
    });
    expect(createRes.status(), 'POST /api/admin/vacancies cria a vaga is_test (201)').toBe(201);
    const createBody = (await createRes.json()) as CreateVacancyBody;
    vacancyId = createBody.data.id;
    expect(vacancyId, 'create retorna o id da vaga').toBeTruthy();
    expect(createBody.data.is_test, 'vaga persistida como is_test=true').toBe(true);

    // ── PASSO 4: worker TENTA postular, ainda INCOMPLETO → 403, grava a tentativa ──
    // Este é o write path real (WorkerApplicationsController.trackChannel →
    // ApplyToVacancyUseCase → assertWorkerCanApply lança → RecordBlockedAttemptUseCase
    // grava blocked_reason_at_attempt='registration_incomplete'). Mesma rota que o botão
    // "Postularme" do app dispara.
    const blockedApplyRes = await workerCtx.post('/api/worker-applications/track-channel', {
      data: { jobPostingId: vacancyId, channel: 'site' },
    });
    expect(blockedApplyRes.status(), 'track-channel barra worker incompleto (403)').toBe(403);
    const blockedBody = (await blockedApplyRes.json()) as TrackChannelBlockedBody;
    expect(blockedBody.code, 'código de recusa é WORKER_NOT_ELIGIBLE').toBe('WORKER_NOT_ELIGIBLE');
    expect(blockedBody.reason, 'motivo da recusa é cadastro incompleto').toBe('registration_incomplete');
    expect(blockedBody.missingFields.length, 'a recusa lista pelo menos um campo faltando').toBeGreaterThan(0);

    // ── PASSO 5: MOMENTO 1 — a API admin (a mesma que alimenta a tela) confirma o bloqueio ──
    const listBlocked = async (): Promise<BlockedAttemptItem | undefined> => {
      const res = await adminCtx!.get(`/api/admin/recruitment/blocked-attempts?workerId=${workerId}`);
      expect(res.status(), 'GET blocked-attempts deve responder 200').toBe(200);
      const body = (await res.json()) as BlockedAttemptsListBody;
      return body.data.find(item => item.jobPostingId === vacancyId);
    };

    const antes = await listBlocked();
    expect(antes, 'a tentativa bloqueada aparece na listagem logo após o 403').toBeTruthy();
    expect(antes!.blockedReason, 'motivo reportado é o de agora: cadastro incompleto').toBe(
      'registration_incomplete',
    );
    expect(antes!.missingFields.length, 'campos faltando aparecem na listagem').toBeGreaterThan(0);

    // ── PASSO 6: worker completa o cadastro até REGISTERED — SEM postular de novo ──
    // Isto é o coração do teste: a transição de status acontece por FORA da tabela
    // worker_blocked_applications. A linha gravada no passo 4 não é tocada.
    await completeCaregiverRegistration(workerCtx, uniqueArMobile());

    const workerGet = await adminCtx.get(`/api/admin/workers/${workerId}`);
    expect(workerGet.status(), 'GET /api/admin/workers/:id deve responder 200').toBe(200);
    const workerBody = (await workerGet.json()) as WorkerDetailBody;
    expect(workerBody.data.status, 'worker completou o cadastro — chegou a REGISTERED').toBe('REGISTERED');

    // ── PASSO 7: MOMENTO 2 — O ASSERT QUE É A REGRESSÃO DE VERDADE ──
    // Se o backend voltasse a ler o snapshot gravado no passo 4 em vez de recalcular
    // contra o worker de AGORA, `depois.blockedReason` continuaria 'registration_incomplete'
    // — exatamente o bug que fez 90 pessoas REGISTERED sumirem atrás de um rótulo velho.
    const depois = await listBlocked();
    expect(depois, 'a mesma linha (mesmo workerId+jobPostingId) ainda existe — não foi apagada').toBeTruthy();
    expect(
      depois!.blockedReason,
      'REGRESSÃO SE FALHAR: motivo recalculado contra o worker REGISTERED de agora — ' +
        'não pode mais ser "registration_incomplete" (isso seria o bug do card congelado de volta)',
    ).not.toBe('registration_incomplete');
    expect(depois!.blockedReason, 'worker REGISTERED e sem outro bloqueio é reportado como elegível').toBe(
      'eligible',
    );

    // ── PASSO 8: o mesmo bug, visto pelo FILTRO do painel (D300 — 400 no balde certo) ──
    // Antes do #324, filtrar por reason=registration_incomplete continuaria devolvendo
    // esta pessoa (o filtro também lia o snapshot). Agora ela sai do balde junto com o
    // motivo recalculado.
    const filteredRes = await adminCtx.get(
      `/api/admin/recruitment/blocked-attempts?workerId=${workerId}&reason=registration_incomplete`,
    );
    expect(filteredRes.status(), 'filtro por reason=registration_incomplete responde 200 (não 400)').toBe(200);
    const filteredBody = (await filteredRes.json()) as BlockedAttemptsListBody;
    expect(
      filteredBody.data.some(item => item.jobPostingId === vacancyId),
      'worker já REGISTERED não aparece mais no balde "cadastro incompleto"',
    ).toBe(false);

    // ── PASSO 9: TEARDOWN VERIFICADO — cleanup apaga worker, vaga E a tentativa bloqueada ──
    const cleanupRes = await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: {} });
    expect(cleanupRes.status(), 'cleanup is_test deve responder 200').toBe(200);
    const workerGone = await adminCtx.get(`/api/admin/workers/${workerId}`);
    expect(workerGone.status(), 'após cleanup, o worker is_test sumiu (404)').toBe(404);
    const vacancyGone = await adminCtx.get(`/api/admin/vacancies/${vacancyId}`);
    expect(vacancyGone.status(), 'após cleanup, a vaga is_test sumiu (404)').toBe(404);
  });
});
