/**
 * vaga-ciclo-staff.regression.ts — o ciclo da VAGA pela mão do staff, contra PRODUÇÃO.
 * (Spec 009, Fase 3 — itens 3.1, 3.2a e 3.3.)
 *
 * ── POR QUE ESTA FASE NÃO ESTÁ ATRÁS DO PORTÃO DO #261 ───────────────────────
 * O plano original marcou "Fases 1 e 3 tocam mensageria". Para a Fase 1 isso se
 * confirmou por mecanismo (todo movimento de tarjeta emite evento que pode enfileirar).
 * Para a Fase 3, NÃO: o que ligava a 3.2 à mensageria era provar o fuso PELO CONVITE —
 * e o parecer do CTO (30/08) tirou o convite do caminho, porque `delivery-status` não
 * expõe `variables` e o log do handler grava só `slots: [source]`; provar por ali
 * exigiria mudar produto, o que a `spec.md` veta.
 *
 * O que sobra aqui — criar/editar vaga, gravar slot, filtrar lista — não tem passo
 * outbound. E não é opinião minha: `talentum-prescreening-audio.regression.ts` JÁ cria,
 * publica e apaga vaga `is_test` contra prod todo dia às 3h, desde julho. O precedente
 * é a evidência.
 *
 * ── O QUE ESTE SPEC PROVA ────────────────────────────────────────────────────
 *  3.1  a vaga nasce `is_test`, é editada e a edição sobrevive à releitura — pela API
 *       E na tela do staff. Com controle positivo: o valor DEPOIS é diferente do ANTES.
 *  3.2a o slot recorrente grava e relê (`weekday`/`time`/`link`), e o Merge Patch da
 *       chave `recurring` funciona nos dois sentidos (grava valor · `null` limpa).
 *  3.3  o combobox das listas longas filtra por digitação e a escolha vira FILTRO na
 *       requisição — não só um rótulo bonito na tela.
 *
 * ── ⚠️ O QUE ESTE SPEC EXPLICITAMENTE NÃO PROVA ──────────────────────────────
 *  · **A 3.2a NÃO PROVA O FUSO** (D213). Isto é um rótulo, não uma ressalva de rodapé:
 *    `meet_recurring_time` é `TIME` do Postgres (sem fuso) e `weekday` é inteiro, então
 *    gravar `08:30` e reler `08:30:00` passa VERDE mesmo com a resolução 100% em UTC —
 *    **nenhum instante participa da asserção**. Seria falso positivo GARANTIDO, não
 *    provável. A prova de fuso é a 3.2b, pela capability MCP `interviewSlotsList`, única
 *    superfície que devolve o par (`label` no fuso, `iso` em UTC) — e só o par quebra o
 *    erro simétrico (formatar em UTC o que foi interpretado como UTC devolve o rótulo
 *    certo com o instante 3 h errado). A 3.2b depende do principal
 *    `mcp-principal-e2e-prod`, que é ato do Gabriel em produção.
 *  · Não prova a propagação para o Portal Jobs (3.4) — autorizada, mas com um conflito
 *    de orçamento aberto: o Cloud Run Job tem `--task-timeout=900s` e a 3.4 sozinha custa
 *    ~10 min (WP-Cron ≤5 min + Breeze 161 s + o ciclo da deleção). Ver `tasks.md`.
 *
 * ── TEARDOWN ─────────────────────────────────────────────────────────────────
 * `POST /api/admin/test-fixtures/cleanup`, provado por releitura 404.
 */
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { newAdminApiContext } from '../src/support/adminApi';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ATTRS_INICIAL = `E2E-VAGA-INICIAL-${STAMP}`;
const ATTRS_EDITADO = `E2E-VAGA-EDITADO-${STAMP}`;

/** Sala sintética. O formato é validado (`isValidMeetLink`), então não pode ser qualquer string. */
const SALA_RECORRENTE = 'https://meet.google.com/rte-stee-001';
/** Segunda-feira (0=domingo), 08:30 local da vaga. */
const RECORRENTE = { weekday: 1, time: '08:30', link: SALA_RECORRENTE } as const;

const vaga: { id?: string } = {};

/**
 * ⚠️ As DUAS rotas devolvem o slot recorrente em formas DIFERENTES — medido em prod,
 * 30/08, depois de eu ter chutado errado e o teste quebrar:
 *   · `PUT /meet-links`      → `data.meet_recurring = { weekday, time: 'HH:MM', link }` (aninhado)
 *   · `GET /vacancies/:id`   → PLANO: `meet_recurring_weekday`, `meet_recurring_time`
 *                              ('HH:MM:SS', o TIME do Postgres), `meet_recurring_link`
 * A releitura é feita pelo GET, então é a forma PLANA que vale aqui.
 */
interface VacancyBody {
  data: {
    id: string;
    is_test?: boolean;
    worker_attributes?: string | null;
    meet_recurring_weekday?: number | null;
    meet_recurring_time?: string | null;
    meet_recurring_link?: string | null;
  };
}

async function lerVaga(ctx: APIRequestContext): Promise<VacancyBody['data']> {
  const res = await ctx.get(`/api/admin/vacancies/${vaga.id}`);
  expect(res.status(), 'GET /api/admin/vacancies/:id responde 200').toBe(200);
  return ((await res.json()) as VacancyBody).data;
}

async function abrirComAdmin(browser: Browser, rota: string): Promise<{ page: Page; fechar: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: ADMIN_AUTH_FILE });
  const page = await ctx.newPage();
  await page.goto(rota);
  return { page, fechar: async () => { await ctx.close(); } };
}

/**
 * PORTÃO DA 3.2b. O fuso só é provável pela capability MCP, e ela exige um principal
 * dedicado (`mcp-principal-e2e-prod`, UMA capability) que é ato do Gabriel em produção.
 * Sem o token, a 3.2b é PULADA com o motivo escrito — nunca em silêncio.
 */
const MCP_TOKEN = process.env.MCP_TOKEN;
const MCP_URL = process.env.MCP_URL ?? 'https://worker-functions-mcp-byh3gvl5yq-tl.a.run.app/mcp/v1';

/**
 * +180 min: Buenos Aires é UTC−3 e a Argentina NÃO tem horário de verão desde 2009,
 * então o offset é CONSTANTE — não existe "coincide em parte do dia".
 * É por isso que um delta exato pode ser asserção, e não aproximação.
 */
const EXPECTED_OFFSET_MIN = 180;
const SEMANA_MS = 7 * 24 * 60 * 60 * 1000;

interface McpSlot { index: number; label: string; iso: string }

/**
 * Chama `worker.interview.slots.list` no MCP de produção.
 *
 * ⚠️ `Accept` com os DOIS tipos: o transporte é StreamableHTTP, e ele recusa a
 * requisição sem `text/event-stream` no Accept mesmo respondendo JSON
 * (`enableJsonResponse: true`). Nome canônico COM pontos — `sanitizedToolNames` só é
 * `true` no caminho OAuth, e este é o caminho de service principal.
 */
async function listarSlotsPeloMcp(jobPostingId: string): Promise<McpSlot[]> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MCP_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'worker.interview.slots.list', arguments: { jobPostingId } },
    }),
  });
  // NUNCA logar o corpo em caso de erro: ele pode ecoar o header de autorização em
  // alguns proxies. Só o status, como faz o `adminApi`.
  expect(res.ok, `MCP tools/call respondeu HTTP ${res.status}`).toBe(true);

  const body = (await res.json()) as {
    result?: { structuredContent?: { slots?: McpSlot[] }; content?: Array<{ type: string; text?: string }> };
    error?: { message?: string };
  };
  expect(body.error, `MCP devolveu erro JSON-RPC: ${body.error?.message ?? ''}`).toBeUndefined();

  // O SDK devolve `structuredContent` quando o handler tem output schema; senão o
  // payload vem serializado no primeiro bloco de texto. Aceitar as duas formas evita
  // que uma mudança de SDK vire "zero slots" — que passaria como falso negativo.
  const direto = body.result?.structuredContent?.slots;
  if (direto) return direto;
  const texto = body.result?.content?.find((c) => c.type === 'text')?.text;
  expect(texto, 'a resposta do MCP não trouxe nem structuredContent nem bloco de texto').toBeTruthy();
  return ((JSON.parse(texto!) as { slots?: McpSlot[] }).slots ?? []);
}

test.describe.serial('Spec 009 · Fase 3 — ciclo da vaga pela mão do staff', () => {
  let adminCtx: APIRequestContext | undefined;

  test.beforeAll(async () => {
    test.skip(
      !process.env.E2E_ADMIN_EMAIL || !process.env.FIREBASE_API_KEY,
      'requer E2E_ADMIN_EMAIL + FIREBASE_API_KEY (writes autenticados em prod)',
    );
    adminCtx = await newAdminApiContext();
  });

  test.afterAll(async () => {
    if (adminCtx) {
      try {
        await adminCtx.post('/api/admin/test-fixtures/cleanup', { data: {} });
      } catch {
        // best-effort
      }
    }
    await adminCtx?.dispose();
  });

  test('[@route:POST /api/admin/vacancies @depth:happy] 3.1 — a vaga nasce is_test, é editada, e a edição sobrevive à releitura', async ({ browser }) => {
    // A vaga referencia um paciente REAL (não criamos paciente aqui) — mesmo molde da
    // `qualified-interview-invite`. Nenhum dado desse paciente é lido ou comparado: só o id.
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
        worker_attributes: ATTRS_INICIAL,
        age_range_min: 25,
        age_range_max: 60,
        providers_needed: '1',
      },
    });
    expect(createRes.status(), 'POST /api/admin/vacancies cria a vaga (201)').toBe(201);
    const criada = (await createRes.json()) as VacancyBody;
    vaga.id = criada.data.id;
    expect(
      criada.data.is_test,
      'a vaga persistiu como is_test — se nascer sem a marca, o cleanup não a alcança e ela vira lixo em prod',
    ).toBe(true);

    const antes = await lerVaga(adminCtx!);
    expect(antes.worker_attributes, 'o valor inicial está gravado').toBe(ATTRS_INICIAL);

    // ── a EDIÇÃO ────────────────────────────────────────────────────────────
    // ⚠️ `PUT /vacancies/:id` NÃO aceita campos `meet_*` (não estão na whitelist) —
    // medido; é por isso que o slot recorrente tem rota própria, exercitada na 3.2a.
    const editRes = await adminCtx!.put(`/api/admin/vacancies/${vaga.id}`, {
      data: { worker_attributes: ATTRS_EDITADO },
    });
    expect(editRes.status(), 'PUT /api/admin/vacancies/:id responde 200').toBe(200);

    const depois = await lerVaga(adminCtx!);
    expect(depois.worker_attributes, 'a edição foi relida do banco').toBe(ATTRS_EDITADO);
    // CONTROLE POSITIVO: sem isto, um endpoint que ignora escrita e um que grava certo
    // passariam igual — bastaria o valor "estar lá".
    expect(
      depois.worker_attributes,
      'e é DIFERENTE do valor anterior — a asserção mede mudança, não presença',
    ).not.toBe(antes.worker_attributes);

    // ── e a tela do staff mostra o valor novo ───────────────────────────────
    const { page, fechar } = await abrirComAdmin(browser, `/admin/vacancies/${vaga.id}`);
    try {
      await expect(
        page.getByText(ATTRS_EDITADO),
        'a ficha da vaga renderiza a edição — não basta o banco concordar consigo mesmo',
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await fechar();
    }
  });

  test('[@route:PUT /api/admin/vacancies/:id/meet-links @depth:happy] 3.2a — slot recorrente: grava, relê, e o Merge Patch funciona nos DOIS sentidos (⚠️ NÃO prova o fuso)', async () => {
    // ── grava ────────────────────────────────────────────────────────────────
    // `meet_links` é OBRIGATÓRIO no schema mesmo quando só o `recurring` muda (medido).
    const gravaRes = await adminCtx!.put(`/api/admin/vacancies/${vaga.id}/meet-links`, {
      data: { meet_links: [null, null, null], recurring: RECORRENTE },
    });
    expect(gravaRes.status(), 'PUT /meet-links grava o slot recorrente (200)').toBe(200);

    // A resposta do PUT já traz o slot — mas a PROVA é a releitura pelo GET, que é o
    // que a tela do staff consome.
    const comSlot = await lerVaga(adminCtx!);
    expect(comSlot.meet_recurring_weekday, 'o dia da semana persistiu').toBe(RECORRENTE.weekday);
    expect(
      (comSlot.meet_recurring_time ?? '').slice(0, 5),
      'a hora persistiu (o TIME do Postgres volta como HH:MM:SS — por isso o slice)',
    ).toBe(RECORRENTE.time);
    expect(comSlot.meet_recurring_link, 'a sala persistiu').toContain('meet.google.com');

    // ── CONTROLE POSITIVO: a chave AUSENTE não mexe (Merge Patch) ────────────
    const semRecurring = await adminCtx!.put(`/api/admin/vacancies/${vaga.id}/meet-links`, {
      data: { meet_links: [null, null, null] },
    });
    expect(semRecurring.status(), 'PUT sem a chave `recurring` responde 200').toBe(200);
    const intacto = await lerVaga(adminCtx!);
    expect(
      intacto.meet_recurring_weekday,
      'CHAVE AUSENTE NÃO TOCA O SLOT — mesmo contrato do drawer clínico (RFC 7396)',
    ).toBe(RECORRENTE.weekday);

    // ── CONTROLE POSITIVO 2: `null` explícito LIMPA ─────────────────────────
    // Sem esta metade, "o slot sobreviveu" passaria mesmo se o endpoint ignorasse
    // toda escrita de `recurring` — que consertaria a preservação quebrando a edição.
    const limpaRes = await adminCtx!.put(`/api/admin/vacancies/${vaga.id}/meet-links`, {
      data: { meet_links: [null, null, null], recurring: null },
    });
    expect(limpaRes.status(), 'PUT com `recurring: null` responde 200').toBe(200);
    const limpo = await lerVaga(adminCtx!);
    // `?? null` de propósito: a chave pode voltar `null` OU ausente, e as duas leituras
    // significam "limpo". Sem o `??`, `undefined` passaria por um `.not.toBeNull()` —
    // foi exatamente esse o defeito da 1ª versão deste teste.
    expect(
      limpo.meet_recurring_weekday ?? null,
      'NULL EXPLÍCITO LIMPA — o endpoint não está apenas ignorando escritas de `recurring`',
    ).toBeNull();
    expect(limpo.meet_recurring_link ?? null, 'e a sala foi junto').toBeNull();
  });

  test('[@route:PUT /api/admin/vacancies/:id/meet-links @depth:happy] 3.2b — o slot recorrente resolve as ocorrências NO FUSO DA VAGA, nunca em UTC (D213)', async () => {
    test.skip(
      !MCP_TOKEN,
      'PORTÃO da 3.2b: falta o principal `mcp-principal-e2e-prod` (uma capability: ' +
        'worker.interview.slots.list) e o secret `e2e-mcp-token` no runner. É ato do Gabriel ' +
        'em produção — ver "Fase 3 · 3.2b" em specs/009-e2e-prod-jornada-staff/tasks.md.',
    );

    // A 3.2a limpou o recorrente no fim; regrava para esta prova.
    const grava = await adminCtx!.put(`/api/admin/vacancies/${vaga.id}/meet-links`, {
      data: { meet_links: [null, null, null], recurring: RECORRENTE },
    });
    expect(grava.status(), 'PUT /meet-links regrava o slot recorrente (200)').toBe(200);

    const slots = await listarSlotsPeloMcp(vaga.id!);

    // ── identificação POR CONSTRUÇÃO, não por link ──────────────────────────
    // A capability declara "Meet links are never returned", então não dá para achar a
    // ocorrência do recorrente pelo link que gravamos. Mas a vaga da 3.1 nasce SEM
    // `meet_link_N`, logo sem `meet_datetime_N`: a oferta é EXATAMENTE as
    // RECURRING_OCCURRENCES = 2 ocorrências do recorrente. Daí `=== 2`, e não `>= 2` —
    // um `>=` deixaria um slot fixo intruso passar despercebido e mudaria o que se prova.
    expect(
      slots.length,
      'vaga sem slot fixo ⇒ a oferta é exatamente as 2 ocorrências do recorrente',
    ).toBe(2);

    // ── as duas ocorrências são semanais ────────────────────────────────────
    const t0 = Date.parse(slots[0]!.iso);
    const t1 = Date.parse(slots[1]!.iso);
    expect(Number.isNaN(t0) || Number.isNaN(t1), 'os dois `iso` são datas válidas').toBe(false);
    expect(t1 - t0, 'as ocorrências do recorrente são separadas por exatamente 7×24 h').toBe(SEMANA_MS);

    // ── A PROVA DO FUSO ─────────────────────────────────────────────────────
    // O staff digitou 08:30 LOCAL. Se `zonedLocalToInstant` tratasse isso como UTC, o
    // instante viria 3 h errado — e o LABEL continuaria dizendo "08:30", porque o mesmo
    // erro na formatação cancela o erro na interpretação. Só o `iso` denuncia o par.
    //
    // 🔒 `getUTC*` de propósito: o Cloud Run Job roda em UTC e o laptop em −03. Um
    // `getHours()` aqui mediria o fuso do RUNNER e daria resultados opostos nos dois.
    const [hh, mm] = RECORRENTE.time.split(':').map(Number);
    const minutosLocais = hh! * 60 + mm!;
    for (const slot of slots) {
      const d = new Date(slot.iso);
      const minutosUtc = d.getUTCHours() * 60 + d.getUTCMinutes();
      expect(
        minutosUtc - minutosLocais,
        `FUSO DA VAGA (D213): ${RECORRENTE.time} em Buenos Aires é ${EXPECTED_OFFSET_MIN} min ` +
          `depois em UTC. Delta 0 significaria que a hora local foi interpretada COMO UTC — ` +
          `e o convite ofereceria um horário 3 h errado, com o rótulo parecendo certo`,
      ).toBe(EXPECTED_OFFSET_MIN);
      // O rótulo continua sendo verificado, mas como COMPANHEIRO do instante, nunca sozinho.
      expect(slot.label, 'o rótulo legível carrega a hora local que o staff digitou').toContain(
        RECORRENTE.time,
      );
    }
  });

  test('[@route:/admin/vacancies @depth:happy] 3.3 — o combobox das listas longas filtra por digitação, e a escolha vira FILTRO na requisição', async ({ browser }) => {
    const { page, fechar } = await abrirComAdmin(browser, '/admin/vacancies');
    try {
      const botao = page.getByTestId('vacancy-filter-province');
      await expect(botao, 'a Provincia virou combobox (REQ-06), não mais <select> nativo').toBeVisible({
        timeout: 30_000,
      });

      // ⚠️ ESCOPO — lição de um vermelho real (30/08): `page.getByRole('option')` conta
      // TAMBÉM os `<option>` dos `<select>` NATIVOS da página, porque `<option>` tem
      // `role="option"` implícito. A 1ª versão deste teste mediu 43 antes e 54 depois de
      // digitar e acusou "o filtro AUMENTOU a lista" — o defeito era do instrumento.
      // O painel do SearchableSelect é irmão do botão dentro de um `div.relative`.
      const combo = botao.locator('xpath=..');
      const opcoes = combo.getByRole('listbox').getByRole('option');

      await botao.click();
      await expect(combo.getByRole('listbox'), 'o painel do combobox abriu').toBeVisible();

      // O catálogo de províncias vem de `GET /vacancies/filter-options`, que é ASSÍNCRONO.
      // Clicar antes de ele resolver abre o painel só com o placeholder — e foi assim que
      // a 2ª versão deste teste falhou (`Received: 1`). Espera-se pela CONDIÇÃO, e se o
      // catálogo nunca chegar o teste falha dizendo isso, em vez de "filtrar" sobre nada.
      await expect
        .poll(async () => opcoes.count(), {
          timeout: 15_000,
          message: 'o catálogo de províncias nunca chegou ao combobox (só o placeholder na lista)',
        })
        .toBeGreaterThan(1);
      const totalAntes = await opcoes.count();

      // ── DIGITAR FILTRA ──────────────────────────────────────────────────────
      // "Bue" é prefixo de Buenos Aires, a província da operação. O que se prova é a
      // RELAÇÃO (menos opções depois de digitar), não um número absoluto — o catálogo
      // vem do banco e muda.
      await combo.locator('input[type="text"]').fill('Bue');
      await expect
        .poll(async () => opcoes.count(), {
          timeout: 10_000,
          message: 'digitar deveria REDUZIR a lista — é a razão de existir do combobox (Javier, 26/08)',
        })
        .toBeLessThan(totalAntes);

      // ── A ESCOLHA VIRA FILTRO NA REQUISIÇÃO ─────────────────────────────────
      // Sem isto, o combobox poderia ser decorativo: bonito na tela e sem efeito na
      // consulta. A prova é o `state=` saindo no request.
      // A 1ª opção da lista é SEMPRE o placeholder "todas" (value=''), que justamente
      // NÃO filtra — escolher ela provaria o contrário do que queremos.
      const escolhida = opcoes.filter({ hasText: /Bue/i }).first();
      await expect(escolhida, 'sobrou uma província de verdade para escolher').toBeVisible();
      const rotulo = (await escolhida.innerText()).trim();

      const espera = page.waitForRequest(
        (r) => r.url().includes('/api/admin/vacancies') && r.url().includes('state='),
      );
      await escolhida.click();
      const req = await espera;
      expect(
        decodeURIComponent(new URL(req.url()).searchParams.get('state') ?? ''),
        'a província escolhida na tela é a que vai como filtro para a API',
      ).toBe(rotulo);
    } finally {
      await fechar();
    }
  });

  test('3.4 — propagação para o Portal Jobs', async () => {
    // AUTORIZADA pelo Gabriel em 30/08 ("publicar vaga sintética, porém PRECISA SER
    // DELETADO DEPOIS DO TESTE"), e mesmo assim NÃO escrita ainda — por um conflito de
    // orçamento que a autorização não tinha como prever, e que é decisão dele:
    //
    //   · o Cloud Run Job do monitor tem `--task-timeout=900s` (15 min, medido em
    //     `deploy-monitor.sh:131` e confirmado no job vivo por `gcloud`);
    //   · a suíte inteira leva ~5 min hoje;
    //   · a 3.4 sozinha custa ~10 min: o WP-Cron do `filtro-avancado-vacantes` puxa
    //     `GET /api/public/v1/jobs` a cada 5 min, o Breeze leva mais 161 s (D219.1), e a
    //     PROVA DA DELEÇÃO exige mais um ciclo de cron.
    //
    // Somando, o monitor diário passaria a estourar o próprio timeout — e um monitor
    // vermelho por orçamento é pior que uma lacuna nomeada: ensina a ignorar o alerta.
    //
    // Os três caminhos estão em `tasks.md` (subir o timeout do Job · tirar a 3.4 do
    // diário e rodá-la sob demanda · provar só o feed `/api/public/v1/jobs`, que é
    // imediato mas não prova o portal). Escolha do Gabriel.
    test.fixme(
      true,
      '3.4 aguarda decisão: a 3.4 (~10 min) não cabe no --task-timeout=900s do Job diário. ' +
        'Ver "Fase 3 · 3.4" em specs/009-e2e-prod-jornada-staff/tasks.md.',
    );
  });

  test('3.5 — a limpeza é PROVADA por releitura', async () => {
    const cleanupRes = await adminCtx!.post('/api/admin/test-fixtures/cleanup', { data: {} });
    expect(cleanupRes.status(), 'cleanup is_test responde 200').toBe(200);
    expect(
      (await adminCtx!.get(`/api/admin/vacancies/${vaga.id}`)).status(),
      'PROVA — depois do cleanup a vaga is_test responde 404',
    ).toBe(404);
    vaga.id = undefined;
  });
});
