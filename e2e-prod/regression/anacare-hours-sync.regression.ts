/**
 * anacare-hours-sync.regression.ts — prova que o botão "Sincronizar" (F6.4) da tela
 * `/admin/anacare/horas` dispara `POST /api/admin/anacare-hours/sync` com o MESMO mês que o
 * seletor exibe, contra produção real (enlite-prd) — sem disparar o sync de verdade.
 *
 * ── Por que o sync real NÃO roda aqui (mudou em 21/09/2026) ──────────────────────────────────
 * `e2e-prod` é só para testar — nunca o mecanismo que sincroniza dado de negócio em produção (ver
 * `../../CLAUDE.md`); e D388 mantém o sync automático ADIADO. A versão anterior deste teste
 * deixava o laço de sync real rodar até 10 min, o que reintroduzia por via indireta o sync
 * automático que a D388 adiou; hoje isso estourou o timeout do job `e2e-prod-smoke` e derrubou a
 * suíte inteira. Agora o teste INTERCEPTA o POST (`page.route`) e responde com um corpo
 * fabricado de corrida concluída — nada chega ao backend real. Isso é uma exceção pontual e
 * autorizada à regra "zero mock" desta suíte (`../CLAUDE.md` §1): aqui o risco maior era o
 * próprio teste SER a operação de produção, não deixar de pegar um erro real dela.
 *
 * Ainda prova: `month` do corpo do POST é o mesmo que o seletor exibe (asserção central),
 * `budgetMs === 30_000`, e que a tela sabe renderizar o estado "concluído" a partir da resposta.
 * Deixou de provar que o backend termina uma sincronização real em produção — ver
 * `openspec/changes/e2e-prod-sem-sync-anacare-horas` (repo `ebrain`) para o design completo.
 *
 * Texto clínico/PII de paciente NUNCA é lido nem impresso — as asserções abaixo só tocam
 * contagem, `data-testid` (identificador operacional, `anaCareId`) e o corpo JSON do
 * POST/resposta fake (`month`/`cursor`/`budgetMs`, nenhum campo clínico).
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

/**
 * `SYNC_ROUND_BUDGET_MS = 30_000` — mesma constante de
 * `enlite-frontend/src/hooks/admin/useAnaCareHoursSync.ts:16`, comentada aqui pra quem lê o teste
 * não precisar abrir outro arquivo. É o valor que a asserção central (teste 2) espera encontrar
 * no corpo do POST — não controla mais nenhum timeout deste teste, porque o sync agora é
 * interceptado, nunca real.
 */
const SYNC_ROUND_BUDGET_MS = 30_000;

/**
 * Corpo fabricado de UMA corrida concluída (`nextCursor: null` já na 1ª rodada), no formato de
 * `TriggerSyncResult` (`enlite-frontend/.../AnaCareHours/types.ts:294`) e do payload real
 * devolvido por `AnaCareHoursSyncController.trigger`
 * (`worker-functions/src/modules/anacare-hours/interfaces/controllers/AnaCareHoursSyncController.ts`).
 * `nextCursor: null` é o que faz `useAnaCareHoursSync` marcar `status: 'done'` e chamar
 * `onComplete` — o mesmo caminho de código de uma corrida real bem-sucedida. Contagens pequenas e
 * óbvias (1), nunca plausíveis de produção — deixa claro, pra quem ler o teste ou os logs, que é
 * dado fabricado de teste.
 */
function fakeSyncDoneBody() {
  return {
    success: true,
    deduped: false,
    shiftsRead: 1,
    reservationsProcessed: 1,
    shiftsWritten: 1,
    nextCursor: null,
    reservationsTotal: 1,
    reservationsDone: 1,
    runStartedAt: new Date().toISOString(),
    shiftsSkippedNoProvider: 0,
    shiftsSkippedNoPatient: 0,
  };
}

/** Estado que atravessa os 3 passos (describe.serial) — MESMA `page`/`context`, de propósito: o
 * hook de sync vive em estado React DENTRO da aba, então "ver o estado concluído" só faz sentido
 * continuando na MESMA sessão de navegador que clicou "Sincronizar" — reabrir a tela perderia o
 * estado em memória do hook. */
const journey: { targetMonth?: string; ctx?: BrowserContext; page?: Page } = {};

test.describe.serial('AnaCare Horas — o clique em Sincronizar leva o MÊS que a tela exibe (prod, sync interceptado)', () => {
  test.afterAll(async () => {
    // Nada a desfazer: a requisição de sync nunca chegou ao backend real, só fechar o navegador.
    await journey.ctx?.close().catch(() => undefined);
  });

  // Sem tag de cobertura de rota no título, de propósito: `/admin/anacare/horas` ainda não está
  // no manifesto (`src/coverage/user-facing-routes.ts`) — uma tag de rota sem par no manifesto
  // vira "órfã" e reprova o gate de cobertura (confirmado rodando o gate localmente antes deste
  // commit — inclusive o TEXTO desta tag, não só o título do teste, é varrido pelo gate: por isso
  // este comentário evita escrever a sequência arroba-r-o-u-t-e-dois-pontos por extenso).
  // Registrar a rota no manifesto é decisão fora do escopo desta task — ver ACHADOS NÃO
  // CONSERTADOS no relatório.
  test('1. abre a tela autenticada e lê o mês do seletor — NUNCA cravado em código', async ({
    browser,
  }) => {
    journey.ctx = await browser.newContext({ storageState: ADMIN_AUTH_FILE });
    journey.page = await journey.ctx.newPage();
    await journey.page.goto('/admin/anacare/horas');

    const monthSelect = journey.page.getByLabel(/^mes$/i);
    await expect(monthSelect).toBeVisible({ timeout: 30_000 });

    // Lê as opções REAIS renderizadas (`monthOptionsUntilNow`, selectors.ts): lista CRESCENTE do
    // piso até o mês CORRENTE do relógio do OPERADOR (D390, decisão do Gabriel de 20/09 — nunca
    // UTC). A ÚLTIMA opção é sempre o mês corrente — escolhemos ELA, lida do DOM. Se a régua de
    // "mês default" regredir um dia (ex.: voltar a mês-anterior), este teste continua válido:
    // segue o que a TELA mostra, não uma expectativa fixa de qual mês deveria ser hoje.
    const optionValues = await monthSelect
      .locator('option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    expect(optionValues.length, 'seletor de mês sem nenhuma opção').toBeGreaterThan(0);
    journey.targetMonth = optionValues[optionValues.length - 1];
    expect(journey.targetMonth, 'valor do mês selecionado não tem a forma YYYY-MM').toMatch(/^\d{4}-\d{2}$/);

    // Seleciona EXPLICITAMENTE (mesmo que já seja o valor default) — prova o binding
    // seletor→estado, não só que o default por acaso coincide com o que escolhemos.
    await monthSelect.selectOption(journey.targetMonth!);
    await expect(monthSelect).toHaveValue(journey.targetMonth!);

    test.info().annotations.push({
      type: 'evidência',
      description: `Mês escolhido, lido da ÚLTIMA opção do seletor da tela: ${journey.targetMonth}`,
    });
  });

  test('2. dispara "Sincronizar", INTERCEPTA o POST antes que ele saia do navegador e prova que o corpo leva o MÊS LIDO DA TELA (asserção central)', async () => {
    const page = journey.page!;
    const syncButton = page.getByTestId('anacare-hours-sync-button');
    await expect(syncButton).toBeVisible({ timeout: 30_000 });

    let capturedBody: { month?: string; cursor?: number | null; budgetMs?: number } | undefined;

    // INTERCEPTA — ver cabeçalho do arquivo para o porquê. Captura o corpo ANTES de responder,
    // preservando a mesma ordem de prova que o teste já fazia (captura → asserção do request →
    // asserção do estado final da tela, no teste 3), só que a resposta agora é fabricada, nunca
    // vinda do backend real.
    await page.route('**/api/admin/anacare-hours/sync', async (route) => {
      capturedBody = route.request().postDataJSON() as {
        month?: string;
        cursor?: number | null;
        budgetMs?: number;
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fakeSyncDoneBody()),
      });
    });

    await syncButton.click();
    await expect
      .poll(() => capturedBody !== undefined, {
        message: 'o POST /anacare-hours/sync interceptado não chegou a ser capturado a tempo',
        timeout: 10_000,
      })
      .toBe(true);

    // ── ASSERÇÃO CENTRAL ──────────────────────────────────────────────────────────────────────
    // O corpo interceptado tem que levar o MESMO mês que acabamos de ler e selecionar no DOM
    // (passo 1) — a mesma fonte que o operador estaria olhando na tela neste instante.
    const body = capturedBody!;
    expect(
      body.month,
      'o corpo do POST /anacare-hours/sync tem que levar o mês exibido no seletor, não outro',
    ).toBe(journey.targetMonth);
    // Primeira rodada de uma corrida NOVA (contexto de navegador recém-criado no passo 1, sem
    // `sessionStorage` de uma corrida anterior): sem cursor de retomada.
    expect(body.cursor ?? null, 'primeira rodada não deveria carregar cursor de retomada').toBeNull();
    expect(body.budgetMs, 'orçamento da rodada deveria ser o SYNC_ROUND_BUDGET_MS do hook').toBe(
      SYNC_ROUND_BUDGET_MS,
    );

    test.info().annotations.push({
      type: 'evidência',
      description: `POST interceptado (nunca chegou ao backend real): month=${body.month} cursor=${body.cursor ?? 'null'} budgetMs=${body.budgetMs}`,
    });
  });

  test('3. a tela mostra o estado CONCLUÍDO a partir da resposta simulada, em segundos (sem laço real)', async () => {
    const page = journey.page!;

    // Web-first, PROIBIDO waitForTimeout cru: espera o INDICADOR DE CONCLUÍDO
    // (`anacare-hours-sync-done`, só existe quando `status === 'done'` — AnaCareHoursSyncButton.tsx)
    // aparecer. Como a resposta interceptada já volta com `nextCursor: null` na 1ª rodada, isto
    // resolve em segundos — não há mais laço de várias rodadas para esperar.
    await expect(page.getByTestId('anacare-hours-sync-done')).toBeVisible({ timeout: 15_000 });

    // Caminho feliz: a resposta fabricada é sempre sucesso, então nenhum erro nem dedupe deveria
    // ter aparecido.
    await expect(page.getByTestId('anacare-hours-sync-error')).toHaveCount(0);
    await expect(page.getByTestId('anacare-hours-sync-deduped')).toHaveCount(0);

    // `onComplete=refetch` (useAnaCareHoursSync → AnaCareHoursListContainer) recarrega o
    // snapshot do MESMO mês assim que o hook marca `done`. Como o sync foi interceptado, essas
    // linhas vêm do snapshot JÁ EXISTENTE no banco (de sincronizações reais anteriores) — isto
    // prova que a tela sabe renderizar o caminho "pós-sync", não que este clique atualizou dado
    // nenhum. Só CONTAGEM + o identificador operacional (`anaCareId` no `data-testid`, um ID de
    // sistema — não nome, não texto clínico) — regra dura do CLAUDE.md da raiz: texto clínico
    // NUNCA entra em prompt/log; status/contagem/ID sempre podem.
    const patientRows = page.locator('[data-testid^="anacare-hours-patient-row-"]');
    await expect(patientRows.first()).toBeVisible({ timeout: 30_000 });
    const rowCount = await patientRows.count();
    expect(
      rowCount,
      `tela em estado "concluído" para o mês ${journey.targetMonth} mas sem nenhum paciente visível`,
    ).toBeGreaterThan(0);

    test.info().annotations.push({
      type: 'evidência',
      description: `Estado "concluído" (a partir da resposta interceptada) para o mês ${journey.targetMonth}; ${rowCount} pacientes na tela (snapshot pré-existente, não deste clique).`,
    });
  });
});
