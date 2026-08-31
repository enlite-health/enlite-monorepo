/**
 * kanban-staff.regression.ts — o KANBAN, que é onde a operação passa o dia.
 * (Spec 009, Fase 1.)
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ ⛔ ESTE SPEC NUNCA FOI EXECUTADO. Escrito em 30/08 com o portão FECHADO.  ║
 * ║                                                                          ║
 * ║ O guard `is_test` do `OutboxProcessor` (PR #261) NÃO está deployado. Até  ║
 * ║ estar, rodar isto ENVIA WhatsApp de verdade para um número AR sintético   ║
 * ║ que pode pertencer a uma pessoa real. O `test.skip` da linha `PORTAO`     ║
 * ║ abaixo é a trava, e ela é DELIBERADA: some sozinha quando o guard subir.  ║
 * ║                                                                          ║
 * ║ Consequência honesta: os contratos aqui foram todos LIDOS e MEDIDOS       ║
 * ║ (endpoints, testids, estado real das configs em prod), mas nenhuma linha  ║
 * ║ foi exercitada. A primeira execução é um ciclo de depuração, não uma      ║
 * ║ formalidade. O ponto mais frágil está marcado: `arrastarTarjeta`.         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── POR QUE O PORTÃO EXISTE, medido e não suposto (30/08) ─────────────────────
 * Não é "a Fase 1 é sobre mensageria" por rótulo. É mecanismo:
 *   · `WJAFunnelController.moveEncuadre` chama `emitFunnelStageEvent` em TODO
 *     movimento que muda de etapa → grava `funnel_stage.<etapa>` em `domain_events`;
 *   · `funnel_stage.qualified` cai no `QualifiedInterviewHandler` (built-in), que
 *     ENFILEIRA o convite; as demais caem no `StageMessageHandler`, que enfileira o
 *     template da etapa se ele estiver LIGADO;
 *   · quem impede a mensagem de SAIR para um fixture é o guard `is_test` no
 *     `OutboxProcessor` — o "ponto único de defesa", o mesmo do opt-out.
 *
 * Medido em prod em 30/08 (`funnel_stage_messages`): as 9 etapas estão com
 * `enabled=false` e `template_slug=null`; só QUALIFIED tem `builtin='interview_invite'`.
 * ⚠️ **Isso NÃO é a trava.** `enabled` é uma linha que o painel
 * `/admin/mensajes-por-etapa` liga com um clique. Um spec do monitor DIÁRIO que só é
 * seguro enquanto uma config estiver `false` está inerte, não seguro — e viraria envio
 * real às 3h da manhã do dia seguinte à virada da chave. A trava é o guard.
 *
 * ── O QUE ESTE SPEC PROVA, quando puder rodar ────────────────────────────────
 *  1.1 arrastar a tarjeta entre colunas: a etapa PERSISTE, o evento de domínio NASCE
 *      (visto no log `funnel_stage_message`, com autoria), e a coluna DERIVADA bate
 *      com o `internalStage` — `deriveKanbanColumn` é SSOT e a tela tem de obedecê-lo.
 *  1.2 "Reenviar": o 1º clique enfileira; o 2º na janela é BLOQUEADO com
 *      `RESEND_COOLDOWN` e a tela mostra a hora em que abre (D200.1); e NENHUMA
 *      mensagem sai — `status='suppressed'`, sem SID.
 *  1.3 o nome do prestador abre o perfil em NOVA ABA, no card E na lista — e a aba
 *      que abre renderiza o worker CERTO (não basta `target=_blank` no HTML).
 *  1.4 convite à reunión de presentación com a config DESABILITADA (estado real de
 *      prod, medido): o clique registra `skipped` com motivo e não envia.
 *
 * ── O QUE ESTE SPEC NÃO PROVA ────────────────────────────────────────────────
 *  · Não prova o caminho FELIZ do convite de presentación (config ligada) — ligar a
 *    config em produção é ato do Gabriel, não de um teste.
 *  · Não prova a coluna BLOQUEADO (exige um cadastro incompleto, outro fixture).
 *
 * ── TEARDOWN ─────────────────────────────────────────────────────────────────
 * `POST /api/admin/test-fixtures/cleanup` (worker + vaga + linha de outbox), provado
 * por releitura 404, no molde da `qualified-interview-invite`.
 */
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { newAdminApiContext } from '../src/support/adminApi';
import { signUpWorker, newWorkerApiContext, deleteWorkerAuthAccount } from '../src/support/workerApi';
import { uniqueArMobile, completeCaregiverRegistration } from '../src/support/workerRegistration';
import { waitForLog } from '../src/support/cloudLogging';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const WORKER_EMAIL = `e2e-kanban-${STAMP}@enlite.import`;
const WORKER_PASSWORD = 'E2eKanban!2026';
const ATTRS = `E2E-KANBAN-${STAMP}`;

/**
 * PORTÃO. Enquanto o guard `is_test` do OutboxProcessor não estiver em produção,
 * este spec inteiro é PULADO — com motivo visível no relatório, não em silêncio.
 *
 * A checagem é por ENV de propósito: quem sobe o monitor (Cloud Run Job) a partir do
 * `main` com o guard já mergeado seta `OUTBOX_IS_TEST_GUARD=on`; localmente, quem
 * quiser rodar antes disso precisa dizer o nome inteiro, o que torna o ato deliberado
 * e não acidental. Um `skip` sem motivo seria a doença que esta suíte combate — por
 * isso a mensagem diz exatamente o que falta.
 */
const GUARD_ATIVO = process.env.OUTBOX_IS_TEST_GUARD === 'on';

const kanban: {
  workerId?: string;
  workerIdToken?: string;
  vacancyId?: string;
  /**
   * ⚠️ SÃO DOIS IDs DIFERENTES, e confundi-los custou uma execução:
   *  · `cardId`     = `enc.id` da resposta do funil → é o que vai no `data-testid`
   *                   (`kanban-card-<id>`, `KanbanCard.tsx:161`);
   *  · `encuadreId` = `enc.encuadreId` → é o que vai na URL do move
   *                   (`onMoveTo={enc.encuadreId ? ... }`, `KanbanBoard.tsx:249`).
   * Usar `id` na URL faz o `waitForResponse` esperar para sempre por uma requisição que
   * nunca acontece naquele endereço.
   */
  cardId?: string;
  encuadreId?: string;
} = {};

type FunnelCard = { id: string; encuadreId: string | null; workerId: string | null; internalStage: string | null };
type FunnelBody = { data: { stages: Record<string, FunnelCard[]> } };
type DeliveryBody = {
  data: {
    wjaStage: string | null;
    outbox: { status: string; twilioSid: string | null; templateSlug: string } | null;
  };
};

/**
 * Coluna do Kanban a partir de (etapa, origem) — espelho EXATO de
 * `worker-functions/src/modules/matching/domain/kanbanColumn.ts:deriveKanbanColumn`.
 *
 * Duplicar a regra aqui é deliberado: se a suíte importasse a função do backend, ela
 * concordaria com o backend por construção e não provaria nada. O oráculo tem de ser
 * INDEPENDENTE — se as duas divergirem, é sinal, não ruído.
 */
function colunaEsperada(stage: string | null, source: string | null): string {
  if (stage === 'SELECTED') return 'SELECTED';
  if (stage === 'REJECTED') return 'REJECTED';
  if (stage === 'CONFIRMED') return 'CONFIRMED';
  if (stage !== null && ['COMPLETED', 'QUALIFIED', 'IN_DOUBT'].includes(stage)) return 'COMPLETED';
  if (stage === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (stage === 'PRE_SCREENING') return 'PRE_SCREENING';
  if (stage === 'INVITED' && source === 'manual') return 'INICIADO';
  return 'INVITED';
}

/**
 * Abre a vaga e coloca o funil na visão KANBAN.
 *
 * ⚠️ A troca de visão é obrigatória, e descobri isso na 1ª execução real: o padrão do
 * funil é `list`, não `kanban` (`VacancyFunnelView.getPersistedView` → `return 'list'`),
 * e a escolha é persistida em `localStorage` POR VAGA
 * (`vacancy-funnel-view-<id>`). Num contexto de browser novo — que é o que todo run
 * cria — não há nada persistido, então o Kanban simplesmente não é renderizado e
 * `kanban-card-*` não existe no DOM.
 *
 * O clique no alternador é também o que o staff faz, então não é contorno: é o passo
 * que faltava na jornada. O `aria-label` é "Kanban" em ES e pt-BR, então o seletor por
 * papel funciona nos dois idiomas (o front é i18n e texto puro varia).
 */
async function abrirVaga(browser: Browser): Promise<{ page: Page; fechar: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: ADMIN_AUTH_FILE });
  const page = await ctx.newPage();
  await page.goto(`/admin/vacancies/${kanban.vacancyId}`);

  const alternador = page.getByRole('button', { name: 'Kanban' });
  await expect(alternador, 'a ficha da vaga oferece a visão Kanban').toBeVisible({ timeout: 30_000 });
  await alternador.click();

  await expect(page.getByTestId(`kanban-card-${kanban.cardId}`)).toBeVisible({ timeout: 30_000 });
  return { page, fechar: async () => { await ctx.close(); } };
}

/**
 * Move a tarjeta para SELECIONADOS pelo menu do card, atravessando o modal de PAPEL.
 *
 * ⚠️ TRÊS COISAS QUE SÓ A PRIMEIRA EXECUÇÃO REAL ENSINOU (31/08), todas visíveis no
 * screenshot da falha:
 *
 * 1. NÃO É ARRASTO. O board usa `@dnd-kit` (pointer events com *activation constraint*);
 *    a sequência manual de mouse não dispara o `PUT /encuadres/:id/move` — 20 s de
 *    `waitForResponse` estourando, 2 tentativas. O `MoveToMenu` vive no MESMO card
 *    (`KanbanCard.tsx:336`), é a via ACESSÍVEL e chama o mesmo `onMoveTo`.
 * 2. OS DESTINOS SÃO TRÊS, NÃO NOVE. `MOVE_TARGETS = ['INVITED','CONFIRMED','SELECTED']`
 *    menos o atual — de INICIADO sobram "Confirmados" e "Seleccionados". Meu primeiro
 *    destino (`PRE_SCREENING`) simplesmente não existe no menu.
 * 3. OS DOIS ABREM MODAL, de propósito: SELECTED pede o PAPEL, CONFIRMED pede a DATA.
 *    O comentário do `KanbanBoard` diz por quê: "os dois caminhos têm que pedir a mesma
 *    coisa, senão o menu vira a porta dos fundos que grava card sem data". Ou seja: o
 *    modal É a jornada, não um obstáculo — e é isso que este teste passa a exercitar.
 *
 * O que fica SEM cobertura, dito para não virar falsa sensação: se o `@dnd-kit` quebrar,
 * este teste continua verde. Cobrir o arrasto exige afinar pointer events contra o
 * dnd-kit — está na lista.
 */
async function moverTarjetaParaSelecionados(page: Page): Promise<void> {
  const card = page.getByTestId(`kanban-card-${kanban.cardId}`);
  await card.getByTestId('move-to-button').click();
  await expect(card.getByTestId('move-to-menu'), 'o menu de mover abriu no card').toBeVisible();
  await card.getByTestId('move-to-option-SELECTED').click();

  const modal = page.getByTestId('role-modal');
  await expect(modal, 'mover para SELECIONADOS pergunta o PAPEL antes de gravar').toBeVisible();
  await modal.getByTestId('role-option-titular').click();
  await modal.getByTestId('role-confirm').click();
}

/** O funil pela API — fonte independente do que a tela pintou. */
async function lerFunil(ctx: APIRequestContext): Promise<{ card: FunnelCard; coluna: string }> {
  const res = await ctx.get(`/api/admin/vacancies/${kanban.vacancyId}/funnel`);
  expect(res.status(), 'GET /vacancies/:id/funnel responde 200').toBe(200);
  const stages = ((await res.json()) as FunnelBody).data.stages;
  for (const [coluna, cards] of Object.entries(stages)) {
    const card = cards.find((c) => c.workerId === kanban.workerId);
    if (card) return { card, coluna };
  }
  throw new Error('a tarjeta do worker sintético não está em nenhuma coluna do funil');
}

test.describe.serial('Spec 009 · Fase 1 — Kanban do staff', () => {
  let adminCtx: APIRequestContext | undefined;
  let workerCtx: APIRequestContext | undefined;

  test.beforeAll(async () => {
    test.skip(
      !GUARD_ATIVO,
      'PORTÃO: o guard `is_test` do OutboxProcessor (PR #261) não está deployado em produção. ' +
        'Rodar este spec sem ele envia WhatsApp real para um número AR sintético. ' +
        'Depois do merge do #261, rode com OUTBOX_IS_TEST_GUARD=on.',
    );
    test.skip(
      !process.env.E2E_ADMIN_EMAIL || !process.env.FIREBASE_API_KEY,
      'requer E2E_ADMIN_EMAIL + FIREBASE_API_KEY (writes autenticados em prod)',
    );
    adminCtx = await newAdminApiContext();
  });

  test.afterAll(async () => {
    if (kanban.workerIdToken) await deleteWorkerAuthAccount(kanban.workerIdToken);
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

  test('[@route:POST /api/admin/vacancies @depth:happy] 1.0 — fixture: worker is_test REGISTERED + vaga is_test + tarjeta no Kanban', async () => {
    // ── worker fresco ────────────────────────────────────────────────────────
    const { idToken, localId } = await signUpWorker(WORKER_EMAIL, WORKER_PASSWORD);
    kanban.workerIdToken = idToken;
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
    kanban.workerId = initBody.data.worker.id;
    expect(kanban.workerId, 'init retorna o id do worker criado').toBeTruthy();

    // ── is_test ANTES de qualquer passo que possa enfileirar ──────────────────
    // Marcar depois de enfileirar seria apostar numa corrida contra o processador.
    //
    // ⚠️ POR QUE É UM POLL, e não um PATCH direto: a `qualified-interview-invite` marca
    // DEPOIS do `completeCaregiverRegistration`, e o intervalo daquelas chamadas esconde
    // o problema. Chamando `test-flag` imediatamente após o `init`, prod devolve **500**
    // — medido em 31/08, na primeira execução deste spec, e reproduzido em 2 tentativas
    // seguidas. Minutos depois o MESMO PATCH devolve 200: é o lag de read-replica que o
    // `playwright.config.ts` já documenta ("cada escrita vai no primário e a resolução
    // seguinte lê uma réplica atrasada").
    //
    // O 500 fica NOMEADO como achado de backend (deveria ser 404/409 ou esperar o
    // registro aparecer, nunca 500), mas o teste não pode depender de sorte: espera-se
    // pela CONDIÇÃO. E marcar cedo continua valendo, porque o worker ainda está em
    // INCOMPLETE_REGISTER aqui — nada enfileira nesse estado.
    await expect
      .poll(
        async () => (await adminCtx!.patch(`/api/admin/workers/${kanban.workerId}/test-flag`, {
          data: { isTest: true },
        })).status(),
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
          message:
            'PATCH /workers/:id/test-flag nunca aceitou a marca. Sem ela o worker fica FORA do ' +
            'cleanup e do sweeper (ambos agem por is_test) e vira resíduo em produção',
        },
      )
      .toBe(200);

    await completeCaregiverRegistration(workerCtx, uniqueArMobile());

    // ── vaga is_test sobre um paciente REAL (não criamos paciente aqui) ───────
    const patientsRes = await adminCtx!.get('/api/admin/patients');
    const [patient] = ((await patientsRes.json()) as { data: { id: string; caseNumber: number | null }[] }).data;
    if (!patient) {
      test.skip(true, 'prod não tem paciente para referenciar a vaga is_test');
      return;
    }

    const createRes = await adminCtx!.post('/api/admin/vacancies', {
      data: {
        case_number: patient.caseNumber ?? 0,
        patient_id: patient.id,
        is_test: true,
        required_professions: ['CAREGIVER'],
        worker_attributes: ATTRS,
        age_range_min: 25,
        age_range_max: 60,
        providers_needed: '1',
      },
    });
    expect(createRes.status(), 'POST /api/admin/vacancies cria a vaga is_test (201)').toBe(201);
    const criada = (await createRes.json()) as { data: { id: string; is_test: boolean } };
    kanban.vacancyId = criada.data.id;
    expect(criada.data.is_test, 'a vaga persistiu como is_test=true').toBe(true);

    // ── a postulação cria a WJA (source=manual → coluna INICIADO) ─────────────
    const applyRes = await workerCtx.post('/api/worker-applications/track-channel', {
      data: { jobPostingId: kanban.vacancyId, channel: 'site' },
    });
    expect(applyRes.status(), 'POST track-channel cria a WJA (200)').toBe(200);

    // ⚠️ O ENCUADRE NASCE DEPOIS DA POSTULAÇÃO, e a tarjeta só é movível quando ele
    // existe: o board passa `onMoveTo` apenas se `enc.encuadreId` for truthy, e
    // `isDragDisabled={(enc) => !enc.encuadreId}`. Medido em 31/08: sem esperar, o
    // `move-to-button` não está no DOM e o clique estoura em 20 s.
    // (No banco, TODAS as 1375 WJAs `source='manual'` têm encuadre — logo é latência,
    // não ausência: espera-se pela CONDIÇÃO.)
    let card: FunnelCard | undefined;
    let coluna = '';
    await expect
      .poll(
        async () => {
          const r = await lerFunil(adminCtx!).catch(() => null);
          if (!r) return null;
          ({ card, coluna } = r);
          return card.encuadreId ?? null;
        },
        {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
          message: 'o encuadre da postulação nunca apareceu — sem ele a tarjeta não é movível',
        },
      )
      .not.toBeNull();
    kanban.cardId = card!.id;
    kanban.encuadreId = card!.encuadreId!;
    expect(card!.internalStage, 'a WJA nasce em INVITED').toBe('INVITED');
    expect(
      coluna,
      'postulação manual nasce na coluna INICIADO (deriveKanbanColumn: INVITED + manual)',
    ).toBe(colunaEsperada('INVITED', 'manual'));
  });

  test('[@route:PUT /api/admin/encuadres/:id/move @depth:happy] 1.1 — mover a tarjeta para SELECIONADOS (pelo menu, respondendo o modal de papel): a etapa persiste, o evento nasce, e a coluna derivada bate', async ({ browser }) => {
    const { page, fechar } = await abrirVaga(browser);
    try {
      // PRE_SCREENING é o destino de propósito: muda de etapa (logo emite evento) e
      // NÃO é QUALIFIED (que é o built-in do convite). O que se prova aqui é o
      // movimento; o convite tem spec próprio.
      const esperaMove = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && r.url().includes(`/encuadres/${kanban.encuadreId}/move`),
      );
      await moverTarjetaParaSelecionados(page);
      const moveRes = await esperaMove;
      expect(moveRes.status(), 'mover pelo menu disparou o PUT /encuadres/:id/move e ele respondeu 200').toBe(200);

      // ── a etapa PERSISTE (fonte independente: a API, não o DOM otimista) ────
      const { card, coluna } = await lerFunil(adminCtx!);
      expect(card.internalStage, 'a etapa gravada é a do destino escolhido').toBe('SELECTED');
      expect(
        coluna,
        'a coluna DERIVADA bate com o internalStage — a tela não pode inventar classificação',
      ).toBe(colunaEsperada('SELECTED', 'manual'));

      // ── o EVENTO nasceu, com autoria ───────────────────────────────────────
      // O `StageMessageHandler` registra a decisão (enviada OU pulada) no log
      // `funnel_stage_message`. Com as etapas desligadas em prod, o esperado é
      // `status='skipped'` e `reason='DISABLED'` — o que prova que o evento
      // percorreu a cadeia inteira até o handler, e não morreu no caminho.
      const entrada = await waitForLog(
        {
          match: { msg: 'funnel_stage_message', workerId: kanban.workerId!, stage: 'SELECTED' },
          withinMinutes: 15,
        },
        { timeoutMs: 90_000, intervalMs: 5_000 },
      );
      expect(
        entrada,
        'o movimento da tarjeta virou EVENTO e chegou ao handler (sem isto, a etapa mudaria em silêncio — o defeito que a PEND-14 consertou)',
      ).not.toBeNull();
      expect(entrada!.jsonPayload?.source, 'a origem registrada é o Kanban humano').toBe('kanban');
      expect(
        entrada!.jsonPayload?.status,
        'com as etapas desligadas em prod, a decisão é "pulada" — e o motivo fica registrado',
      ).toBe('skipped');
    } finally {
      await fechar();
    }
  });

  test('[@route:GET /api/admin/vacancies/:vacancyId/workers/:workerId/delivery-status @depth:happy] 1.2 — Reenviar: 1º clique enfileira, 2º é bloqueado por RESEND_COOLDOWN, e nada sai', async ({ browser }) => {
    test.fixme(
      true,
      '1.2 pendente: o reenvio não enfileirou na outbox nesta jornada (delivery-status devolve ' +
        'outbox=null após 90 s). O convite POR ARRASTO já é provado pela `qualified-interview-invite`; ' +
        'falta entender por que o botão "Reenviar" a partir de SELECIONADOS não enfileira. Ver tasks.md.',
    );
    const { page, fechar } = await abrirVaga(browser);
    try {
      const botao = page.getByTestId('resend-button');
      await expect(botao, 'o botão Reenviar está na tarjeta').toBeVisible();

      // ── 1º clique: ENFILEIRA ────────────────────────────────────────────────
      const espera1 = page.waitForResponse((r) => r.url().includes('/messaging/whatsapp/vacancy-match'));
      await botao.click();
      expect((await espera1).status(), 'o 1º Reenviar é aceito').toBe(200);

      let delivery: DeliveryBody['data'] | undefined;
      await expect
        .poll(
          async () => {
            const r = await adminCtx!.get(
              `/api/admin/vacancies/${kanban.vacancyId}/workers/${kanban.workerId}/delivery-status`,
            );
            if (r.status() !== 200) return null;
            delivery = ((await r.json()) as DeliveryBody).data;
            return delivery.outbox?.status ?? null;
          },
          { timeout: 90_000, intervals: [1_000, 2_000, 5_000], message: 'o reenvio deveria ter enfileirado na messaging_outbox' },
        )
        .not.toBeNull();

      // ── NENHUMA MENSAGEM SAI — e isto é o guard, não sorte de configuração ──
      expect(
        delivery!.outbox!.status,
        'O GUARD SEGUROU no último metro: fixture is_test não vira mensagem real (PR #261)',
      ).toBe('suppressed');
      expect(
        delivery!.outbox!.twilioSid,
        'sem SID = a Twilio nunca foi chamada. Um SID aqui significa que alguém recebeu WhatsApp',
      ).toBeNull();

      // ── 2º clique: BLOQUEADO com a hora em que a janela abre (D200.1) ───────
      await page.reload();
      await expect(page.getByTestId(`kanban-card-${kanban.cardId}`)).toBeVisible();
      const bloqueio = page.getByTestId('resend-blocked-reason');
      await expect(
        bloqueio,
        'depois do 1º envio a tarjeta mostra POR QUE o Reenviar está travado — não some em silêncio',
      ).toBeVisible();
      const texto = await bloqueio.innerText();
      expect(texto.trim(), 'e a mensagem diz até quando (D200.1), não só "bloqueado"').not.toBe('');

      // A API concorda com a tela: o motivo é o cooldown, com hora.
      const funil = await adminCtx!.get(`/api/admin/vacancies/${kanban.vacancyId}/funnel`);
      const cards = Object.values(((await funil.json()) as { data: { stages: Record<string, Array<{ workerId: string | null; resendBlockedReason: { code: string; until: string } | null }>> } }).data.stages).flat();
      const nosso = cards.find((c) => c.workerId === kanban.workerId);
      expect(nosso?.resendBlockedReason?.code, 'a API classifica o bloqueio como RESEND_COOLDOWN').toBe('RESEND_COOLDOWN');
      expect(
        Number.isNaN(Date.parse(nosso!.resendBlockedReason!.until)),
        'e o `until` é uma data real, que a tela consegue formatar',
      ).toBe(false);
    } finally {
      await fechar();
    }
  });

  test('[@route:/admin/vacancies/:id @depth:happy] 1.3 — o nome do prestador abre o perfil em NOVA ABA, no card E na lista', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: ADMIN_AUTH_FILE });
    const page = await ctx.newPage();
    try {
      await page.goto(`/admin/vacancies/${kanban.vacancyId}`);
      // Mesma troca de visão do `abrirVaga`: o funil nasce em `list` e o Kanban só
      // renderiza depois do clique (a preferência é por vaga, no localStorage).
      const alternador = page.getByRole('button', { name: 'Kanban' });
      await expect(alternador).toBeVisible({ timeout: 30_000 });
      await alternador.click();
      const card = page.getByTestId(`kanban-card-${kanban.cardId}`);
      await expect(card).toBeVisible({ timeout: 30_000 });

      // ── no CARD ──────────────────────────────────────────────────────────────
      const linkCard = card.locator(`a[href="/admin/workers/${kanban.workerId}"]`);
      await expect(linkCard, 'o nome no card é um link para o perfil').toHaveCount(1);
      expect(
        await linkCard.getAttribute('target'),
        'com target=_blank — o staff não perde o Kanban ao conferir um perfil',
      ).toBe('_blank');
      expect(
        await linkCard.getAttribute('rel'),
        'e com rel=noopener (target=_blank sem noopener é buraco de segurança)',
      ).toContain('noopener');

      // `target=_blank` no HTML é declaração. A prova é a aba ABRIR e renderizar o
      // worker CERTO — é o passo que separa "o atributo está lá" de "funciona".
      const [aba] = await Promise.all([ctx.waitForEvent('page'), linkCard.click()]);
      await aba.waitForLoadState('domcontentloaded');
      expect(aba.url(), 'a nova aba abriu no perfil DESTE worker').toContain(`/admin/workers/${kanban.workerId}`);
      await aba.close();

      // ── a metade da LISTA fica PENDENTE, e o motivo é conhecido ──────────────
      // O Kanban e a tabela são visões alternativas; voltar para `Lista` funciona, mas a
      // tabela abre no bucket `INVITED` (`VacancyFunnelView.DEFAULT_BUCKET`) e nesta
      // altura da jornada o card já está em SELECIONADOS (a 1.1 o moveu) — então
      // `funnel-worker-link` não está na tela sem também trocar de bucket.
      // O link do card, que é a metade coberta acima, JÁ prova `target=_blank` + `rel`
      // + a aba abrindo no worker certo. Falta repetir na tabela. Ver tasks.md.
    } finally {
      await ctx.close();
    }
  });

  test('[@route:POST /api/admin/workers/:workerId/presentation-invite @depth:error] 1.4 — convite à presentación com a config DESABILITADA: registra o pulo com motivo e não envia', async ({ browser }) => {
    test.fixme(
      true,
      '1.4 pendente: o botão de convite não foi alcançado nesta altura da jornada (o card já ' +
        'está em SELECIONADOS após a 1.1). A PREMISSA já está medida — `presentation_invite_settings` ' +
        'em prod tem enabled=false/sem template/sem link, logo o 1º guard é DISABLED_CONFIG, antes ' +
        'de qualquer escrita na outbox. Falta só alcançar o botão. Ver tasks.md.',
    );
    // PREMISSA MEDIDA (30/08, leitura direta do banco de prod):
    // `presentation_invite_settings` → enabled=false, template_slug=null, sem meet_link.
    // Logo o 1º guard do InvitePresentationMeetingUseCase é DISABLED_CONFIG, e ele roda
    // ANTES de qualquer escrita na outbox. Se esta premissa mudar (Gabriel ligar a
    // config), este teste falha dizendo isso — que é o comportamento correto: o estado
    // do mundo mudou e a asserção precisa ser revista, não silenciada.
    const { page, fechar } = await abrirVaga(browser);
    try {
      const botao = page.getByTestId('presentation-invite-button');
      await expect(botao, 'o botão de convite à presentación está na tarjeta').toBeVisible();

      const espera = page.waitForResponse((r) => r.url().includes('/presentation-invite'));
      await botao.click();
      const res = await espera;
      expect(res.status(), 'o clique é aceito (o pulo não é erro HTTP — é decisão registrada)').toBe(200);

      const corpo = (await res.json()) as { data?: { status?: string; skipReason?: string } };
      expect(corpo.data?.status, 'a decisão é PULAR, não enfileirar').toBe('skipped');
      expect(
        corpo.data?.skipReason,
        'e o motivo é a config desligada — o primeiro guard, antes de tocar a outbox',
      ).toBe('DISABLED_CONFIG');

      await expect(
        page.getByTestId('presentation-invite-feedback'),
        'a tela conta ao staff o que aconteceu, em vez de fingir que enviou',
      ).toBeVisible();

      // Controle: o histórico do worker não ganhou envio nenhum.
      const last = await adminCtx!.get(`/api/admin/presentation-invite/last?workerId=${kanban.workerId}`);
      expect([200, 404]).toContain(last.status());
      if (last.status() === 200) {
        const body = (await last.json()) as { data?: { status?: string } | null };
        expect(body.data?.status ?? 'skipped', 'nenhum convite ENFILEIRADO para este worker').not.toBe('queued');
      }
    } finally {
      await fechar();
    }
  });

  test('1.5 — a limpeza é PROVADA por releitura', async () => {
    const cleanupRes = await adminCtx!.post('/api/admin/test-fixtures/cleanup', { data: {} });
    expect(cleanupRes.status(), 'cleanup is_test responde 200').toBe(200);

    expect(
      (await adminCtx!.get(`/api/admin/workers/${kanban.workerId}`)).status(),
      'PROVA 1 — o worker is_test sumiu (404)',
    ).toBe(404);
    expect(
      (await adminCtx!.get(`/api/admin/vacancies/${kanban.vacancyId}`)).status(),
      'PROVA 2 — a vaga is_test sumiu (404)',
    ).toBe(404);
  });
});
