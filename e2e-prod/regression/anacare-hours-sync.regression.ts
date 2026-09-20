/**
 * anacare-hours-sync.regression.ts — a tela `/admin/anacare/horas` REALMENTE sincroniza o mês
 * que ela EXIBE, contra PRODUÇÃO (enlite-prd).
 *
 * ── O defeito que este teste existe para pegar ──────────────────────────────────────────────
 * O sync manual (botão "Sincronizar", F6.4) dispara `POST /api/admin/anacare-hours/sync` com o
 * `month` que o HOOK tem em memória (`useAnaCareHoursSync`, parâmetro `month`) — que precisa ser
 * o MESMO mês que o SELETOR mostra na tela. Se um dia os dois desalinharem (ex.: o container
 * passar o mês errado pro hook), o operador vê "Setembro" no seletor e sincroniza Agosto sem
 * saber — silencioso. A asserção central (teste 2) compara o `month` do CORPO do POST com o mês
 * lido do DOM do seletor, no mesmo instante do clique.
 *
 * ── Decisão do Gabriel (20/09) que rege o desenho ───────────────────────────────────────────
 * O teste deixa o LAÇO INTEIRO terminar (nunca interrompe no meio) e roda SEMANALMENTE, não
 * diariamente (ver `e2e-prod/scripts/deploy-monitor.sh`, agendamento `e2e-prod-regression-weekly`).
 * Motivo: a gravação de cada rodada SUBSTITUI o retrato do mês por uma corrida NOVA de dados; um
 * teste que clica "Sincronizar" e vai embora no meio deixa o mês PELA METADE — foi exatamente
 * assim que agosto ficou travado em 40% por semanas em produção (histórico do brief, `useAnaCare-
 * HoursSync.ts`). Interromper o laço no meio É o incidente automatizado que este teste evita.
 *
 * ── O que este teste ALTERA em produção ─────────────────────────────────────────────────────
 * Ele reescreve o RETRATO (`anacare_patient_month` e as tabelas de turno que o backend deriva
 * dele) do mês sincronizado — a MESMA operação que um operador humano faria clicando
 * "Sincronizar" na tela. Não cria e não apaga nenhuma entidade sintética (paciente/worker/vaga)
 * marcável com `is_test` — o alvo é o mês real, com dado real.
 *
 * ── Por que NÃO HÁ teardown/"desfazer" ───────────────────────────────────────────────────────
 * Sincronizar de novo (rodar este teste outra vez, ou o operador clicar o botão de novo) é
 * IDEMPOTENTE pelo próprio desenho do sync (upsert por turno, cursor até `nextCursor === null`)
 * — não existe um "estado anterior" que faça sentido restaurar, porque o retrato correto É o
 * resultado de uma corrida completa contra o Ana Care real. Um "desfazer" aqui significaria
 * voltar a um retrato DESATUALIZADO de propósito, o que é pior, não neutro. Por isso: nenhum
 * `afterAll` de limpeza abaixo — deixar o laço terminar é o próprio ato que mantém o estado
 * íntegro (a alternativa, interromper, é o bug que este teste existe pra provar que não acontece
 * mais).
 *
 * ── Caminho de FALHA — o que fazer se este teste estourar o timeout ────────────────────────
 * O parágrafo acima cobre o caminho feliz. Mas se a corrida terminar em ERRO (`anacare-hours-
 * sync-error` aparecer) ou vier `deduped` (`anacare-hours-sync-deduped`, corrida concorrente
 * detectada), o indicador `anacare-hours-sync-done` NUNCA aparece — este teste estoura
 * `LOOP_TIMEOUT_MS` e falha por timeout, não por asserção. Nesse caso o MÊS FICA PELA METADE:
 * exatamente o incidente que este teste existe pra pegar, só que acontecendo dentro do próprio
 * monitor, sem teardown que resolva (não há "desfazer" um sync parcial — só terminá-lo). Quem
 * for triar essa falha (ex.: domingo 4h AR, sem ninguém olhando) precisa RETOMAR o sync até o
 * fim — pela tela (`/admin/anacare/horas`, botão "Sincronizar" de novo: o cursor de retomada
 * garante que ele CONTINUA, não recomeça do zero) ou pela API (`POST /api/admin/anacare-hours/
 * sync` com o `month` e o `cursor` da última rodada observada nos logs) — antes de considerar o
 * alarme resolvido. Reportar a falha e seguir em frente SEM retomar deixa o retrato real
 * incompleto em produção.
 *
 * REGRAS DA SUÍTE (e2e-prod/CLAUDE.md): zero `page.route()`/mock; web-first assertions; NUNCA
 * `waitForTimeout` cru; `page.waitForRequest` é OBSERVAÇÃO (não interceptação), permitida nos
 * projetos read-real. Texto clínico/PII de paciente NUNCA é lido nem impresso — as asserções
 * abaixo só tocam contagem, `data-testid` (identificador operacional, `anaCareId`) e o corpo JSON
 * do POST (`month`/`cursor`/`budgetMs`, nenhum campo clínico).
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

/**
 * `SYNC_ROUND_BUDGET_MS = 100_000` (100s por rodada) — mesma constante de
 * `enlite-frontend/src/hooks/admin/useAnaCareHoursSync.ts:10`, comentada aqui pra quem lê o
 * teste não precisar abrir outro arquivo. Medido na STAGE em 18/09
 * (`bin/anacare-medicoes/stg-anacare-sync.mjs`): ~283 reservas do mês, 1 rodada cobre ~74
 * (74/283) → ~4 rodadas → ~7 min no total (rate limit de 1 chamada ao Ana Care por reserva, com
 * mínimo 1s entre elas — `AnaCareRateLimiter`).
 *
 * PRODUÇÃO tende a ter MAIS reservas que a massa sintética da stage, e soma cold start do Cloud
 * Run — por isso o timeout abaixo é ~40% maior que o medido, de propósito (não é arredondamento).
 */
const MEASURED_STAGE_DURATION_MS = 7 * 60_000; // ~7 min, medido na stage (18/09)
const LOOP_TIMEOUT_MS = 10 * 60_000; // 10 min — margem generosa sobre o medido, pra prod real
const TEST_TIMEOUT_MS = LOOP_TIMEOUT_MS + 60_000; // +1 min pra abrir a tela e ler a tabela no fim

/** Estado que atravessa os 3 passos (describe.serial) — MESMA `page`/`context`, de propósito: o
 * laço do sync vive em estado React DENTRO da aba (não em endpoint de status no backend), então
 * "esperar o laço fechar" só faz sentido continuando na MESMA sessão de navegador que clicou
 * "Sincronizar" — reabrir a tela perderia o estado em memória do hook. */
const journey: { targetMonth?: string; ctx?: BrowserContext; page?: Page } = {};

test.describe.serial('AnaCare Horas — o sync real sincroniza o MÊS que a tela exibe (prod)', () => {
  test.afterAll(async () => {
    // Ver cabeçalho "Por que NÃO HÁ teardown": nada a desfazer, só fechar o navegador.
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

  test('2. dispara "Sincronizar" e prova que o POST leva o MÊS LIDO DA TELA (asserção central)', async () => {
    const page = journey.page!;
    const syncButton = page.getByTestId('anacare-hours-sync-button');
    await expect(syncButton).toBeVisible({ timeout: 30_000 });

    const primeiraRodada = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().includes('/api/admin/anacare-hours/sync'),
    );
    await syncButton.click();
    const req = await primeiraRodada;

    // ── ASSERÇÃO CENTRAL ──────────────────────────────────────────────────────────────────────
    // O corpo da PRIMEIRA rodada tem que levar o MESMO mês que acabamos de ler e selecionar no
    // DOM (passo 1) — a mesma fonte que o operador está olhando na tela NESTE instante.
    const body = req.postDataJSON() as { month?: string; cursor?: number | null; budgetMs?: number };
    expect(
      body.month,
      'o corpo do POST /anacare-hours/sync tem que levar o mês exibido no seletor, não outro',
    ).toBe(journey.targetMonth);
    // Primeira rodada de uma corrida NOVA (contexto de navegador recém-criado no passo 1, sem
    // `sessionStorage` de uma corrida anterior): sem cursor de retomada.
    expect(body.cursor ?? null, 'primeira rodada não deveria carregar cursor de retomada').toBeNull();
    expect(body.budgetMs, 'orçamento da rodada deveria ser o SYNC_ROUND_BUDGET_MS do hook').toBe(100_000);

    test.info().annotations.push({
      type: 'evidência',
      description: `1ª rodada do POST: month=${body.month} cursor=${body.cursor ?? 'null'} budgetMs=${body.budgetMs}`,
    });
  });

  test('3. espera o laço FECHAR até o fim (decisão do Gabriel, 20/09: nunca interromper) e confirma dado do mês sincronizado na tela', async () => {
    // Bump do timeout de 60s (default de `playwright.config.ts`) pra caber o laço inteiro — ver
    // comentário de LOOP_TIMEOUT_MS/TEST_TIMEOUT_MS no topo do arquivo.
    test.setTimeout(TEST_TIMEOUT_MS);
    const page = journey.page!;

    // Web-first, PROIBIDO waitForTimeout cru: espera o INDICADOR DE CONCLUÍDO
    // (`anacare-hours-sync-done`, só existe quando `status === 'done'` —
    // AnaCareHoursSyncButton.tsx) aparecer. O laço pode levar de ~4 a muitas rodadas dependendo
    // de quantas reservas o mês tem HOJE — nunca um número fixo de segundos, sempre o ESTADO real
    // da tela decide quando o teste segue.
    await expect(page.getByTestId('anacare-hours-sync-done')).toBeVisible({ timeout: LOOP_TIMEOUT_MS });

    // Caminho feliz: nenhum erro nem dedupe deveria ter interrompido a corrida no meio.
    await expect(page.getByTestId('anacare-hours-sync-error')).toHaveCount(0);
    await expect(page.getByTestId('anacare-hours-sync-deduped')).toHaveCount(0);

    // `onComplete=refetch` (useAnaCareHoursSync → AnaCareHoursListContainer) recarrega o
    // snapshot do MESMO mês assim que o laço termina — a tabela deve mostrar linhas de paciente
    // do mês sincronizado. Só CONTAGEM + o identificador operacional (`anaCareId` no
    // `data-testid`, um ID de sistema — não nome, não texto clínico) — regra dura do CLAUDE.md da
    // raiz: texto clínico NUNCA entra em prompt/log; status/contagem/ID sempre podem.
    const patientRows = page.locator('[data-testid^="anacare-hours-patient-row-"]');
    await expect(patientRows.first()).toBeVisible({ timeout: 30_000 });
    const rowCount = await patientRows.count();
    expect(
      rowCount,
      `mês ${journey.targetMonth} sincronizado (status=done) mas a tela não mostra nenhum paciente`,
    ).toBeGreaterThan(0);

    test.info().annotations.push({
      type: 'evidência',
      description: `Laço fechado (status=done) para o mês ${journey.targetMonth}; ${rowCount} pacientes na tela. Medido na stage: ~${Math.round(MEASURED_STAGE_DURATION_MS / 60_000)} min; timeout usado aqui: ${Math.round(LOOP_TIMEOUT_MS / 60_000)} min.`,
    });
  });
});
