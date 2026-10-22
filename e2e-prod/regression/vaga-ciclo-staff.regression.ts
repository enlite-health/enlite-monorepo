/**
 * vaga-ciclo-staff.regression.ts — o ciclo da VAGA pela mão do staff, contra PRODUÇÃO.
 * (Spec 009, Fase 3 — itens 3.1 e 3.3.)
 *
 * ── POR QUE ESTA FASE NÃO ESTÁ ATRÁS DO PORTÃO DO #261 ───────────────────────
 * O plano original marcou "Fases 1 e 3 tocam mensageria". Para a Fase 1 isso se
 * confirmou por mecanismo (todo movimento de tarjeta emite evento que pode enfileirar).
 * Para a Fase 3, NÃO: o que ligava a 3.2 à mensageria era provar o fuso PELO CONVITE —
 * e o parecer do CTO (30/08) tirou o convite do caminho, porque `delivery-status` não
 * expõe `variables` e o log do handler grava só `slots: [source]`; provar por ali
 * exigiria mudar produto, o que a `spec.md` veta.
 *
 * O que sobra aqui — criar/editar vaga, filtrar lista — não tem passo
 * outbound. E não é opinião minha: `talentum-prescreening-audio.regression.ts` JÁ cria,
 * publica e apaga vaga `is_test` contra prod todo dia às 3h, desde julho. O precedente
 * é a evidência.
 *
 * ── O QUE ESTE SPEC PROVA ────────────────────────────────────────────────────
 *  3.1  a vaga nasce `is_test`, é editada e a edição sobrevive à releitura — pela API
 *       E na tela do staff. Com controle positivo: o valor DEPOIS é diferente do ANTES.
 *  (A 3.2a — o slot recorrente da vaga — saiu na spec 068: a vaga não tem mais link/horário de reunião.
 *   A 3.2b — a prova do fuso pela capability MCP de horários da Luz — saiu na spec 052.)
 *  3.3  o combobox das listas longas filtra por digitação e a escolha vira FILTRO na
 *       requisição — não só um rótulo bonito na tela.
 *
 * ── ⚠️ O QUE ESTE SPEC EXPLICITAMENTE NÃO PROVA ──────────────────────────────
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

const vaga: { id?: string } = {};

interface VacancyBody {
  data: {
    id: string;
    is_test?: boolean;
    worker_attributes?: string | null;
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

  test('[@route:POST /api/admin/vacancies @depth:happy] 3.1 — a vaga nasce is_test, é editada, a edição sobrevive à releitura, e a ficha publicada mostra o valor', async ({ browser }) => {
    // A vaga referencia um paciente REAL (não criamos paciente aqui). Nenhum dado desse paciente é lido ou comparado: só o id.
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

    // ── e a tela do staff mostra o valor ─────────────────────────────────────
    // Desde 26/09 a vaga nasce RASCUNHO: o detalhe redireciona para /borrador, que só marca o campo como
    // preenchido (DraftVacancyTodoCard) e NÃO mostra o texto; e depois de publicada o PUT recusa
    // `worker_attributes` (403, vacancyCrudHelpers.ts:197-205) — a edição só existe em rascunho. Logo a
    // edição (acima) continua provada por API, e a TELA é provada sobre uma segunda vaga is_test já
    // publicável (`is_draft:false` só vale com is_test, vacancyCrudHelpers.ts:383; não passa pelo Talentum)
    // criada JÁ com o valor, que é o que a ficha publicada renderiza.
    const publicadaRes = await adminCtx!.post('/api/admin/vacancies', {
      data: {
        case_number: patient.caseNumber ?? 0,
        patient_id: patient.id,
        is_test: true,
        is_draft: false,
        required_professions: ['CAREGIVER'],
        worker_attributes: ATTRS_EDITADO,
        age_range_min: 25,
        age_range_max: 60,
        providers_needed: '1',
      },
    });
    expect(publicadaRes.status(), 'POST da vaga is_test publicável responde 201').toBe(201);
    const publicada = (await publicadaRes.json()) as VacancyBody;
    expect(publicada.data.is_test, 'a segunda vaga também é is_test — senão o cleanup não a alcança').toBe(true);

    const { page, fechar } = await abrirComAdmin(browser, `/admin/vacancies/${publicada.data.id}`);
    try {
      await expect(
        page.getByText(ATTRS_EDITADO),
        'a ficha da vaga publicada renderiza o valor gravado — não basta o banco concordar consigo mesmo',
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await fechar();
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
