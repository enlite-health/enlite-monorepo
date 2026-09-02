/**
 * plantillas-vs-desenho.e2e.ts — o comparador.
 *
 * 🔒 POR QUE ESTE ARQUIVO EXISTE. A spec 010 foi entregue em produção sem que
 * NADA na cadeia comparasse a tela construída com o desenho de 31/08. O
 * "termina quando" era comportamental — `data-testid`, chave de i18n, contagem —
 * e 935 testes unitários não olham para layout. O resultado foi previsível: a
 * modal virou uma caixa inline, o compositor virou um CRUD e a tela de detalhe
 * virou um drawer, e nenhum vermelho apareceu.
 *
 * O QUE ELE MEDE, E O QUE NÃO MEDE.
 *
 * Ele NÃO julga pixel. Não pode: os baselines versionados são `*-darwin.png`,
 * tirados em macOS, e num runner linux o Playwright reprovaria por AUSÊNCIA de
 * baseline — vermelho que não é regressão. Está escrito em
 * `_frontend-integration.yml`, e não vou fingir que resolvi.
 *
 * Ele mede ESTRUTURA, que é independente de plataforma e é o que de fato
 * regrediu quando a spec 010 foi entregue: colunas que somem, texto que
 * transborda a célula e se sobrepõe ao vizinho, uma "modal" que na verdade é
 * uma caixa no fluxo da página, um "detalhe" que não tem endereço. Nenhum dos
 * 4679 testes unitários enxerga nada disso.
 *
 * A comparação de pixel continua sendo feita à mão, no macOS, contra os PNGs
 * do desenho — e o comparador salva as fotos justamente para isso.
 *
 * COMO RODAR (a porta NÃO é 5173: outra worktree costuma estar nela, e o
 * Playwright conectaria no código da branch vizinha sem avisar):
 *   npx vite --port 5199 --strictPort &
 *   E2E_BASE_URL=http://localhost:5199 npx playwright test \
 *     --config=playwright.mocked.config.ts e2e/plantillas-vs-desenho.e2e.ts
 *
 * Precisa do emulador do Firebase em :9099 e do `enlite-frontend/.env`.
 */
import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';
const SAIDA = process.env.COMPARADOR_DIR ?? 'e2e/__comparador__';

/** O conteúdo da página, sem a barra lateral — é o que a maquete desenha. */
const CONTEUDO = '.max-w-\\[1600px\\]';

/*
 * 🔒 TODA CAPTURA LEVA `animations: 'disabled'`, e isso não é preferência.
 *
 * O layout admin envolve a página numa `.page-enter`, que anima a opacidade de
 * 0 a 1 na montagem. Sem congelar, o Playwright fotografa o instante em que a
 * animação está — medido: `opacity: 0.122` na tela de detalhe. A foto sai
 * inteira lavada, como se as cores do produto estivessem erradas, e cada
 * execução produz uma foto diferente da anterior. Passei um tempo procurando um
 * defeito de cor que não existia: o botão tem `rgb(24, 1, 73)` o tempo todo.
 *
 * `animations: 'disabled'` leva a animação ao estado FINAL antes de disparar —
 * é o estado que a pessoa vê, e é o único determinístico.
 */

const linha = (over: Record<string, unknown>) => ({
  slug: 'x', name: 'x', bodyTwilio: null, category: 'UTILITY', isActive: true,
  contentSid: 'HXaaa', metaStatus: null, metaReason: null, metaDetail: null,
  metaCheckedAt: null, eligible: true, ineligibleReason: null,
  placeholders: [], usedInStages: [],
  ...over,
  baseName: (over.baseName as string | undefined) ?? (over.slug as string | undefined) ?? 'x',
  // 🔒 `name` ESPELHA O SLUG, como nas 27 linhas de produção (o sync grava o
  // `friendly_name` da Twilio nos dois). O padrão 'x' que estava aqui fez o
  // drawer aparecer intitulado «x» na 1ª captura — a foto de um defeito do
  // fixture, que eu quase reportei como defeito da tela.
  name: (over.name as string | undefined) ?? (over.slug as string | undefined) ?? 'x',
  language: 'language' in over ? over.language : 'es-AR',
  isDraft: over.isDraft === true,
});

/**
 * O payload espelha as SEIS linhas da maquete da Tela 1, na mesma ordem, para
 * que a comparação seja sobre a tela e não sobre dados diferentes.
 */
const CATALOGO = {
  success: true,
  data: {
    templates: [
      linha({
        slug: 'ar_bienvenida_contratacion', baseName: 'bienvenida_contratacion',
        bodyTwilio: '¡Hola María González! Te damos la bienvenida al equipo de EnLite Health.',
        metaStatus: 'APPROVED', metaCheckedAt: '2026-08-31T14:32:00Z',
        placeholders: ['worker_name'], usedInStages: ['CONFIRMED'],
      }),
      linha({
        slug: 'br_bienvenida_contratacion', baseName: 'bienvenida_contratacion', language: 'pt-BR',
        bodyTwilio: 'Olá María González! Damos as boas-vindas ao time da EnLite Health.',
        metaStatus: 'APPROVED', metaCheckedAt: '2026-08-31T14:32:00Z',
        placeholders: ['worker_name'], usedInStages: ['CONFIRMED'],
      }),
      linha({
        slug: 'ar_entrevista_confirmada', baseName: 'entrevista_confirmada',
        bodyTwilio: '¡Hola María González! Tu entrevista para el CASO 1042 quedó confirmada.',
        metaStatus: 'APPROVED', metaCheckedAt: '2026-08-31T14:32:00Z',
        placeholders: ['worker_name', 'case_number'], usedInStages: ['SELECTED'],
      }),
      linha({
        slug: 'br_entrevista_confirmada', baseName: 'entrevista_confirmada', language: 'pt-BR',
        bodyTwilio: 'Olá María González! Sua entrevista para o CASO 1042 está confirmada.',
        metaStatus: 'PENDING', metaCheckedAt: '2026-08-31T14:32:00Z',
        placeholders: ['worker_name', 'case_number'], usedInStages: ['SELECTED'],
      }),
      linha({
        slug: 'ar_postulacion_recibida', baseName: 'postulacion_recibida',
        bodyTwilio: '¡Hola! Gracias por postularte. Estamos revisando tu perfil.',
        metaStatus: 'APPROVED', metaCheckedAt: '2026-08-31T14:32:00Z',
        usedInStages: ['INVITED'],
      }),
      linha({
        slug: 'ar_vacancy_match_complete', baseName: 'vacante_cercana',
        bodyTwilio: '¡Hola {{1}}! Se liberó una vacante cerca tuyo en {{2}}.',
        metaStatus: 'APPROVED', metaCheckedAt: '2026-08-31T14:32:00Z',
        eligible: false, ineligibleReason: 'PLACEHOLDERS', placeholders: ['1', '2'],
      }),
      // A 6ª linha da maquete: rascunho sem texto, que só existe aqui dentro.
      linha({
        slug: 'agradecimiento_no_seleccion', baseName: 'agradecimiento_no_seleccion',
        bodyTwilio: null, contentSid: null, metaStatus: null, metaCheckedAt: null,
        isDraft: true, category: 'UTILITY',
      }),
      linha({
        slug: 'ar_signup_pending_reminder', baseName: 'registro_pendiente',
        bodyTwilio: 'Recordá completar tu registro para acceder a las vacantes.',
        metaStatus: 'REJECTED', metaReason: 'INVALID_FORMAT',
        metaDetail: 'Tu plantilla tiene parámetros pegados uno al otro sin texto ni puntuación entre ellos.',
        metaCheckedAt: '2026-08-31T14:32:00Z', eligible: false, ineligibleReason: 'DENY_LIST',
      }),
    ],
  },
};

const RASCUNHO = {
  id: 'id-1', slug: 'ar_bienvenida_contratacion', baseName: 'bienvenida_contratacion', name: 'Bienvenida contratación',
  body: '¡Hola {{worker_name}}! Te damos la bienvenida al equipo de EnLite Health.\n\nYa podés ver tus casos asignados y cargar tus reportes diarios desde app.enlite.health.',
  category: 'UTILITY', language: 'es-AR', version: 1,
  createdBy: 'uid-a', updatedBy: 'uid-a',
  createdAt: '2026-08-31T12:00:00Z', updatedAt: '2026-08-31T12:00:00Z',
  contentSid: null, submittedAt: null, submittedBy: null, submissionError: null,
  metaStatus: null, metaReason: null, metaDetail: null, metaCheckedAt: null,
  status: 'draft',
};

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.comparador.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';
  const signUp = await fetch(`${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const { localId: uid } = (await signUp.json()) as { localId: string };
  expect(uid).toBeTruthy();

  await page.route('**/identitytoolkit.googleapis.com/**', async (route) => {
    const parsed = new URL(route.request().url());
    const url = `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com${parsed.pathname}?${parsed.searchParams.toString().replace(/key=[^&]+/, `key=${FIREBASE_API_KEY}`)}`;
    const res = await fetch(url, { method: route.request().method(), headers: { 'Content-Type': 'application/json' }, body: route.request().postData() ?? undefined });
    await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
  });
  await page.route('**/securetoken.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'mock', expires_in: '3600', token_type: 'Bearer', refresh_token: 'mock', id_token: 'mock', user_id: uid, project_id: 'enlite-prd' }) }));
  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: uid, email, role: 'admin', displayName: 'Gabriel', isActive: true } }) }));

  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 45_000 });
}

/*
 * 🔒 A JANELA É ALTA (1500) DE PROPÓSITO. O `AdminLayout` é
 * `h-screen overflow-hidden` com o `<main>` rolando por dentro: a pessoa
 * alcança tudo, mas o `element.screenshot()` do Playwright, preso num
 * ancestral com `overflow: hidden`, capturava só o que cabia em 900px e
 * cortava o resto SEM ERRO — a foto do compositor saiu sem os botões de ação,
 * sem o aviso de perímetro e sem a lista de rascunhos, e nada avisou.
 *
 * Uma foto que mostra menos do que a tela é pior que foto nenhuma: ela parece
 * prova. Com a janela alta o conteúdo cabe inteiro, e `cabeNaJanela` abaixo
 * transforma "não coube" em teste vermelho.
 */
/*
 * 🔒 A LARGURA FOI ESCOLHIDA PARA IGUALAR O CONTEÚDO, não por gosto — e isso
 * corrige um defeito do próprio comparador.
 *
 * A maquete desenha um quadro de 1180px. O painel, numa janela de 1200, dá
 * ~952px de conteúdo: a barra lateral come 200 e os paddings comem o resto.
 * O composite lado a lado esticava as duas imagens para a mesma largura, então
 * o app aparecia ~24% MAIOR do que é. Metade da diferença que se via na foto
 * era escala, não implementação.
 *
 * 1524 = 1180 de conteúdo + 200 de barra + 48 do container + 96 do PageContainer.
 * Com isso os dois lados saem em 1180 CSS px e o composite é 1:1.
 *
 * `deviceScaleFactor: 1` como a skill `pixel-loop` manda — o desenho também é
 * renderizado em 1×, senão a comparação volta a ser entre escalas diferentes.
 */
test.use({ viewport: { width: 1524, height: 1600 }, deviceScaleFactor: 1 });

/**
 * O conteúdo cabe na janela da captura?
 *
 * 🔒 Contagem zero é falha, nunca sucesso — e foto truncada é a versão visual
 * disso. Sem esta guarda, uma tela que cresça um dia volta a ser fotografada
 * pela metade, e a comparação passa a aprovar o que não viu.
 */
async function cabeNaJanela(page: Page): Promise<{ conteudo: number; janela: number }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return { conteudo: el ? Math.ceil(el.getBoundingClientRect().height) : -1, janela: window.innerHeight };
  }, CONTEUDO);
}

/**
 * A tabela cabe no contêiner, sem rolagem horizontal.
 *
 * 🔒 A PRIMEIRA VERSÃO DESTA FUNÇÃO NÃO MEDIA NADA, e só a sabotagem mostrou.
 * Ela comparava a caixa de cada `[data-testid]` com a caixa da TABELA — e a
 * tabela cresce junto com o conteúdo, então nenhum filho jamais "passa" dela.
 * Removi o `table-fixed` de propósito, a coluna "Se usa en" saiu da tela, e o
 * portão continuou VERDE. Régua que não detecta o instrumento morto.
 *
 * O que transborda de verdade é a tabela dentro do wrapper `overflow-x-auto`
 * que o atom `Table` cria. `scrollWidth > clientWidth` nesse wrapper é o fato:
 * significa que existe coluna fora do campo de visão, e ninguém rola uma
 * tabela que parece completa.
 */
async function tabelaCabeNoContainer(page: Page): Promise<{ scroll: number; visivel: number }> {
  return page.evaluate(() => {
    const tabela = document.querySelector('[data-testid="tc-table"]');
    // O wrapper é o pai que o atom `Table` cria com `overflow-x-auto`.
    const wrapper = tabela?.parentElement;
    if (!wrapper) return { scroll: -1, visivel: -1 };
    return { scroll: wrapper.scrollWidth, visivel: wrapper.clientWidth };
  });
}

test.describe('captura para comparar com o desenho de 31/08', () => {
  test('tela 1 — o registro', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-catalog', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOGO) }));
    await page.goto('/admin/plantillas');
    await expect(page.getByTestId('tc-table')).toBeVisible({ timeout: 30_000 });

    /*
     * 🔒 AS CINCO COLUNAS DO DESENHO. "Se usa en" é a que protege quem for tirar
     * uma mensagem do ar: sem ela, arquivar a mensagem pendurada numa etapa é um
     * clique silencioso que desliga um aviso em produção. Ela SUMIU uma vez, por
     * transbordo, e nenhum teste unitário notou.
     */
    const cabecalhos = await page.locator('thead th').allTextContents();
    expect(cabecalhos).toHaveLength(5);
    expect(cabecalhos.join(' | ')).toContain('Se usa en');

    const { scroll, visivel } = await tabelaCabeNoContainer(page);
    expect(visivel, 'wrapper da tabela não encontrado').toBeGreaterThan(0);
    // 1px de folga para arredondamento de subpixel.
    expect(scroll, `a tabela mede ${scroll}px num contêiner de ${visivel}px — há coluna fora da tela`)
      .toBeLessThanOrEqual(visivel + 1);

    /*
     * 🔒 OS SLUGS DAS DUAS COLUNAS NÃO PODEM SE SOBREPOR. Medido em 01/09: sem
     * `break-all` eles eram impressos um por cima do outro e nenhuma asserção
     * de texto reclamava — os dois estavam lá, ilegíveis.
     */
    const es = await page.getByTestId('tc-slug-ar_bienvenida_contratacion').boundingBox();
    const pt = await page.getByTestId('tc-slug-br_bienvenida_contratacion').boundingBox();
    expect(es && pt && es.x + es.width).toBeLessThanOrEqual((pt?.x ?? 0) + 1);

    const cabe = await cabeNaJanela(page);
    expect(cabe.conteudo, `a tela mede ${cabe.conteudo}px numa janela de ${cabe.janela}px — a foto sairia cortada`)
      .toBeLessThanOrEqual(cabe.janela);
    await page.locator(CONTEUDO).screenshot({ path: `${SAIDA}/app/1-lista.png`, animations: 'disabled' });
  });

  test('tela 2 — o compositor', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-drafts/validar', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {
        slug: 'ar_bienvenida_contratacion',
        bloqueios: [],
        // AR-01: o texto não oferece caminho de baixa. É AVISO — grava e envia
        // mesmo assim — e é justamente o item âmbar que a maquete mostra.
        avisos: [{ campo: 'body', regra: 'sem_clausula_de_baja', gravidade: 'aviso' }],
      } }) }));
    await page.route('**/api/admin/template-drafts', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [RASCUNHO] } }) }));
    await page.goto('/admin/plantillas/registrar');
    await expect(page.getByTestId('td-form')).toBeVisible({ timeout: 30_000 });
    // Um nome só — o par ar_/br_ nasce dele. E o texto entra pela aba ativa.
    await page.getByTestId('td-input-slug').fill('bienvenida_contratacion');
    await page.getByTestId('td-input-body').fill(
      '¡Hola {{worker_name}}! Te damos la bienvenida al equipo de EnLite Health.\n\n'
      + 'Ya podés ver tus casos asignados y cargar tus reportes diarios desde app.enlite.health.\n\n'
      + 'Cualquier duda, respondé por acá y te ayudamos.');
    /*
     * 🔒 A VARIÁVEL TEM DE APARECER COMO CHIP, com o rótulo amigável. É o que a
     * maquete mostra e o que ela justifica em palavras: ninguém precisa saber
     * que a variável se chama `worker_name`. O `fill` do Playwright entra como
     * texto puro, e é a conversão ao sair do campo que faz o chip nascer — por
     * isso o `blur` aqui não é enfeite do teste, é o gesto que se está medindo.
     */
    await page.getByTestId('td-input-body').blur();
    await expect(page.getByTestId('td-chip-worker_name')).toBeVisible();
    await expect(page.getByTestId('td-input-body')).not.toContainText('{{');
    // A lista de verificação é do servidor e tem espera: sem aguardá-la, a foto
    // sairia com a lista do estado anterior — a foto de um instante que não é o
    // que a tela mostra a quem usa.
    await page.waitForTimeout(900);
    await expect(page.getByTestId('td-checklist')).toBeVisible();

    /*
     * 🔒 AS PEÇAS QUE FAZEM DISTO UM COMPOSITOR, e não o formulário de CRUD que
     * estava no lugar: o par ar_/br_ nascendo de um nome só, as abas por idioma,
     * a variável entrando por BOTÃO (digitá-la livremente permite escrever uma
     * mensagem que a Meta aprova e que nunca sai), e o balão do WhatsApp.
     */
    // Como no desenho: o selo é o prefixo e o texto é a base. O slug inteiro
    // continua afirmado — em `data-slug`, que é o que vai para a Meta.
    await expect(page.getByTestId('td-slug-es-AR')).toHaveText('bienvenida_contratacion');
    await expect(page.getByTestId('td-slug-pt-BR')).toHaveText('bienvenida_contratacion');
    await expect(page.getByTestId('td-par-slug-es-AR')).toHaveAttribute('data-slug', 'ar_bienvenida_contratacion');
    await expect(page.getByTestId('td-par-slug-pt-BR')).toHaveAttribute('data-slug', 'br_bienvenida_contratacion');
    await expect(page.getByTestId('td-aba-pt-BR')).toBeVisible();
    await expect(page.getByTestId('td-inserir-worker_name')).toBeVisible();
    await expect(page.getByTestId('td-preview-texto')).toContainText('María González');
    // A categoria da Meta NÃO é pedida à pessoa: ela escolhe o tipo.
    await expect(page.getByTestId('td-tipo-aviso')).toBeVisible();
    expect(await page.locator('select').count()).toBe(0);
    const cabe = await cabeNaJanela(page);
    expect(cabe.conteudo, `a tela mede ${cabe.conteudo}px numa janela de ${cabe.janela}px — a foto sairia cortada`)
      .toBeLessThanOrEqual(cabe.janela);
    await page.locator(CONTEUDO).screenshot({ path: `${SAIDA}/app/2-compositor.png`, animations: 'disabled' });
  });

  test('tela 3 — a modal do ponto sem volta', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-drafts', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [RASCUNHO] } }) }));
    // `?draft=` porque a lista "Borradores guardados" saiu do pé desta tela —
    // ela não está na maquete, e as quatro ações do rascunho foram para a
    // Tela 4. A porta para editar um rascunho passou a ser o endereço.
    await page.goto(`/admin/plantillas/registrar?draft=${RASCUNHO.id}`);
    await expect(page.getByTestId('td-form')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('td-revisar-enviar').click();
    await expect(page.getByTestId('td-confirmar')).toBeVisible({ timeout: 30_000 });

    /*
     * 🔒 É MODAL DE VERDADE, não uma caixa no fluxo. A versão anterior era um
     * `<div>` inline — e a prova de que o formato estava errado era o próprio
     * código: ela precisava de `scrollIntoView` para ser vista, porque nascia
     * fora do campo de visão de quem tinha acabado de clicar.
     */
    const posicao = await page.getByTestId('td-confirmar')
      .evaluate((el) => getComputedStyle(el).position);
    expect(posicao).toBe('fixed');
    await expect(page.getByTestId('td-confirmar')).toHaveAttribute('aria-modal', 'true');

    /*
     * 🔒 E O ATO IRREVERSÍVEL ESTÁ A DOIS GESTOS, não a um. Sem o checkbox, o
     * "Enviar" da lista e o "Enviar" da confirmação eram o mesmo gesto, duas
     * vezes, sem nada entre eles.
     */
    await expect(page.getByTestId('td-confirmar-sim')).toBeDisabled();
    await expect(page.getByTestId('td-confirmar-recap')).toContainText('ar_bienvenida_contratacion');

    await page.getByTestId('td-confirmar').screenshot({ path: `${SAIDA}/app/3-modal.png`, animations: 'disabled' });
  });

  test('tela 4 — o detalhe', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-catalog', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOGO) }));
    // O rascunho dá os dois primeiros marcos da linha do tempo — sem ele a tela
    // mostra só o veredito, que é o caso de 26 das 28 linhas de produção.
    await page.route('**/api/admin/template-drafts', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [{
        ...RASCUNHO, slug: 'ar_signup_pending_reminder', language: 'es-AR',
        createdBy: 'Ana Joulie', createdAt: '2026-05-18T14:04:00Z',
        submittedBy: 'Ana Joulie', submittedAt: '2026-05-19T12:20:00Z', status: 'submitted',
      }] } }) }));

    await page.goto('/admin/plantillas');
    await expect(page.getByTestId('tc-table')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tc-row-registro_pendiente').click();
    // 🔒 A prova de que virou ROTA, e não drawer: a URL muda.
    await expect(page).toHaveURL(/\/admin\/plantillas\/ar_signup_pending_reminder$/, { timeout: 30_000 });
    await expect(page.getByTestId('tc-detalhe-timeline')).toBeVisible({ timeout: 30_000 });

    /*
     * 🔒 O QUE UMA TELA DE RECUSA TEM DE TER: o histórico, a prosa da Meta, e o
     * que dá para fazer. Um drawer de campos rótulo→valor respondia "quais são
     * os dados desta linha"; a pergunta de quem chega aqui é outra.
     */
    await expect(page.getByTestId('tc-detalhe-evento-recusado')).toBeVisible();
    await expect(page.getByTestId('tc-detalhe-motivo')).toBeVisible();
    await expect(page.getByTestId('tc-detalhe-que-fazer')).toBeVisible();
    /*
     * 🔒 O PAPEL, NÃO O TESTID. "Duplicar y corregir" é o botão cheio da coluna
     * quando a linha não tem rascunho; quando tem, quem faz esse papel é o
     * `duplicar` do card do rascunho, que clona a linha do banco com versão e
     * autoria em vez de abrir um rascunho novo. A maquete pede UM botão cheio
     * ali, e o portão tem de aceitar qualquer um dos dois — o que ele não pode
     * aceitar é nenhum.
     */
    await expect(
      page.getByTestId('tc-detalhe-duplicar').or(page.getByTestId('tc-rascunho-duplicar')),
    ).toBeVisible();
    // E as ações do rascunho estão AQUI, não no pé do compositor.
    await expect(page.getByTestId('tc-detalhe-rascunho')).toBeVisible();

    const cabe = await cabeNaJanela(page);
    expect(cabe.conteudo, `a tela mede ${cabe.conteudo}px numa janela de ${cabe.janela}px — a foto sairia cortada`)
      .toBeLessThanOrEqual(cabe.janela);
    await page.locator(CONTEUDO).screenshot({ path: `${SAIDA}/app/4-detalhe.png`, animations: 'disabled' });
  });
});
