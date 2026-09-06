/**
 * admin-map-tracado.integration.e2e.ts @integration
 *
 * O TRAÇADO DA ROTA SOBRE O MAPA, EM TELA, SEM DUBLÊ.
 *
 * Navegador real → Google Maps JS real (chave do `.env`) → worker-functions real
 * → Postgres+PostGIS real → **Routes API real do Google**. Nada interceptado.
 *
 * ⚠️ POR QUE ESPIONAR O CONSTRUTOR, e não olhar o DOM: `google.maps.Polyline`
 * desenha em CANVAS. Não existe nó para consultar, `toHaveScreenshot` de mapa
 * vivo é instável (as telas do Google mudam), e um teste que só afirma "o painel
 * mostra 3 opções" não sabe se alguma linha foi para a tela. Então o teste
 * embrulha o construtor REAL depois que a biblioteca carregou: o que ele afirma
 * é que o nosso código chamou o Google com um caminho DECODIFICADO e com a
 * aparência combinada — e que mandou apagar quando devia.
 *
 * O teste do gancho (`useRouteOverlay.test.ts`) usa um `google` falso e prova a
 * LÓGICA. Este prova que a lógica encontra o Google de verdade: que a biblioteca
 * `geometry` está carregada (sem ela `decodePath` não existe e nada é desenhado,
 * em silêncio) e que a polilinha que a Routes API devolveu decodifica em pontos.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { insertTestPatient, cleanupTestPatient, insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.tracado.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const TS = Date.now().toString().slice(-6);

// Pontos REAIS de CABA com transporte público entre eles: Congreso → Obelisco,
// ~1,2 km. Perto o bastante para a rota ser curta e caber no balão, longe o
// bastante para o Google devolver caminhada + coletivo + caminhada.
const PACIENTE_EM = { lat: -34.6037, lng: -58.3816 }; // Obelisco
const PRESTADOR_EM = { lat: -34.6094, lng: -58.3923 }; // Congreso
// Segundo prestador, LONGE (Quilmes, ~16 km): força rota COM BALDEAÇÃO, que é o
// caso alto do balão — 5 pernas em vez de 3. É esse caso que estoura a borda, e
// sem ele o teste vira sorteio: com o par curto, o enquadramento sozinho já
// bastava e a asserção passava mesmo com o conserto sabotado (medido em 06/09).
const PRESTADOR_LONGE = { lat: -34.7203, lng: -58.2543 }; // Quilmes

interface LinhaDesenhada {
  pontos: number;
  cor?: string;
  espessura?: number;
  pontilhada: boolean;
  viva: boolean;
}

/**
 * Grava o print em disco quando `PW_PRINTS` aponta uma pasta. Serve para revisão
 * humana ("me mostra como ficou"); no CI a variável não existe e isto é inerte —
 * os anexos do relatório continuam sendo a evidência do teste.
 */
async function esperarLadrilhos(page: Page): Promise<void> {
  // O `fitBounds` troca o enquadramento e o Google recarrega os ladrilhos; sem
  // esperar, o print sai com o mapa cinza e a rota parece flutuar no vazio.
  await expect(page.getByTestId('points-map')).toHaveAttribute('data-tiles', 'loaded', { timeout: 20_000 });
  await page.waitForTimeout(700);
}

function guardarPrint(nome: string, png: Buffer): void {
  const destino = process.env.PW_PRINTS;
  if (!destino) return;
  mkdirSync(destino, { recursive: true });
  writeFileSync(`${destino}/${nome}.png`, png);
}

const sql = (q: string): string =>
  execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' }).trim();

async function loginComoStaff(page: Page): Promise<void> {
  // Cria OU entra: os dois testes deste arquivo rodam em série e usam a mesma
  // conta; `signUp` recusa e-mail repetido, e exigir `ok` fazia o segundo teste
  // falhar por um motivo que nada tem a ver com o que ele verifica.
  const credenciais = JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true });
  const signUp = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: credenciais,
  });
  const conta = signUp.ok ? signUp : await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: credenciais,
  });
  expect(conta.ok).toBe(true);
  const { localId } = (await conta.json()) as { localId: string };
  await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'recruiter', country: 'AR' }) }),
  });
  sql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Tracado', 'recruiter', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}

/**
 * Embrulha o construtor REAL, depois que o mapa carregou e ANTES de qualquer
 * rota ser desenhada. Guarda o que foi pedido e segue a vida da linha pelo
 * `setMap` — é `setMap(null)` que apaga, e é isso que precisa ser observado.
 */
async function espionarPolilinhas(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { google: typeof google; __linhas: unknown[] };
    w.__linhas = [];
    const Original = w.google.maps.Polyline;
    // `any` no `opts`: é o objeto de opções do Google, e o espião só lê 4
    // campos dele. A pasta `e2e/` não tem a regra `no-explicit-any` ligada —
    // pôr `eslint-disable` aqui virava DIRETIVA INÚTIL, que o `pnpm lint` da
    // casa reprova (`--report-unused-disable-directives`). Medido no CI.
    w.google.maps.Polyline = function (opts: any) {
      const linha = new Original(opts);
      const registro = {
        pontos: Array.isArray(opts.path) ? opts.path.length : 0,
        cor: opts.strokeColor,
        espessura: opts.strokeWeight,
        pontilhada: opts.strokeOpacity === 0 && Array.isArray(opts.icons),
        viva: true,
      };
      w.__linhas.push(registro);
      const setMapOriginal = linha.setMap.bind(linha);
      linha.setMap = (m: google.maps.Map | null): void => {
        registro.viva = m !== null;
        setMapOriginal(m);
      };
      return linha;
    } as any;
  });
}

const linhas = (page: Page): Promise<LinhaDesenhada[]> =>
  page.evaluate(() => (window as unknown as { __linhas: LinhaDesenhada[] }).__linhas);
const vivas = async (page: Page): Promise<LinhaDesenhada[]> => (await linhas(page)).filter((l) => l.viva);

test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

test.describe('Traçado da rota sobre o mapa (@integration)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let workerId = ''; let workerLongeId = ''; let patientId = '';
  const nomePaciente = `Trac${TS}`;
  const nomePrestador = `TracW${TS}`;
  const nomeLonge = `TracL${TS}`;

  test.beforeAll(() => {
    const p = insertTestPatient({
      firstName: nomePaciente, lastName: 'Mapa', status: 'ACTIVE', withAddress: true,
      addressLat: PACIENTE_EM.lat, addressLng: PACIENTE_EM.lng,
    });
    patientId = p.patientId;
    sql(`UPDATE patient_addresses SET city='CABA', state='San Nicolás', address_formatted='Obelisco, CABA' WHERE id='${p.addressId as string}'`);
    workerId = insertTestWorker({
      firstName: nomePrestador, lastName: 'Mapa', occupation: 'AT', status: 'REGISTERED',
      ...PRESTADOR_EM,
    });
    sql(`UPDATE workers SET profession='AT' WHERE id='${workerId}'`);
    sql(`UPDATE worker_service_areas SET city='Congreso', state='CABA' WHERE worker_id='${workerId}'`);
    workerLongeId = insertTestWorker({
      firstName: nomeLonge, lastName: 'Mapa', occupation: 'AT', status: 'REGISTERED', ...PRESTADOR_LONGE,
    });
    sql(`UPDATE workers SET profession='AT' WHERE id='${workerLongeId}'`);
    sql(`UPDATE worker_service_areas SET city='Quilmes', state='Buenos Aires' WHERE worker_id='${workerLongeId}'`);
  });

  test.afterAll(() => {
    cleanupTestWorker(workerId);
    cleanupTestWorker(workerLongeId);
    cleanupTestPatient(patientId);
    sql(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('desenha a opção aberta, TROCA ao mudar de opção e APAGA ao fechar o balão', async ({ page }, testInfo) => {
    await loginComoStaff(page);
    await page.goto('/admin/mapa');

    // 1 · portão: escolher o paciente-âncora
    const seletor = page.getByTestId('map-center-patient');
    await seletor.getByRole('button').click();
    const opcao = seletor.getByRole('option').filter({ hasText: nomePaciente });
    await expect(opcao).toHaveCount(1, { timeout: 30_000 });
    await opcao.click();
    await expect(page.getByTestId('map-center-label')).toContainText(nomePaciente, { timeout: 30_000 });

    // O mapa REAL precisa estar de pé — sem ele não há balão nem canvas, e o
    // teste viraria uma afirmação sobre nada.
    await expect(page.getByTestId('points-map')).toHaveAttribute('data-map-status', 'ready', { timeout: 60_000 });
    await espionarPolilinhas(page);
    expect(await linhas(page)).toHaveLength(0); // o espião começa zerado

    // 2 · abrir o balão do prestador PERTO, com o raio padrão de 5 km. É a
    // configuração exata em que o corte de 120px foi medido em 06/09 — mexer
    // nela (prestador longe, raio de 25 km) fazia o defeito sumir e o teste
    // virava enfeite, aprovando o conserto sabotado.
    await page.getByTestId('map-list-item').filter({ hasText: nomePrestador }).first().click();
    await page.getByTestId('routes').waitFor({ timeout: 60_000 });
    const opcoes = await page.getByTestId('route').count();
    expect(opcoes).toBeGreaterThan(0);

    // 3 · a 1ª opção nasce aberta, então já tem de haver traçado NA TELA
    await expect.poll(async () => (await vivas(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const desenhadas = await vivas(page);

    // Cada linha veio de uma polilinha DECODIFICADA: se a biblioteca `geometry`
    // não estivesse carregada, `decodePath` não existiria e o gancho desistiria
    // em silêncio — zero linha, teste vermelho aqui.
    for (const l of desenhadas) expect(l.pontos).toBeGreaterThan(1);

    // A aparência do Maps, com dado REAL do Google — não uma constante nossa:
    // 1) caminhada em pontos;
    expect(desenhadas.some((l) => l.pontilhada)).toBe(true);
    // 2) o traço sai na COR OFICIAL da linha. Em CABA o Google informa cor para
    //    todas (o 50 é `#1b6633`, o 8 é `#3061f2`), então achar aqui a cor de
    //    reserva do tema significaria que o campo parou de chegar.
    const coloridas = desenhadas.filter((l) => !l.pontilhada && l.cor && l.cor !== '#ffffff');
    expect(coloridas.length).toBeGreaterThan(0);
    for (const l of coloridas) expect(l.cor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(coloridas.every((l) => l.cor === '#180149')).toBe(false);
    // 3) e cada traço vai sobre um contorno branco MAIS LARGO.
    const contornos = desenhadas.filter((l) => l.cor === '#ffffff');
    expect(contornos.length).toBe(coloridas.length);
    expect(Math.min(...contornos.map((l) => l.espessura ?? 0)))
      .toBeGreaterThan(Math.max(...coloridas.map((l) => l.espessura ?? 0)));

    await esperarLadrilhos(page);
    const png_1 = await page.screenshot();
      await testInfo.attach('1-tracado-opcao-1', { body: png_1, contentType: 'image/png' });
      guardarPrint('1-tracado-opcao-1', png_1);

    // 3b · O BALÃO INTEIRO TEM DE CABER NO MAPA.
    // Este é o defeito que só a tela mostra: o `InfoWindow` decide a posição
    // quando ABRE, com o painel ainda em "buscando…"; as rotas chegam, ele se
    // estica para cima e o topo — nome do prestador, "Ver perfil" e a contagem
    // de opções — sai pela borda. Medido em 06/09 antes do conserto: 120px
    // cortados, com o `×` de fechar fora da área clicável. Nenhum teste de
    // unidade vê isso: no DOM o elemento existe, com o tamanho certo.
    // Verifica TODAS as opções, e não só uma: a altura do balão muda com a rota,
    // e o Google devolve alternativas diferentes a cada chamada — conferir só
    // uma torna o teste um sorteio.
    //
    // ⚠️ A ORDEM IMPORTA, e a versão anterior errava nela. A opção 1 NASCE
    // ABERTA; o laço começava clicando nela, o que a FECHAVA (`aberta === i` →
    // `setAberta(-1)`), deixando o painel no tamanho mínimo. Resultado: o único
    // estado nunca medido era exatamente o do defeito — balão recém-aberto com a
    // 1ª opção expandida, que é como ele chega na tela do operador. Achado pelo
    // gate em 06/09. Por isso o estado inicial é medido ANTES de qualquer
    // clique, e o laço começa em 1.
    const cabeNoMapa = async (): Promise<number> => {
      const mapa = await page.getByTestId('points-map').boundingBox();
      const balao = await page.getByTestId('points-map-info-card').boundingBox();
      return mapa && balao ? Math.round(mapa.y - balao.y) : 999;
    };
    const conferirEncaixe = async (rotulo: string): Promise<void> => {
      const alturaPainel = (await page.getByTestId('corridor-panel').boundingBox())?.height ?? 0;
      await expect.poll(cabeNoMapa, {
        timeout: 15_000,
        message: `${rotulo}: topo do balão cortado (painel com ${alturaPainel}px)`,
      }).toBeLessThanOrEqual(0);
    };

    await conferirEncaixe('estado inicial (opção 1 aberta, como o balão nasce)');
    for (let i = 1; i < opcoes; i++) {
      await page.getByTestId('route-summary').nth(i).click();
      await page.waitForTimeout(300);
      await conferirEncaixe(`opção ${i + 1} aberta`);
    }
    // Reabre a 1ª SÓ se o laço acima a fechou. Com uma única opção o laço não
    // roda, e clicar aqui FECHARIA o acordeão — o passo 5 ("fechar o balão
    // apaga o traçado") viraria vacuamente verdadeiro, porque não haveria linha
    // desenhada para apagar.
    if (opcoes > 1) {
      await page.getByTestId('route-summary').nth(0).click();
      await page.waitForTimeout(300);
    }
    // seja qual for o caminho, tem de haver traçado ANTES de testar o apagamento
    await expect.poll(async () => (await vivas(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);

    // 4 · trocar de opção SUBSTITUI o traçado — não empilha
    if (opcoes > 1) {
      const antes = (await vivas(page)).length;
      await page.getByTestId('route-summary').nth(1).click();
      await expect.poll(async () => (await vivas(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);

      const criadasAoTodo = (await linhas(page)).length;
      const aindaVivas = (await vivas(page)).length;
      // O que importa não é quantas foram criadas, e sim quantas SOBRAM: sem o
      // apagamento, o mapa acumularia rota até a recrutadora recarregar a página.
      expect(criadasAoTodo).toBeGreaterThan(antes);
      expect(aindaVivas).toBeLessThanOrEqual(criadasAoTodo - antes);
      await esperarLadrilhos(page);
      const png_2 = await page.screenshot();
      await testInfo.attach('2-tracado-opcao-2', { body: png_2, contentType: 'image/png' });
      guardarPrint('2-tracado-opcao-2', png_2);
    }

    // 5 · fechar o balão APAGA tudo
    await page.getByTestId('points-map-info-close').click();
    await expect(page.getByTestId('corridor-panel')).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(async () => (await vivas(page)).length, { timeout: 10_000 }).toBe(0);
    await esperarLadrilhos(page);
    const png_3 = await page.screenshot();
      await testInfo.attach('3-tracado-apagado', { body: png_3, contentType: 'image/png' });
      guardarPrint('3-tracado-apagado', png_3);
  });

  test('🔒 o traçado não vaza para o DOM — nem em atributo, nem em texto', async ({ page }) => {
    // C4 do parecer do `lex`: a máscara do Clarity cobre CONTEÚDO de nó, e não
    // há garantia sobre valor de atributo. Os vértices das pontas da polilinha
    // são os dois domicílios.
    await loginComoStaff(page);
    await page.goto('/admin/mapa');
    const seletor = page.getByTestId('map-center-patient');
    await seletor.getByRole('button').click();
    await seletor.getByRole('option').filter({ hasText: nomePaciente }).first().click();
    await page.getByTestId('map-list-item').filter({ hasText: nomePrestador }).first().click();
    await page.getByTestId('routes').waitFor({ timeout: 60_000 });

    const html = await page.content();
    expect(html).not.toContain('encodedPolyline');
    expect(await page.locator('[data-path]').count()).toBe(0);
    expect(await page.locator('[data-polyline]').count()).toBe(0);

    // O painel continua mascarado para o session replay.
    await expect(page.getByTestId('corridor-panel')).toHaveAttribute('data-clarity-mask', 'True');
  });
});
