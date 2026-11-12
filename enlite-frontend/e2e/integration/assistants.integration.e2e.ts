/**
 * assistants.integration.e2e.ts @integration — spec 080, T168.
 *
 * O widget de assistentes (botao flutuante + painel) visto por uma PESSOA: o que o botao mostra
 * conforme o alcance que o serviço devolve, abrir, conversar, "en breve" e o badge de nao lidas.
 *
 * O SERVIÇO de assistentes (`assistants-service`) e' substituido NA REDE: `page.route` na origem de
 * `VITE_ASSISTANTS_SERVICE_URL` (o Vite do CI a define como http://localhost:8080 em
 * `_frontend-integration.yml`; sem ela o app NAO faz fetch) com respostas fixas. Nenhum componente e' mockado, e nada sai para um
 * serviço real. As rotas `/assistants*` nao colidem com `**\/api/**` (o swap de token do login).
 * O login e' o do stack de CI (`loginComoStaffMock`): Identity Toolkit forjado, click + keyboard.type.
 * Os textos de i18n sao lidos de `es.json` (idioma do painel no spec), nunca digitados aqui.
 */
import { test, expect, type Page, type Route, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
// Contra a plataforma real o uid precisa existir em users/iam.user_groups: E2E_ASSISTANTS_UID/_EMAIL apontam o semeado.
const STAFF: MockUser = { uid: process.env.E2E_ASSISTANTS_UID || `e2e-assistants-${RUN_ID}`, email: process.env.E2E_ASSISTANTS_EMAIL || `e2e-assistants-${RUN_ID}@e2e.test`, role: 'admin', country: 'AR' };

/** Origem do serviço: a do Vite do CI (http://localhost:8080); localmente, suba o Vite com a mesma variavel. */
const SERVICE_ORIGIN = new URL(process.env.VITE_ASSISTANTS_SERVICE_URL || 'http://localhost:8080').origin;

const I18N = JSON.parse(readFileSync('src/infrastructure/i18n/locales/es.json', 'utf8')).admin.assistants as Record<string, string>;
const tr = (key: string, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [k, v]) => s.replace(`{{${k}}}`, String(v)), I18N[key]);

interface StubAssistant {
  slug: string;
  name: string;
  role: 'MANAGER';
  area: string | null;
  available: boolean;
  last_at: string | null;
  unread_count: number;
}
const assistant = (slug: string, name: string, over: Partial<StubAssistant> = {}): StubAssistant => ({
  slug, name, role: 'MANAGER', area: 'Reclutamiento', available: true, last_at: null, unread_count: 0, ...over,
});

const HISTORY_TEXT = `HISTORIAL-FIJO-${RUN_ID}`;
const REPLY_BOLD = `RESPUESTA-FIJA-${RUN_ID}`;
// A resposta do assistente chega em markdown (negrito + bullets com `*`) e deve aparecer renderizada.
const REPLY_TEXT = `**${REPLY_BOLD}**\n\n* item uno\n* item dos`;
const SENT_TEXT = `Hola ${RUN_ID}`;

interface Served { method: string; path: string; body: unknown }

/**
 * O serviço falso. Registra cada chamada recebida (metodo, caminho, corpo) e responde no formato do
 * contrato: `GET /assistants` -> `{assistants}`; `GET /assistants/:slug/messages` -> `{conversation_id, messages}`;
 * `POST /assistants/:slug/messages` -> `{conversation_id, message, turn}`; `POST /assistants/:slug/read` -> 204.
 * O navegador chama de outra origem, entao o preflight (OPTIONS) e os cabecalhos CORS tambem sao respondidos.
 */
async function stubService(page: Page, reach: StubAssistant[]): Promise<Served[]> {
  const served: Served[] = [];
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
  await page.route(
    (url) => url.origin === SERVICE_ORIGIN && (url.pathname === '/assistants' || url.pathname.startsWith('/assistants/')),
    async (route: Route, request: Request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      served.push({ method: request.method(), path, body: request.postDataJSON() });
      const json = (status: number, body: unknown) =>
        route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
      if (request.method() === 'GET' && path === '/assistants') return json(200, { assistants: reach });
      if (path.endsWith('/read')) return route.fulfill({ status: 204, headers: cors });
      if (path.endsWith('/messages') && request.method() === 'GET') {
        return json(200, {
          conversation_id: 'conv-1',
          messages: [{ id: 'm-hist', author: 'ASSISTANT', text: HISTORY_TEXT, tools: [], validator: null, created_at: '2026-10-30T10:00:00.000Z' }],
        });
      }
      if (path.endsWith('/messages') && request.method() === 'POST') {
        return json(200, {
          conversation_id: 'conv-1',
          message: { id: 'm-reply', author: 'ASSISTANT', text: REPLY_TEXT, tools: [], validator: null, created_at: '2026-10-30T10:01:00.000Z' },
          turn: { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
        });
      }
      return json(404, { success: false, code: 'UNKNOWN', message: 'unexpected route in the stub' });
    },
  );
  return served;
}

const lists = (served: Served[]) => served.filter((s) => s.method === 'GET' && s.path === '/assistants').length;
const reads = (served: Served[], slug: string) => served.filter((s) => s.method === 'POST' && s.path === `/assistants/${slug}/read`).length;

/** Entra pela tela de login e espera o menu do painel (a prova de que o layout, onde mora o widget, montou). */
async function enter(page: Page, served: Served[]): Promise<void> {
  await loginComoStaffMock(page, STAFF, 'E2E Assistants');
  await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 30_000 });
  // A lista foi pedida E respondida: so' depois disso "sem botao" quer dizer "o serviço disse vazio", nao "ainda nao carregou".
  await expect.poll(() => lists(served), { timeout: 15_000 }).toBeGreaterThan(0);
}

test.use({ viewport: { width: 1280, height: 900 } });

test.describe('Assistentes no app — o widget que a pessoa ve @integration', () => {
  test.setTimeout(120_000);

  test('alcance vazio: o serviço responde `assistants: []` e NAO existe botao', async ({ page }) => {
    const served = await stubService(page, []);
    await enter(page, served);
    await expect(page.getByTestId('assistants-fab')).toHaveCount(0);
    await expect(page.getByTestId('assistants-panel')).toHaveCount(0);
  });

  test('1 assistant: botao -> conversa com historico -> envio com click + keyboard.type -> a resposta do serviço aparece', async ({ page }) => {
    const served = await stubService(page, [assistant('recruiting', 'Asistente Reclutamiento')]);
    await enter(page, served);

    const fab = page.getByTestId('assistants-fab');
    await expect(fab).toBeVisible();
    await expect(fab).toContainText(tr('button'));
    await expect(page.getByTestId('assistants-badge')).toHaveCount(0);
    await fab.click();

    const panel = page.getByTestId('assistants-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('assistants-tab-recruiting')).toHaveCount(0); // 1 assistant: sem seletor
    await expect(page.getByTestId('assistants-picker')).toHaveCount(0);
    await expect(page.getByTestId('assistants-minimize')).toHaveCount(0); // so' "fechar"
    await expect(panel).toContainText('Asistente Reclutamiento');
    await expect(panel.getByTestId('assistants-msg-m-hist')).toHaveText(HISTORY_TEXT);

    const composer = page.getByTestId('assistants-composer');
    await composer.click();
    await expect(composer).toBeFocused();
    await page.keyboard.type(SENT_TEXT);
    await expect(composer).toHaveValue(SENT_TEXT);
    await page.getByTestId('assistants-send').click();

    const reply = panel.getByTestId('assistants-msg-m-reply');
    await expect(reply.locator('strong')).toHaveText(REPLY_BOLD);
    await expect(reply.locator('li')).toHaveCount(2);
    await expect(reply).not.toContainText('**');
    await expect(reply).not.toContainText('* item');
    await expect(panel).toContainText(SENT_TEXT); // o que a pessoa digitou ficou na conversa
    await expect(composer).toHaveValue('');
    const post = served.filter((s) => s.method === 'POST' && s.path === '/assistants/recruiting/messages');
    expect(post).toHaveLength(1);
    expect(post[0].body).toEqual({ text: SENT_TEXT });
  });

  test('3 assistants, um available:false: lista (seletor) com todos, "en breve" so na indisponivel, que nao conversa', async ({ page }) => {
    const served = await stubService(page, [
      assistant('recruiting', 'Asistente Reclutamiento'),
      assistant('admission', 'Asistente Admision', { area: 'Admision' }),
      assistant('billing', 'Asistente Facturacion', { area: null, available: false }),
    ]);
    await enter(page, served);
    await page.getByTestId('assistants-fab').click();

    await expect(page.getByRole('tab')).toHaveCount(0); // a tira de abas saiu: o seletor a substitui
    await page.getByTestId('assistants-picker').click();
    await expect(page.getByRole('option')).toHaveCount(3);
    for (const slug of ['recruiting', 'admission', 'billing']) await expect(page.getByTestId(`assistants-tab-${slug}`)).toBeVisible();
    await expect(page.getByTestId('assistants-tab-soon-billing')).toHaveText(tr('comingSoon'));
    await expect(page.getByTestId('assistants-tab-soon-recruiting')).toHaveCount(0);
    await expect(page.getByTestId('assistants-tab-soon-admission')).toHaveCount(0);

    await page.getByTestId('assistants-tab-billing').click(); // item da lista; escolher fecha a lista
    await expect(page.getByTestId('assistants-composer')).toBeDisabled();
    await expect(page.getByTestId('assistants-send')).toBeDisabled();
    // "em breve" nao pede historico nem marca lida
    expect(served.filter((s) => s.path === '/assistants/billing/messages')).toHaveLength(0);
    expect(reads(served, 'billing')).toBe(0);
  });

  test('unread_count: 2: o botao mostra o ponto (aria-label de 2); abrir marca lida exatamente 1 vez e o badge some', async ({ page }) => {
    const served = await stubService(page, [assistant('recruiting', 'Asistente Reclutamiento', { unread_count: 2 })]);
    await enter(page, served);

    const badge = page.getByTestId('assistants-badge'); // ponto vermelho: sem numero, o total vai no aria-label
    await expect(badge).toHaveText('');
    await expect(badge).toHaveAttribute('aria-label', tr('unreadBadge', { count: 2 }));
    expect(reads(served, 'recruiting')).toBe(0); // so' o botao na tela: ainda nao esta lida

    await page.getByTestId('assistants-fab').click();
    await expect.poll(() => reads(served, 'recruiting'), { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(1_000); // um segundo POST (efeito repetido) chegaria aqui
    expect(reads(served, 'recruiting')).toBe(1);

    await page.getByTestId('assistants-close').click();
    await expect(page.getByTestId('assistants-fab')).toBeVisible();
    await expect(page.getByTestId('assistants-badge')).toHaveCount(0);
  });

  test('2 abas com nao lidas: a aba aberta marca lida so' + ' ela; trocar de aba marca a outra; cada uma 1 vez', async ({ page }) => {
    const served = await stubService(page, [
      assistant('recruiting', 'Asistente Reclutamiento', { unread_count: 2 }),
      assistant('admission', 'Asistente Admision', { area: 'Admision', unread_count: 3 }),
    ]);
    await enter(page, served);
    await expect(page.getByTestId('assistants-badge')).toHaveAttribute('aria-label', tr('unreadBadge', { count: 5 }));

    await page.getByTestId('assistants-fab').click();
    await expect.poll(() => reads(served, 'recruiting'), { timeout: 10_000 }).toBe(1);
    await page.getByTestId('assistants-picker').click(); // os contadores por assistente vivem na lista
    await expect(page.getByTestId('assistants-tab-badge-recruiting')).toHaveCount(0);
    await expect(page.getByTestId('assistants-tab-badge-admission')).toHaveText('3');
    expect(reads(served, 'admission')).toBe(0);

    await page.getByTestId('assistants-tab-admission').click();
    await expect.poll(() => reads(served, 'admission'), { timeout: 10_000 }).toBe(1);
    await page.getByTestId('assistants-picker').click();
    await expect(page.getByTestId('assistants-tab-badge-admission')).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect(reads(served, 'recruiting')).toBe(1);
    expect(reads(served, 'admission')).toBe(1);

    await page.getByTestId('assistants-close').click();
    await expect(page.getByTestId('assistants-fab')).toBeVisible();
    await expect(page.getByTestId('assistants-badge')).toHaveCount(0);
  });
});

test.describe('Botao flutuante em posicao livre (090) @integration', () => {
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1280, height: 800 } });

  const FAB_KEY = 'enlite.assistants.fabPosition.v1';
  const TOL = 2;
  type Box = { x: number; y: number; width: number; height: number };

  async function box(page: Page, testId: string): Promise<Box> {
    const b = await page.getByTestId(testId).boundingBox();
    if (!b) throw new Error(`${testId} sem boundingBox`);
    return b;
  }

  /** Arrasta pelo centro do botao ate o ponto em que o canto sup. esquerdo dele fica em (left, top). */
  async function dragFabTo(page: Page, left: number, top: number): Promise<void> {
    const b = await box(page, 'assistants-fab');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(left + b.width / 2, top + b.height / 2, { steps: 10 });
    await page.mouse.up();
  }

  async function setup(page: Page): Promise<void> {
    const served = await stubService(page, [assistant('recruiting', 'Asistente Reclutamiento')]);
    await enter(page, served);
    await expect(page.getByTestId('assistants-fab')).toBeVisible();
    await page.evaluate(() => window.localStorage.clear());
  }

  const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOL);

  test('090 — E1: arrastar o botao para o canto sup. esquerdo nao abre; o clique abre o painel a partir dele, inteiro na tela', async ({ page }) => {
    await setup(page);
    await dragFabTo(page, 40, 40);
    await expect(page.getByTestId('assistants-panel')).toHaveCount(0); // arraste nao abre
    const fab = await box(page, 'assistants-fab');
    near(fab.x, 40);
    near(fab.y, 40);

    await page.getByTestId('assistants-fab').click();
    const panel = page.getByTestId('assistants-panel');
    await expect(panel).toBeVisible();
    await page.screenshot({ path: 'test-results/090-e1.png' });
    const p = await box(page, 'assistants-panel');
    near(p.y, fab.y);
    near(p.x, fab.x);
    expect(p.x).toBeGreaterThanOrEqual(16 - TOL);
    expect(p.y).toBeGreaterThanOrEqual(16 - TOL);
    expect(p.x + p.width).toBeLessThanOrEqual(1264 + TOL);
    expect(p.y + p.height).toBeLessThanOrEqual(784 + TOL);
  });

  test('090 — E2: mover 3px e soltar e clique: o painel abre no canto padrao', async ({ page }) => {
    await setup(page);
    const b = await box(page, 'assistants-fab');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 3, b.y + b.height / 2);
    await page.mouse.up();

    await expect(page.getByTestId('assistants-panel')).toBeVisible();
    const p = await box(page, 'assistants-panel');
    near(p.x + p.width, 1264);
    near(p.y + p.height, 784);
  });

  test('090 — E3: a posicao sobrevive ao reload; "Volver a la esquina" volta ao canto e a escolha tambem sobrevive', async ({ page }) => {
    await setup(page);
    await dragFabTo(page, 300, 300);
    const moved = await box(page, 'assistants-fab');
    near(moved.x, 300);
    near(moved.y, 300);
    expect(await page.evaluate((k) => window.localStorage.getItem(k), FAB_KEY)).not.toBeNull();

    await page.reload();
    await expect(page.getByTestId('assistants-fab')).toBeVisible({ timeout: 30_000 });
    const after = await box(page, 'assistants-fab');
    near(after.x, moved.x);
    near(after.y, moved.y);

    await page.getByTestId('assistants-fab').click();
    await expect(page.getByTestId('assistants-panel')).toBeVisible();
    await page.getByTestId('assistants-reset-position').click();
    await expect(page.getByTestId('assistants-panel')).toBeVisible(); // nao fecha
    await expect.poll(async () => { const p = await box(page, 'assistants-panel'); return Math.abs(p.x + p.width - 1264) <= TOL && Math.abs(p.y + p.height - 784) <= TOL; }).toBe(true);

    await page.getByTestId('assistants-close').click();
    await expect(page.getByTestId('assistants-fab')).toBeVisible();
    const home = await box(page, 'assistants-fab');
    near(home.x + home.width, 1264);
    near(home.y + home.height, 784);

    await page.reload();
    await expect(page.getByTestId('assistants-fab')).toBeVisible({ timeout: 30_000 });
    const home2 = await box(page, 'assistants-fab');
    near(home2.x + home2.width, 1264);
    near(home2.y + home2.height, 784);
    await page.getByTestId('assistants-fab').click();
    await expect(page.getByTestId('assistants-panel')).toBeVisible();
    await expect(page.getByTestId('assistants-reset-position')).toHaveCount(0);
  });

  test('090 — E4: encolher a janela reajusta o botao para dentro da tela', async ({ page }) => {
    await setup(page);
    await dragFabTo(page, 1100, 400);
    const b = await box(page, 'assistants-fab');
    near(b.x, 1100);

    await page.setViewportSize({ width: 800, height: 600 });
    await expect.poll(async () => {
      const f = await box(page, 'assistants-fab');
      return f.x >= 16 - TOL && f.y >= 16 - TOL && f.x + f.width <= 784 + TOL && f.y + f.height <= 584 + TOL;
    }).toBe(true);
  });
});
