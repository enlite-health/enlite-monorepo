/**
 * mapa-staff.regression.ts — o MAPA do painel (REQ-04 · DEC-14) medido pela TELA,
 * contra PRODUÇÃO real. (Spec 009, Fase 4.)
 *
 * ── O QUE ESTE SPEC PROVA (R6) ────────────────────────────────────────────────
 *  1. O raio é um filtro de verdade: 25 km devolve MAIS gente que 5 km, e o número
 *     PINTADO na tela é o mesmo que a API respondeu (não um contador local otimista).
 *  2. O teto de 500 pontos não vira mentira: quando a resposta vem `truncated`, a tela
 *     diz "mostrando los primeros N de M"; quando NÃO vem, a frase some. As duas
 *     metades são exercitadas no mesmo run — se a base crescer a ponto de todo raio
 *     truncar, o teste FALHA dizendo isso, em vez de silenciosamente provar metade.
 *  3. O PORTÃO da âncora: abrir /admin/mapa não lê NINGUÉM (zero POST); escolher o
 *     paciente-âncora é o que abre a tela, e o corpo da primeira requisição já carrega
 *     a coordenada DO PACIENTE ESCOLHIDO, com o raio nascendo em 5 km.
 *  4. A trilha D225 registra o ESCOPO da leitura em massa sem identificar ninguém:
 *     `geohash5` e `totalMatching` presentes; coordenada crua, UUID e nome AUSENTES.
 *
 * ── POR QUE NENHUM DADO DE PESSOA REAL É LIDO (R5) ────────────────────────────
 * O mapa é, por natureza, uma tela cheia de gente real. Este spec nunca olha para
 * quem: as asserções são sobre CONTAGENS, sobre o corpo da requisição e sobre o
 * `data-point-id` das linhas — nunca sobre nome, endereço ou status de alguém.
 * O paciente usado no picker é criado por este teste, marcado `is_test`, endereçado
 * num logradouro PÚBLICO e purgado no fim; ele é escolhido digitando o PRÓPRIO nome
 * sintético na busca do seletor, o que reduz a lista a uma linha — nem o nome de um
 * vizinho de lista chega a ser comparado.
 *
 * ⚠️ LIMITE DECLARADO, herdado da suíte: `screenshot`/`video` são `on-failure`. Num
 * run VERMELHO desta tela, o artefato pode capturar nomes reais da lista lateral.
 * Isso vale para todo spec do projeto `admin` e não nasce aqui — mas nasce aqui a
 * primeira jornada de ESCRITA sobre essa tela, então fica NOMEADO.
 *
 * ── O QUE ESTE SPEC NÃO PROVA ─────────────────────────────────────────────────
 *  · Não prova os TILES do Google Maps no navegador — depende da restrição de
 *    referrer da chave e é config, não código (declarado fora da Spec 009). As
 *    asserções vivem na LISTA e no corpo da requisição, que é onde está o dado.
 *  · Não prova o mapa de BR: o país de operação é AR e a base BR é vazia.
 *  · Não prova ABAC/permissão sobre o mapa (engine off em prod).
 *
 * ── SEGURANÇA DO EFEITO COLATERAL ─────────────────────────────────────────────
 * O mapa é LEITURA. A única escrita é o fixture do picker (lead + endereço), que não
 * tem passo outbound: `CreateLeadUseCase` escreve o paciente nativo e nada mais, e o
 * endereço só faz geocoding. Nenhuma mensagem pode sair deste spec.
 */
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { newAdminApiContext } from '../src/support/adminApi';
import { queryLogs, waitForLog, type LogEntry } from '../src/support/cloudLogging';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const NOME_SINTETICO = `E2E Mapa ${STAMP}`;
const LEAD_EMAIL = `e2e-mapa-${STAMP}@enlite.import`;
const LEAD_PHONE = `+54 9 11 5555 ${STAMP.slice(-4)}`;
/** Logradouro PÚBLICO em CABA — endereço de ninguém, a ~700 m do centro padrão do mapa. */
const ENDERECO_PUBLICO = 'Avenida de Mayo 1370, Ciudad Autonoma de Buenos Aires, Argentina';

/** O centro com que a página nasce (`mapPageConfig.DEFAULT_CENTER`, AR). */
const CENTRO_PADRAO = { lat: -34.6037, lng: -58.3816 };
/** Raios oferecidos pela tela (`RADIUS_OPTIONS_KM`) que este spec percorre. */
const RAIOS = [5, 25, 50] as const;
/** O raio com que a tela NASCE. Reselecioná-lo não gera request (React bail-out). */
const DEFAULT_RADIUS_KM = 5;

const mapa: {
  patientId?: string;
  addressId?: string;
  lat?: number;
  lng?: number;
} = {};

interface MapResponse {
  data: Array<{ id: string; addressId?: string | null; lat: number | null; lng: number | null }>;
  total: number;
  truncated: boolean;
  withoutCoordinates: number;
}

/** Abre `/admin/mapa` com a sessão admin e espera a PRIMEIRA resposta do mapa de prestadores. */
/**
 * Escolhe a ÂNCORA no seletor com busca. NÃO é um `<select>` nativo: é o
 * `SearchableSelect` (combobox), então `selectOption` não serve — abrir, filtrar
 * pelo nome e clicar no `role="option"` é o único caminho.
 *
 * O filtro é digitado com o nome SINTÉTICO criado por este spec: além de achar
 * o alvo, ele encurta a lista para uma linha, então o teste não passa os olhos
 * pelos nomes de pacientes reais — é mais estrito que a escolha por `value` que
 * havia aqui antes, não menos.
 */
async function ancorarNoPacienteSintetico(page: Page): Promise<void> {
  const picker = page.getByTestId('map-center-patient');
  await picker.getByRole('button').click();
  await picker.getByRole('textbox').fill(NOME_SINTETICO);
  const opcao = picker.getByRole('option').filter({ hasText: NOME_SINTETICO });
  await expect(
    opcao,
    'o paciente sintético aparece no seletor (só entra quem tem coordenada completa)',
  ).toHaveCount(1);
  await opcao.click();
}

/**
 * A aba de Pacientes tem portão próprio, e a âncora dela é um PRESTADOR — não
 * existe prestador sintético em produção, então a escolha é pelo ÍNDICE: a
 * primeira opção da lista, sem ler, comparar nem afirmar o nome de ninguém.
 * O que este spec mede depois disso são contagens e o corte dos 500, que não
 * dependem de QUEM é a âncora.
 */
async function ancorarNoPrimeiroPrestador(page: Page): Promise<void> {
  const picker = page.getByTestId('map-center-worker');
  await picker.getByRole('button').click();
  // [0] é o placeholder "Centrar en un prestador…"; [1] é a primeira pessoa.
  const primeiro = picker.getByRole('option').nth(1);
  await expect(primeiro, 'há ao menos um prestador com coordenada para ancorar').toBeVisible({ timeout: 20_000 });
  await primeiro.click();
}

/**
 * Abre o mapa e passa pelo PORTÃO. Sem âncora a tela não busca nada — o
 * `waitForResponse` de antes ficaria pendurado até o timeout, porque o `goto`
 * sozinho não gera mais nenhum POST.
 */
async function abrirMapa(
  browser: Browser,
): Promise<{ page: Page; primeira: MapResponse; fechar: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: ADMIN_AUTH_FILE });
  const page = await ctx.newPage();
  await page.goto('/admin/mapa');
  // PORTÃO FECHADO: nem lista, nem contagem, nem mapa — e nenhuma request.
  await expect(page.getByTestId('map-anchor-empty')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('map-total')).toHaveCount(0);

  // O seletor só vai ao servidor quando tocado; escolher a âncora é o que
  // dispara a PRIMEIRA leitura de prestadores.
  const espera = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/api/admin/workers/map'),
  );
  await ancorarNoPacienteSintetico(page);
  const primeira = (await (await espera).json()) as MapResponse;
  await expect(page.getByTestId('map-total')).toBeVisible({ timeout: 30_000 });
  return { page, primeira, fechar: async () => { await ctx.close(); } };
}

/** O que a tela PEDIU (corpo) e o que ela RECEBEU (resposta) numa única interação. */
interface Consulta {
  pedido: { center?: { lat: number; lng: number }; radius_km?: number; country?: string };
  resposta: MapResponse;
}

/**
 * Dispara uma ação e devolve o par pedido↔resposta do mapa de `kind`.
 *
 * O PEDIDO importa tanto quanto a resposta: é no corpo que se prova "a tela passou a
 * perguntar por outro centro". Ler isso do canvas do Google seria indireto — e o canvas
 * nem carrega sem chave de Maps no navegador do runner.
 */
async function consultarMapa(
  page: Page,
  kind: 'workers' | 'patients',
  acao: () => Promise<unknown>,
): Promise<Consulta> {
  const casa = (r: { method(): string; url(): string }): boolean =>
    r.method() === 'POST' && r.url().includes(`/api/admin/${kind}/map`);
  const esperaResposta = page.waitForResponse((r) => casa(r.request()));
  await acao();
  const res = await esperaResposta;
  expect(res.status(), `POST /api/admin/${kind}/map responde 200`).toBe(200);
  await expect(page.getByTestId('map-loading')).toBeHidden();
  return {
    pedido: (res.request().postDataJSON() ?? {}) as Consulta['pedido'],
    resposta: (await res.json()) as MapResponse,
  };
}

/** Açúcar para os passos que só olham a resposta. */
async function respostaDoMapa(
  page: Page,
  kind: 'workers' | 'patients',
  acao: () => Promise<unknown>,
): Promise<MapResponse> {
  return (await consultarMapa(page, kind, acao)).resposta;
}

/** O número que o humano lê no card de contagem. */
async function totalNaTela(page: Page): Promise<number> {
  const texto = (await page.getByTestId('map-total').innerText()).replace(/\D/g, '');
  expect(texto, 'o card de contagem tem um número legível').not.toBe('');
  return Number(texto);
}

/** Os ids das linhas da lista lateral — identidade da lista SEM olhar quem é quem. */
async function idsDaLista(page: Page): Promise<string[]> {
  return page.getByTestId('map-list-item').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-point-id') ?? ''),
  );
}

test.describe.serial('Spec 009 · Fase 4 — mapa do staff', () => {
  let adminCtx: APIRequestContext | undefined;

  test.beforeAll(async () => {
    test.skip(
      !process.env.E2E_ADMIN_EMAIL || !process.env.FIREBASE_API_KEY,
      'requer E2E_ADMIN_EMAIL + FIREBASE_API_KEY (writes autenticados em prod)',
    );
    adminCtx = await newAdminApiContext();
  });

  test.afterAll(async () => {
    if (adminCtx && mapa.patientId) {
      try {
        await adminCtx.delete(`/api/admin/patients/${mapa.patientId}`);
      } catch {
        // best-effort
      }
    }
    await adminCtx?.dispose();
  });

  test('[@route:POST /api/public/v1/leads @depth:happy] 4.0 — o alvo do picker é um paciente SINTÉTICO, num endereço público, dentro do raio padrão', async () => {
    const leadRes = await adminCtx!.post('/api/public/v1/leads', {
      data: {
        serviceType: 'cuidadores',
        requesterType: 'patient',
        email: LEAD_EMAIL,
        phone: LEAD_PHONE,
        name: NOME_SINTETICO,
        country: 'AR',
        consent: true,
      },
    });
    expect(leadRes.status(), 'POST /api/public/v1/leads cria o paciente (201)').toBe(201);
    mapa.patientId = ((await leadRes.json()) as { data: { id: string } }).data.id;

    const flagRes = await adminCtx!.patch(`/api/admin/patients/${mapa.patientId}/test-flag`, {
      data: { isTest: true },
    });
    expect(flagRes.status(), 'PATCH /test-flag marca is_test (200)').toBe(200);

    // O endereço é o que põe o paciente NO MAPA. `address_type` é enum fechado
    // (`primary` | `secondary` | `service`) — medido contra prod em 30/08.
    const addrRes = await adminCtx!.post(`/api/admin/patients/${mapa.patientId}/addresses`, {
      data: { address_formatted: ENDERECO_PUBLICO, address_type: 'primary' },
    });
    expect(addrRes.status(), 'POST /patients/:id/addresses cria o endereço (201)').toBe(201);

    // O geocoding é BEST-EFFORT no backend: sem coordenada o paciente não entra no
    // picker e o passo 4.2 provaria outra coisa. Então isto é pré-condição, não detalhe.
    const listaRes = await adminCtx!.get(`/api/admin/patients/${mapa.patientId}/addresses`);
    const enderecos = ((await listaRes.json()) as {
      data: Array<{ id: string; lat: string | number | null; lng: string | number | null }>;
    }).data;
    expect(enderecos.length, 'o paciente tem exatamente um endereço').toBe(1);
    const end = enderecos[0]!;
    expect(end.lat, 'o geocoding resolveu a latitude (sem ela o picker não lista o paciente)').not.toBeNull();
    expect(end.lng, 'o geocoding resolveu a longitude').not.toBeNull();
    mapa.addressId = end.id;
    mapa.lat = Number(end.lat);
    mapa.lng = Number(end.lng);
  });

  test('[@route:/admin/mapa @depth:happy] 4.1 — o raio muda a contagem, e a tela só diz "mostrando los primeros N de M" quando a resposta vem truncada', async ({ browser }) => {
    const { page, primeira, fechar } = await abrirMapa(browser);
    try {
      // ── fidelidade: o número na tela é o da API, não um contador local ────────
      expect(
        await totalNaTela(page),
        'no primeiro carregamento a tela pinta exatamente o `total` que a API respondeu',
      ).toBe(primeira.total);

      // ── o raio filtra de verdade (aba prestadores) ────────────────────────────
      // A tela NASCE em 5 km, então `primeira` já É a medida de 5 km. Reselecionar
      // '5' aqui não mudaria estado nenhum: o React sairia sem re-renderizar, o
      // effect não rodaria, nenhum POST sairia e o `waitForResponse` penduraria
      // até o timeout. O primeiro raio exercitado tem de ser um DIFERENTE.
      const em5 = primeira;
      const em25 = await respostaDoMapa(page, 'workers', () =>
        page.getByTestId('map-radius').selectOption('25'),
      );
      expect(await totalNaTela(page), 'a tela acompanha a mudança para 25 km').toBe(em25.total);

      expect(
        em25.total,
        'RAIO É FILTRO: 25 km alcança MAIS prestadores que 5 km. Igualdade aqui significaria ' +
          'que o `ST_DWithin` parou de restringir — o filtro viraria enfeite',
      ).toBeGreaterThan(em5.total);

      // ── o teto de 500 e a frase que o confessa (aba pacientes) ───────────────
      // Percorre os raios e observa AS DUAS metades. Confiar num raio fixo seria
      // frágil: o que trunca hoje pode não truncar amanhã, e o teste passaria
      // provando só metade sem avisar.
      const observados: Array<{ km: number; truncated: boolean }> = [];

      // Trocar de aba mostra o portão da aba de pacientes, não uma lista: é
      // ancorar num prestador que dispara a primeira leitura — já em 5 km.
      await page.getByTestId('map-tab-patients').click();
      await expect(page.getByTestId('map-anchor-empty')).toBeVisible({ timeout: 20_000 });
      const emPacientes5 = await respostaDoMapa(page, 'patients', () => ancorarNoPrimeiroPrestador(page));

      const conferirFrase = async (km: number, resp: MapResponse): Promise<void> => {
        observados.push({ km, truncated: resp.truncated });
        const frase = page.getByTestId('map-truncated');
        if (resp.truncated) {
          await expect(
            frase,
            `${km} km veio truncado — a tela PRECISA confessar que mostra menos do que existe`,
          ).toBeVisible();
          const texto = await frase.innerText();
          expect(texto, 'a frase carrega quantos estão na tela').toContain(String(resp.data.length));
          expect(texto, 'e quantos existem no filtro inteiro').toContain(String(resp.total));
          expect(
            resp.data.length,
            'o corte é o teto de 500 pontos por request (MAX_MAP_POINTS)',
          ).toBe(500);
        } else {
          await expect(
            frase,
            `${km} km NÃO veio truncado — a frase não pode aparecer, senão ela é decorativa`,
          ).toBeHidden();
          expect(resp.data.length, 'sem truncamento, a lista é o filtro inteiro').toBe(resp.total);
        }
      };

      await conferirFrase(DEFAULT_RADIUS_KM, emPacientes5);
      for (const km of RAIOS.filter((k) => k !== DEFAULT_RADIUS_KM)) {
        await conferirFrase(km, await respostaDoMapa(page, 'patients', () =>
          page.getByTestId('map-radius').selectOption(String(km)),
        ));
      }

      // O controle que impede este teste de provar metade em silêncio.
      expect(
        observados.some((o) => o.truncated),
        `nenhum raio de ${RAIOS.join('/')} km truncou — o ramo "truncado" não foi exercitado. ` +
          'A base encolheu; escolha um raio maior antes de confiar neste teste',
      ).toBe(true);
      expect(
        observados.some((o) => !o.truncated),
        `TODOS os raios de ${RAIOS.join('/')} km truncaram — o ramo "não truncado" não foi ` +
          'exercitado, e "a frase aparece" deixou de ser uma escolha do código. A base cresceu; ' +
          'escolha um raio menor antes de confiar neste teste',
      ).toBe(true);
    } finally {
      await fechar();
    }
  });

  test('[@route:POST /api/admin/patients/map @depth:happy] 4.2 — o PORTÃO: nada é lido antes da âncora, e a 1ª leitura já pede pelo domicílio dela', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: ADMIN_AUTH_FILE });
    const page = await ctx.newPage();
    try {
      const posts: Array<{ url: string; corpo: Consulta['pedido'] }> = [];
      page.on('request', (req) => {
        if (req.method() === 'POST' && /\/api\/admin\/(workers|patients)\/map$/.test(req.url())) {
          posts.push({ url: req.url(), corpo: (req.postDataJSON() ?? {}) as Consulta['pedido'] });
        }
      });

      await page.goto('/admin/mapa');
      await expect(page.getByTestId('map-anchor-empty')).toBeVisible({ timeout: 30_000 });
      // A PROVA do portão: abrir a tela não lê NINGUÉM. Antes ela nascia varrendo
      // 25 km em volta do Obelisco sem que ninguém tivesse pedido nada.
      expect(posts, 'PORTÃO: abrir /admin/mapa não dispara nenhuma leitura de mapa').toEqual([]);
      await expect(page.getByTestId('map-list')).toHaveCount(0);
      await expect(page.getByTestId('map-filters-block')).toHaveCount(0);

      // Tocar o seletor lê os candidatos a âncora — e SÓ isso.
      await respostaDoMapa(page, 'patients', () => page.getByTestId('map-center-patient').click());
      expect(
        posts.filter((p) => p.url.endsWith('/api/admin/workers/map')),
        'tocar o seletor não lê prestadores: a lista ainda não existe',
      ).toEqual([]);

      // Escolher a âncora é o que abre a tela, e a 1ª leitura já vai pelo domicílio dela.
      const primeira = await consultarMapa(page, 'workers', () => ancorarNoPacienteSintetico(page));
      expect(
        primeira.pedido.center,
        'a PRIMEIRA leitura de prestadores já pede pelo domicílio do paciente-âncora',
      ).toEqual({ lat: mapa.lat, lng: mapa.lng });
      expect(
        primeira.pedido.center,
        'e portanto nunca foi o centro padrão do país',
      ).not.toEqual(CENTRO_PADRAO);
      expect(primeira.pedido.radius_km, 'o raio nasce em 5 km').toBe(5);

      const antes = await idsDaLista(page);
      // Mover o centro no mapa muda o conjunto — e a âncora FICA como referência.
      const depois4_2 = await consultarMapa(page, 'workers', () =>
        page.getByTestId('map-radius').selectOption('25'),
      );
      expect(depois4_2.pedido.center, 'abrir o raio não move o centro').toEqual({ lat: mapa.lat, lng: mapa.lng });
      expect(
        await idsDaLista(page),
        'A LISTA MUDA: 25 km alcança prestadores que 5 km não alcançava',
      ).not.toEqual(antes);
      await expect(
        page.getByTestId('map-center-label'),
        'a âncora continua nomeada na tela depois de mexer no raio',
      ).toContainText(NOME_SINTETICO);
    } finally {
      await ctx.close();
    }
  });

  test('[@route:POST /api/admin/workers/map @depth:happy] 4.3 — a trilha D225 registra o ESCOPO da leitura em massa sem identificar ninguém', async ({ browser }) => {
    // Uma leitura NOVA, com um raio escolhido aqui, para achar ESTA entrada no log.
    const RAIO_MARCADOR = 10;
    const { page, fechar } = await abrirMapa(browser);
    try {
      await respostaDoMapa(page, 'workers', () =>
        page.getByTestId('map-radius').selectOption(String(RAIO_MARCADOR)),
      );
    } finally {
      await fechar();
    }

    // O nome do evento vive em `jsonPayload.msg` (pino), não em `.message` — medido
    // contra prod em 30/08: o filtro por `.message` devolve zero para este log.
    const entrada = await waitForLog(
      { match: { msg: 'workers.map.read', radiusKm: String(RAIO_MARCADOR) }, withinMinutes: 15 },
      { timeoutMs: 90_000, intervalMs: 5_000 },
    );
    expect(entrada, 'a leitura em massa DEIXA trilha (se não deixasse, não haveria auditoria)').not.toBeNull();

    const payload = (entrada as LogEntry).jsonPayload ?? {};
    const serializado = JSON.stringify(payload);

    // ── o que PRECISA estar lá ───────────────────────────────────────────────
    expect(payload.geohash5, 'geohash-5 do centro — o escopo geográfico DESIDENTIFICADO').toEqual(
      expect.any(String),
    );
    expect(String(payload.geohash5), 'geohash de 5 caracteres, não mais fino que isso').toHaveLength(5);
    expect(payload.totalMatching, 'o TAMANHO da varredura, não só o que coube na tela').toEqual(
      expect.any(Number),
    );
    expect(payload.uid, 'quem consultou (o staff), que é o ponto de uma trilha de acesso').toEqual(
      expect.any(String),
    );

    // ── CONTROLE POSITIVO da inspeção ────────────────────────────────────────
    // Um valor que EU mandei na requisição está no payload. Sem isto, "não achei
    // coordenada" poderia ser só "estou olhando para o objeto errado".
    expect(
      serializado,
      'CONTROLE POSITIVO — um parâmetro que a tela enviou ESTÁ na trilha, logo a inspeção ' +
        'enxerga o que foi enviado',
    ).toContain(`"radiusKm":${RAIO_MARCADOR}`);

    // ── o que NÃO pode estar lá (D225 / lex C6) ──────────────────────────────
    for (const proibido of ['lat', 'lng', 'center', 'name', 'id']) {
      expect(
        Object.keys(payload),
        `a trilha não carrega a chave "${proibido}" — geocódigo fino só é admissível ` +
          'porque NÃO HÁ IDENTIFICADOR na mesma linha',
      ).not.toContain(proibido);
    }
    // ⚠️ A régua é a coordenada QUE ESTA LEITURA ENVIOU — o domicílio do paciente
    // sintético, que com o portão da âncora é sempre o centro. Procurar
    // `CENTRO_PADRAO` aqui seria um controle MORTO: a tela não manda mais esse
    // ponto, então a asserção passaria mesmo que o backend voltasse a logar a
    // coordenada crua. Controle que não pode falhar não é controle.
    expect(
      serializado,
      'a coordenada CRUA do centro não aparece — o geohash-5 existe justamente para substituí-la',
    ).not.toContain(String(mapa.lat));
    expect(serializado, 'nem a longitude crua').not.toContain(String(mapa.lng));
    expect(
      serializado,
      'e nenhum UUID — nem de paciente, nem de prestador, nem de endereço',
    ).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  test('[@route:GET /api/admin/patients/:id @depth:happy] 4.3b — o nome do paciente está na RESPOSTA do mapa e não está na trilha (mesma string, dois lugares)', async () => {
    // Metade positiva: a API do mapa devolve nome — a string existe e é a certa.
    const mapaRes = await adminCtx!.post('/api/admin/patients/map', {
      data: { country: 'AR', center: CENTRO_PADRAO, radius_km: 5 },
    });
    expect(mapaRes.status(), 'POST /api/admin/patients/map responde 200').toBe(200);
    const corpoResposta = await mapaRes.text();
    expect(
      corpoResposta,
      'CONTROLE POSITIVO — o nome do paciente sintético ESTÁ na resposta do mapa (é o rótulo do pino)',
    ).toContain(NOME_SINTETICO);

    // Metade negativa: a MESMA string, procurada no log, não aparece em lugar nenhum.
    const noLog = await queryLogs({ textQuery: NOME_SINTETICO, withinMinutes: 30, limit: 1 });
    expect(
      noLog.length,
      'o NOME que a tela mostra NÃO pode entrar no Cloud Logging — a trilha registra o escopo ' +
        'da varredura, nunca quem foi varrido',
    ).toBe(0);

    // E o UUID do paciente também não entra pela porta do mapa.
    const uuidNaTrilha = await queryLogs({
      match: { msg: 'patients.map.read' },
      textQuery: mapa.patientId!,
      withinMinutes: 30,
      limit: 1,
    });
    expect(uuidNaTrilha.length, 'nem o UUID do paciente na trilha do mapa').toBe(0);
  });

  test('[@route:DELETE /api/admin/patients/:id @depth:happy] 4.4 — a purga é PROVADA em três leituras: 404, endereço e mapa', async () => {
    const antesDoPurge = (await (
      await adminCtx!.post('/api/admin/patients/map', {
        data: { country: 'AR', center: CENTRO_PADRAO, radius_km: 5 },
      })
    ).json()) as MapResponse;
    expect(
      antesDoPurge.data.filter((p) => p.id === mapa.patientId).length,
      'antes da purga o paciente sintético está no mapa (senão a prova seguinte é vazia)',
    ).toBe(1);

    const purgeRes = await adminCtx!.delete(`/api/admin/patients/${mapa.patientId}`);
    expect(purgeRes.status(), 'DELETE /patients/:id purga o paciente is_test (200)').toBe(200);

    expect(
      (await adminCtx!.get(`/api/admin/patients/${mapa.patientId}`)).status(),
      'PROVA 1 — a ficha responde 404',
    ).toBe(404);

    const depoisDoPurge = (await (
      await adminCtx!.post('/api/admin/patients/map', {
        data: { country: 'AR', center: CENTRO_PADRAO, radius_km: 5 },
      })
    ).json()) as MapResponse;
    expect(
      depoisDoPurge.data.filter((p) => p.id === mapa.patientId).length,
      'PROVA 2 — o ponto sumiu do mapa (o endereço foi junto, não ficou órfão)',
    ).toBe(0);
    expect(
      depoisDoPurge.total,
      'PROVA 3 — a contagem do mapa voltou exatamente um ponto para trás',
    ).toBe(antesDoPurge.total - 1);

    mapa.patientId = undefined;
  });
});
