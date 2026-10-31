/**
 * assistants.integration.e2e.ts @integration — spec 080, T168.
 *
 * O widget de assistentes (botao flutuante + painel) visto por uma PESSOA: o que o botao mostra
 * conforme o alcance que o serviço devolve, abrir, conversar, "en breve" e o badge de nao lidas.
 *
 * O SERVIÇO de assistentes (`assistants-service`) e' substituido NA REDE: `page.route` na origem de
 * `VITE_ASSISTANTS_SERVICE_URL` (o Vite do CI nao a define; o app cai em http://localhost:8080 —
 * `resolveAssistantsBaseUrl`) com respostas fixas. Nenhum componente e' mockado, e nada sai para um
 * serviço real. As rotas `/assistants*` nao colidem com `**\/api/**` (o swap de token do login).
 * O login e' o do stack de CI (`loginComoStaffMock`): Identity Toolkit forjado, click + keyboard.type.
 * Os textos de i18n sao lidos de `es.json` (idioma do painel no spec), nunca digitados aqui.
 */
import { test, expect, type Page, type Route, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const STAFF: MockUser = { uid: `e2e-assistants-${RUN_ID}`, email: `e2e-assistants-${RUN_ID}@e2e.test`, role: 'admin', country: 'AR' };

/** Mesma regra do app: sem a variavel, a base do serviço e' http://localhost:8080. */
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
const REPLY_TEXT = `RESPUESTA-FIJA-${RUN_ID}`;
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
    await expect(page.getByTestId('assistants-tab-recruiting')).toHaveCount(0); // 1 assistant: sem tira de abas
    await expect(panel).toContainText('Asistente Reclutamiento');
    await expect(panel.getByTestId('assistants-msg-m-hist')).toHaveText(HISTORY_TEXT);

    const composer = page.getByTestId('assistants-composer');
    await composer.click();
    await expect(composer).toBeFocused();
    await page.keyboard.type(SENT_TEXT);
    await expect(composer).toHaveValue(SENT_TEXT);
    await page.getByTestId('assistants-send').click();

    await expect(panel.getByTestId('assistants-msg-m-reply')).toHaveText(REPLY_TEXT);
    await expect(panel).toContainText(SENT_TEXT); // o que a pessoa digitou ficou na conversa
    await expect(composer).toHaveValue('');
    const post = served.filter((s) => s.method === 'POST' && s.path === '/assistants/recruiting/messages');
    expect(post).toHaveLength(1);
    expect(post[0].body).toEqual({ text: SENT_TEXT });
  });

  test('3 assistants, um available:false: tira de abas com todos, "en breve" so na indisponivel, que nao conversa', async ({ page }) => {
    const served = await stubService(page, [
      assistant('recruiting', 'Asistente Reclutamiento'),
      assistant('admission', 'Asistente Admision', { area: 'Admision' }),
      assistant('billing', 'Asistente Facturacion', { area: null, available: false }),
    ]);
    await enter(page, served);
    await page.getByTestId('assistants-fab').click();

    await expect(page.getByRole('tab')).toHaveCount(3);
    for (const slug of ['recruiting', 'admission', 'billing']) await expect(page.getByTestId(`assistants-tab-${slug}`)).toBeVisible();
    await expect(page.getByTestId('assistants-tab-soon-billing')).toHaveText(tr('comingSoon'));
    await expect(page.getByTestId('assistants-tab-soon-recruiting')).toHaveCount(0);
    await expect(page.getByTestId('assistants-tab-soon-admission')).toHaveCount(0);

    await page.getByTestId('assistants-tab-billing').click();
    await expect(page.getByTestId('assistants-composer')).toBeDisabled();
    await expect(page.getByTestId('assistants-send')).toBeDisabled();
    // "em breve" nao pede historico nem marca lida
    expect(served.filter((s) => s.path === '/assistants/billing/messages')).toHaveLength(0);
    expect(reads(served, 'billing')).toBe(0);
  });

  test('unread_count: 2: o botao mostra "2"; abrir marca lida exatamente 1 vez e o badge some', async ({ page }) => {
    const served = await stubService(page, [assistant('recruiting', 'Asistente Reclutamiento', { unread_count: 2 })]);
    await enter(page, served);

    const badge = page.getByTestId('assistants-badge');
    await expect(badge).toHaveText('2');
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
    await expect(page.getByTestId('assistants-badge')).toHaveText('5');

    await page.getByTestId('assistants-fab').click();
    await expect.poll(() => reads(served, 'recruiting'), { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('assistants-tab-badge-recruiting')).toHaveCount(0);
    await expect(page.getByTestId('assistants-tab-badge-admission')).toHaveText('3');
    expect(reads(served, 'admission')).toBe(0);

    await page.getByTestId('assistants-tab-admission').click();
    await expect.poll(() => reads(served, 'admission'), { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('assistants-tab-badge-admission')).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect(reads(served, 'recruiting')).toBe(1);
    expect(reads(served, 'admission')).toBe(1);

    await page.getByTestId('assistants-close').click();
    await expect(page.getByTestId('assistants-fab')).toBeVisible();
    await expect(page.getByTestId('assistants-badge')).toHaveCount(0);
  });
});
