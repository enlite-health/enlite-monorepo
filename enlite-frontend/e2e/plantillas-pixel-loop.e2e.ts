/**
 * plantillas-pixel-loop.e2e.ts — a MEDIÇÃO da skill `pixel-loop`, aplicada.
 *
 * 🔒 POR QUE ESTE ARQUIVO EXISTE, E O QUE ELE CORRIGE EM MIM.
 *
 * O `CLAUDE.md` do monorepo torna a skill `pixel-loop` obrigatória para "tela
 * nova ou alterada que tem design", e eu não a rodei: construí um comparador
 * próprio, olhei as fotos e declarei semelhança. A skill exige outra coisa —
 * score ESTRUTURAL por propriedade, com tolerância, denominador visível e mapa
 * `alvo ↔ seletor` publicado. "Score sem mapa não vale."
 *
 * ⚠️ ADAPTAÇÃO DECLARADA. A pré-condição dura da skill é o Figma MCP, que está
 * fora do ar nesta sessão. Mas a fonte de verdade desta frente NÃO é Figma: é a
 * maquete HTML de 31/08. Isso não é um substituto pior — é melhor. A skill
 * explica que o score é estrutural justamente porque comparar render WebGL do
 * Figma com o do browser dá 5-20% de ruído. Aqui os dois lados renderizam no
 * MESMO motor, e eu leio `getComputedStyle` dos dois — o ruído some.
 *
 * ⚠️ O QUE NÃO ENTRA NO DENOMINADOR, e por quê (a skill manda documentar em vez
 * de contar): `width`, `x` e `y`. A maquete tem 1180px de largura e o painel
 * tem ~952px de conteúdo, porque o app carrega uma barra lateral de 200px que a
 * maquete não desenha. Comparar largura absoluta produziria reprovação
 * sistemática que não é infidelidade — é contêiner diferente. `height` entra
 * apenas nos controles de altura fixa (botão, campo), que não dependem disso.
 *
 * COMO RODAR:
 *   npx vite --port 5199 --strictPort &
 *   E2E_BASE_URL=http://localhost:5199 npx playwright test \
 *     --config=playwright.mocked.config.ts e2e/plantillas-pixel-loop.e2e.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';
/** Onde a maquete extraída do artefato foi renderizada. */
const DESENHO_DIR = process.env.DESENHO_DIR ?? '';
/** O contêiner de conteúdo do painel (sem a barra lateral). */
const CONTEUDO = '.max-w-\\[1600px\\]';

/**
 * As propriedades comparadas e a tolerância de cada uma — a tabela da skill.
 *
 * `exato` para tipografia e cor: são decisões do desenho, não resultado de
 * layout. `±2px` para caixa, `±1px` para raio e altura de linha, como a skill.
 */
const PROPS = [
  { nome: 'fontSize', tol: 0 },
  { nome: 'fontWeight', tol: 0 },
  { nome: 'lineHeight', tol: 1 },
  { nome: 'letterSpacing', tol: 0.2 },
  { nome: 'color', tol: 0 },
  { nome: 'backgroundColor', tol: 0 },
  { nome: 'borderRadius', tol: 1 },
  { nome: 'paddingTop', tol: 2 },
  { nome: 'paddingRight', tol: 2 },
  { nome: 'paddingBottom', tol: 2 },
  { nome: 'paddingLeft', tol: 2 },
] as const;

interface Medida { [prop: string]: string }

/** Lê as propriedades de um seletor. `null` = elemento AUSENTE (é bloqueante). */
async function medir(page: Page, seletores: Record<string, string>): Promise<Record<string, Medida | null>> {
  return page.evaluate((mapa) => {
    const props = ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color',
      'backgroundColor', 'borderRadius', 'paddingTop', 'paddingRight', 'paddingBottom',
      'paddingLeft', 'height', 'fontFamily'];
    const out: Record<string, Record<string, string> | null> = {};
    for (const [chave, sel] of Object.entries(mapa)) {
      const el = document.querySelector(sel);
      if (!el) { out[chave] = null; continue; }
      const cs = getComputedStyle(el);
      const m: Record<string, string> = {};
      for (const p of props) m[p] = cs[p as keyof CSSStyleDeclaration] as string;
      m.height = String(Math.round(el.getBoundingClientRect().height));
      out[chave] = m;
    }
    return out;
  }, seletores);
}

/** Converte "16px" / "700" / "normal" num número comparável, ou NaN se não for. */
function num(v: string): number {
  if (v === 'normal') return NaN;
  const n = parseFloat(v);
  return Number.isNaN(n) ? NaN : n;
}

interface Falha { el: string; prop: string; desenho: string; app: string; delta?: string; bloqueia: boolean }

/**
 * Compara os dois lados e devolve o score.
 *
 * 🔒 Elemento AUSENTE no app é bloqueante e NÃO é contado como "0 de N props" —
 * ele entra como bloqueio explícito. Diluir uma ausência numa média faria a tela
 * que perdeu um componente inteiro pontuar alto.
 */
function pontuar(
  desenho: Record<string, Medida | null>,
  app: Record<string, Medida | null>,
  alturaFixa: readonly string[],
): { score: number; comparadas: number; falhas: Falha[]; bloqueios: Falha[] } {
  const falhas: Falha[] = [];
  const bloqueios: Falha[] = [];
  let comparadas = 0;
  let dentro = 0;

  for (const chave of Object.keys(desenho)) {
    const d = desenho[chave];
    const a = app[chave];
    if (d === null) continue;                        // seletor errado NO DESENHO: erro meu, não do app
    if (a === null) {
      bloqueios.push({ el: chave, prop: 'existe', desenho: 'presente', app: 'AUSENTE', bloqueia: true });
      continue;
    }
    const lista = alturaFixa.includes(chave)
      ? [...PROPS, { nome: 'height', tol: 2 } as const]
      : PROPS;

    for (const { nome, tol } of lista) {
      comparadas += 1;
      const vd = d[nome]; const va = a[nome];
      const nd = num(vd); const na = num(va);
      /*
       * 🔒 EXCLUSÃO DECLARADA: raio maior que a metade da altura.
       * `border-radius: 100px` e `9999px` num controle de 38px desenham
       * EXATAMENTE a mesma pílula — a diferença de 9899px é aritmética, não
       * visual. É o análogo do que a skill exclui para antialiasing: ruído de
       * rendering nunca é falha. Sem esta regra, os dois botões contribuíam
       * duas reprovações cada por uma diferença que ninguém vê.
       */
      const alturaEl = Math.max(num(d.height), num(a.height)) || 0;
      if (nome === 'borderRadius' && nd >= alturaEl / 2 && na >= alturaEl / 2) { dentro += 1; continue; }
      const ok = Number.isNaN(nd) || Number.isNaN(na)
        ? vd === va
        : Math.abs(nd - na) <= tol;
      if (ok) { dentro += 1; continue; }
      const delta = Number.isNaN(nd) || Number.isNaN(na) ? undefined : `${(na - nd).toFixed(1)}`;
      // Bloqueante: dimensão > 8px de diferença (regra da skill).
      const bloqueia = (nome === 'height' || nome.startsWith('padding'))
        && !Number.isNaN(nd) && !Number.isNaN(na) && Math.abs(na - nd) > 8;
      const f: Falha = { el: chave, prop: nome, desenho: vd, app: va, delta, bloqueia };
      falhas.push(f);
      if (bloqueia) bloqueios.push(f);
    }
  }
  return { score: comparadas === 0 ? 0 : Math.round((dentro / comparadas) * 100), comparadas, falhas, bloqueios };
}

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.pixel.${Date.now()}@test.com`;
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

/**
 * 🔒 `deviceScaleFactor: 1` — regra explícita da skill, e eu tinha usado 2 no
 * comparador anterior. Com 2 as medidas de `getComputedStyle` continuam em CSS
 * px, mas a foto que acompanha o laudo sai noutra escala da maquete, e comparar
 * as duas a olho fica enganoso.
 */
test.use({ viewport: { width: 1200, height: 1500 }, deviceScaleFactor: 1 });

/** Elementos cuja ALTURA é decisão do desenho, não do conteúdo. */
/*
 * ⚠️ O TÍTULO DO CARTÃO NÃO TEM ENTRADA PRÓPRIA, e isso é escolha, não omissão:
 * na maquete ele é um nó de texto solto dentro de `.o`, sem elemento para medir.
 * Quem cobre a escala dele é a ALTURA do cartão — 1px a mais de entrelinha no
 * título muda a altura da caixa, e `cartaoTipoSel` a compara com tolerância 2px.
 */
const ALTURA_FIXA = ['botaoPrimario', 'botaoOutline', 'campoNome', 'chipIdioma', 'abaAtiva',
  'botaoVariavel', 'cartaoTipoSel', 'cartaoTipo', 'cartaoTipoSub', 'linhaSlug', 'seloSlug'];

const RELATORIO: Record<string, ReturnType<typeof pontuar> & { mapa: number }> = {};

test.describe('pixel-loop — medição estrutural contra a maquete de 31/08', () => {
  /**
   * TELA 2 · o compositor. É onde o Gabriel apontou a diferença duas vezes, e
   * onde há mais controles: o maior denominador das quatro.
   */
  test('tela 2 — o compositor', async ({ page, context }) => {
    const MAPA_DESENHO = {
      titulo: '.screen .s-h1',
      subtitulo: '.screen .s-sub',
      rotuloCampo: '.field > label',
      campoNome: '.inp.mono',
      cartaoTipoSel: '.seg .o.sel',
      cartaoTipo: '.seg .o:not(.sel)',
      /*
       * 🔒 O INTERIOR DOS CARTÕES E DAS LINHAS ENTROU NO MAPA em 01/09, porque
       * o Gabriel viu a olho o que este arquivo não media. Eu comparava a CAIXA
       * — padding, raio, borda, tamanho de fonte do botão — e a caixa batia. O
       * que não batia era o que estava dentro dela: o `<Text>` traz a escala
       * própria (12px/1,5) e vencia a do contêiner, então a linha de apoio saía
       * a 12px/18px onde o desenho pede 10,5px/14,2px, e a linha do slug caía
       * no 16px/24px do body. 99% de score numa tela visivelmente diferente é
       * denominador estreito, não fidelidade — a régua mede o que está no mapa.
       */
      cartaoTipoSub: '.seg .o.sel small',
      linhaSlug: '.slugpair .row',
      seloSlug: '.slugpair .row .pre',
      chipIdioma: '.langpick .l.sel',
      abaAtiva: '.tabs .tb.act',
      botaoVariavel: '.varbar button',
      editor: '.editor',
      dica: '.field .hint',
      botaoOutline: '.actions .s-btn.outline',
      botaoPrimario: '.actions .s-btn.primary',
      cartaoChecklist: '.check',
      tituloChecklist: '.check .ttl',
    };
    const MAPA_APP = {
      titulo: 'h1',
      subtitulo: 'h1 + p',
      rotuloCampo: 'label[for="td-base"]',
      campoNome: '#td-base',
      cartaoTipoSel: '[data-testid="td-tipo-aviso"]',
      cartaoTipo: '[data-testid="td-tipo-invitacion"]',
      cartaoTipoSub: '[data-testid="td-tipo-aviso"] > span:nth-child(2)',
      linhaSlug: '[data-testid="td-par-slug-es-AR"]',
      seloSlug: '[data-testid="td-par-slug-es-AR"] > span:first-child',
      chipIdioma: '[data-testid="td-idioma-es-AR"]',
      abaAtiva: '[data-testid="td-aba-es-AR"]',
      botaoVariavel: '[data-testid="td-inserir-worker_name"]',
      editor: '#td-body',
      dica: 'label[for="td-base"] ~ p',
      botaoOutline: '[data-testid="td-salvar"]',
      botaoPrimario: '[data-testid="td-revisar-enviar"]',
      cartaoChecklist: '[data-testid="td-checklist"]',
      tituloChecklist: '[data-testid="td-checklist"] > div:first-child',
    };

    // ── lado do DESENHO ──
    const pd = await context.newPage();
    await pd.goto(`file://${DESENHO_DIR}/2-compositor.html`);
    await pd.waitForLoadState('networkidle');
    const desenho = await medir(pd, MAPA_DESENHO);
    await pd.close();

    // ── lado do APP ──
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-drafts/validar', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { slug: 'ar_x', bloqueios: [], avisos: [] } }) }));
    await page.route('**/api/admin/template-drafts', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [] } }) }));
    await page.goto('/admin/plantillas/registrar');
    await expect(page.getByTestId('td-form')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('td-input-slug').fill('bienvenida_contratacion');
    await page.getByTestId('td-input-body').fill('Hola, texto de prueba para medir.');
    const app = await medir(page, MAPA_APP);

    const comp = await page.evaluate((seletorConteudo) => {
      const r = (sel: string) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
      const cont = r(seletorConteudo);
      // ⚠️ O ELEMENTO, não o retângulo: `r()` devolve DOMRect, que não tem
      // `.children`. Erro meu, e o teste morreu em vez de mentir — como deve.
      const grade = document.querySelector('[data-testid="td-form"]');
      const esq = grade?.children[0]?.getBoundingClientRect() ?? null;
      const dir = grade?.children[1]?.getBoundingClientRect() ?? null;
      const blocos = [...document.querySelectorAll('[data-testid="td-form"] > div:first-child > div')];
      const gaps = [];
      for (let i = 1; i < blocos.length; i++) {
        gaps.push(Math.round(blocos[i].getBoundingClientRect().top - blocos[i-1].getBoundingClientRect().bottom));
      }
      return {
        alturaConteudo: cont ? Math.round(cont.height) : -1,
        colEsq: esq ? Math.round(esq.width) : -1, colDir: dir ? Math.round(dir.width) : -1,
        gapsEntreCampos: gaps,
        fimEsq: esq && cont ? Math.round(esq.bottom - cont.top) : -1,
        fimDir: dir && cont ? Math.round(dir.bottom - cont.top) : -1,
        blocosExtras: [
          document.querySelector('[data-testid="td-aviso-perimetro"]') ? 'aviso-perimetro' : null,
          document.querySelector('[data-testid="td-lista"]') || document.querySelector('[data-testid="td-vazio"]') ? 'borradores-guardados' : null,
        ].filter(Boolean),
      };
    }, CONTEUDO);
    console.log('COMP>>>', JSON.stringify(comp));
    const r = pontuar(desenho, app, ALTURA_FIXA);
    RELATORIO['tela 2 · compositor'] = { ...r, mapa: Object.keys(MAPA_DESENHO).length };
    console.log('PIXELLOOP>>>', JSON.stringify({ tela: 'tela 2 · compositor', mapa: Object.keys(MAPA_DESENHO).length, ...r }));
  });

  test('tela 4 — o detalhe', async ({ page, context }) => {
    const MAPA_DESENHO = {
      titulo: '.screen .s-h1',
      subtitulo: '.screen .s-sub',
      selo: '.screen .pill.p-rej',
      marcoTitulo: '.tl .bd b',
      marcoData: '.tl .bd span',
      citacao: '.tl .bd .quote',
      cartaoAcoes: '.det .check',
      tituloAcoes: '.det .check .ttl',
      itemAcao: '.det .check li',
      botaoPrimario: '.det .s-btn.primary',
      botaoOutline: '.det .s-btn.outline',
    };
    const MAPA_APP = {
      titulo: 'h1',
      subtitulo: 'h1 + p',
      // ⚠️ A CAIXA, não o texto dentro dela. A 1ª versão mapeava o `<span>`
      // interno contra o `.pill` inteiro do desenho: padding, fundo e raio
      // davam zero e o medidor acusava 5 bloqueantes que eram erro MEU.
      selo: '[data-testid="tc-detalhe-selo"]',
      marcoTitulo: '[data-testid="tc-detalhe-evento-criado"] p:first-child',
      marcoData: '[data-testid="tc-detalhe-evento-criado"] p:nth-child(2)',
      citacao: '[data-testid="tc-detalhe-citacao"]',
      cartaoAcoes: '[data-testid="tc-detalhe-que-fazer"]',
      tituloAcoes: '[data-testid="tc-detalhe-que-fazer"] > p:first-child',
      itemAcao: '[data-testid="tc-detalhe-que-fazer"] li',
      /*
       * O ALVO É O PAPEL, não um testid fixo: "o botão cheio da coluna de
       * ações". Quem o desempenha muda com o estado — sem rascunho é o
       * "duplicar y corregir" do catálogo; com um rascunho já submetido é o
       * "duplicar" que clona a linha do banco. A maquete desenha UM botão cheio
       * ali, e a régua tem de achar o que estiver fazendo esse papel.
       */
      botaoPrimario: '[data-testid="tc-detalhe-duplicar"], [data-testid="tc-rascunho-duplicar"]',
      botaoOutline: '[data-testid="tc-detalhe-twilio"]',
    };

    const pd = await context.newPage();
    await pd.goto(`file://${DESENHO_DIR}/4-detalhe.html`);
    await pd.waitForLoadState('networkidle');
    const desenho = await medir(pd, MAPA_DESENHO);
    await pd.close();

    await loginAsAdmin(page);
    await page.route('**/api/admin/template-catalog', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { templates: [{
        slug: 'ar_x', name: 'ar_x', language: 'es-AR', baseName: 'x',
        bodyTwilio: 'Recordá completar tu registro para acceder a las vacantes.',
        category: 'MARKETING', isActive: true, contentSid: 'HXa',
        metaStatus: 'REJECTED', metaReason: 'INVALID_FORMAT',
        metaDetail: 'Tu plantilla tiene parámetros pegados uno al otro.',
        metaCheckedAt: '2026-05-19T12:34:00Z', eligible: false,
        ineligibleReason: 'PLACEHOLDERS', placeholders: ['1'], usedInStages: [], isDraft: false,
      }] } }) }));
    await page.route('**/api/admin/template-drafts', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [{
        id: 'i', slug: 'ar_x', baseName: 'x', name: 'x', body: 'b', category: 'MARKETING',
        language: 'es-AR', version: 1, createdBy: 'Ana', updatedBy: 'Ana',
        createdAt: '2026-05-18T14:04:00Z', updatedAt: '2026-05-18T14:04:00Z',
        contentSid: null, submittedAt: '2026-05-19T12:20:00Z', submittedBy: 'Ana',
        submissionError: null, metaStatus: null, metaReason: null, metaDetail: null,
        metaCheckedAt: null, status: 'submitted',
      }] } }) }));
    await page.goto('/admin/plantillas/ar_x');
    await expect(page.getByTestId('tc-detalhe-timeline')).toBeVisible({ timeout: 30_000 });
    const app = await medir(page, MAPA_APP);

    const r = pontuar(desenho, app, ['botaoPrimario', 'botaoOutline', 'selo']);
    RELATORIO['tela 4 · detalhe'] = { ...r, mapa: Object.keys(MAPA_DESENHO).length };
    console.log('PIXELLOOP>>>', JSON.stringify({ tela: 'tela 4 · detalhe', mapa: Object.keys(MAPA_DESENHO).length, ...r }));
  });

  test.afterAll(() => {
    console.log('RESUMO>>>', JSON.stringify(RELATORIO));
  });
});
