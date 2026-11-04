/**
 * luz-prueba.integration.e2e.ts @integration — spec 086, F3 (CA-7, CA-8, CA-9).
 *
 * A aba "Luz (prueba)" do widget de assistentes vista por uma PESSOA. O triage real NAO existe no CI, entao a
 * rota `POST /api/admin/luz-prueba/turn` e' substituida NA REDE (`page.route`) com respostas fixas no formato do
 * contrato (§9.2); o `assistants-service` tambem (mesmo molde de `assistants.integration.e2e.ts`). Nenhum componente
 * e' mockado e nada sai para um servico real. O login e' o do stack de CI (`loginComoStaffMock`: Identity Toolkit
 * forjado, click + keyboard.type); a CELULA vem de `/v1/me/authz` (o engine do job padrao esta OFF), pela opcao
 * `permissions` do helper — o que se prova e' o que a PESSOA ve conforme a celula `luz_prueba:chat`.
 * Textos lidos de `es.json` (idioma do painel no spec), nunca digitados aqui.
 *
 * Baseline visual: `toHaveScreenshot` segue a convencao do repo (baseline `*-darwin.png` em
 * `luz-prueba.integration.e2e.ts-snapshots/`, gerada a mao no macOS com `--update-snapshots`; o CI roda com
 * `--ignore-snapshots`, portanto mede comportamento, nao pixel).
 *
 * Run (stack do CI ou local com Vite):
 *   VITE_ASSISTANTS_SERVICE_URL=http://localhost:8080 pnpm exec playwright test --project=integration --grep luz-prueba
 */
import { test, expect, type Page, type Route, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const SERVICE_ORIGIN = new URL(process.env.VITE_ASSISTANTS_SERVICE_URL || 'http://localhost:8080').origin;
const TURN_PATH = '/api/admin/luz-prueba/turn';

const I18N = JSON.parse(readFileSync('src/infrastructure/i18n/locales/es.json', 'utf8')).admin.luzPrueba as Record<string, string>;
const tr = (key: string, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [k, v]) => s.replace(`{{${k}}}`, String(v)), I18N[key]);

const user = (tag: string): MockUser => ({ uid: `e2e-luz-prueba-${tag}-${RUN_ID}`, email: `e2e-luz-prueba-${tag}-${RUN_ID}@e2e.test`, role: 'admin', country: 'AR' });

const assistant = (slug: string, name: string) => ({
  slug, name, role: 'MANAGER', area: 'Reclutamiento', available: true, last_at: null, unread_count: 0,
});

/** O assistants-service falso: so' o que o widget pede ao abrir (lista, historico vazio, lida). Devolve quantas listas foram pedidas. */
async function stubAssistants(page: Page, reach: ReturnType<typeof assistant>[]): Promise<{ lists: () => number }> {
  let lists = 0;
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  await page.route(
    (url) => url.origin === SERVICE_ORIGIN && (url.pathname === '/assistants' || url.pathname.startsWith('/assistants/')),
    async (route: Route, request: Request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (path.endsWith('/read')) return route.fulfill({ status: 204, headers: cors });
      const json = (body: unknown) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/assistants') {
        lists += 1;
        return json({ assistants: reach });
      }
      return json({ conversation_id: null, messages: [] });
    },
  );
  return { lists: () => lists };
}

interface TurnCall { sessao: string; mensagem: string; historico: { role: string; content: string }[] }

/** A rota do turno: responde 200 fixo e guarda o corpo recebido. */
async function stubTurn(page: Page, texto: string): Promise<TurnCall[]> {
  const calls: TurnCall[] = [];
  await page.route(`**${TURN_PATH}`, async (route: Route, request: Request) => {
    calls.push(request.postDataJSON() as TurnCall);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tipo: 'reply',
        texto,
        ferramentas: [
          { nome: 'get_worker_status', ok: true, prueba: false },
          { nome: 'apply_to_vacancy', ok: true, prueba: true },
        ],
        validadores: ['notario:x'],
        prestadora: { nome: 'Prueba Luz PRUEBA' },
      }),
    });
  });
  return calls;
}

async function digitarEEnviar(page: Page, texto: string, how: 'click' | 'enter' = 'click'): Promise<void> {
  const box = page.getByTestId('luz-prueba-input');
  await box.click();
  await expect(box).toBeFocused();
  await page.keyboard.type(texto);
  await expect(box).toHaveValue(texto);
  if (how === 'click') await page.getByTestId('luz-prueba-send').click();
  else await page.keyboard.press('Enter');
}

async function abrirAbaPrueba(page: Page): Promise<void> {
  await expect(page.getByTestId('assistants-fab')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('assistants-fab').click();
  await page.getByTestId('assistants-picker').click();
  await page.getByTestId('assistants-tab-luz-prueba').click();
  await expect(page.getByTestId('luz-prueba-header')).toBeVisible();
}

test.use({ viewport: { width: 1280, height: 900 } });

test.describe('Luz (prueba) no app — a aba que a pessoa ve @integration', () => {
  test.setTimeout(120_000);

  test('CA-7 feliz: Master abre a aba, ve o cabecalho, envia (click + keyboard.type) e ve resposta, ferramenta simulada e cabecalho com o nome', async ({ page }) => {
    const u = user('ca7');
    const resposta = `RESPUESTA-LUZ-${RUN_ID}`;
    await stubAssistants(page, [assistant('recruiting', 'Asistente Reclutamiento')]);
    const calls = await stubTurn(page, resposta);
    await loginComoStaffMock(page, u, 'E2E LuzPrueba', { permissions: ['luz_prueba:chat', 'assistant_maria:chat'] });

    await abrirAbaPrueba(page);
    const panel = page.getByTestId('assistants-panel');
    const header = page.getByTestId('luz-prueba-header');
    await expect(header).toHaveText(tr('headerGeneric')); // antes do 1o turno: texto generico
    await expect(page.getByTestId('assistants-composer')).toHaveCount(0); // a aba da Maria saiu de cena

    const texto = `Hola ${RUN_ID}`;
    await digitarEEnviar(page, texto);

    const msgs = page.getByTestId('luz-prueba-msg');
    await expect(msgs).toHaveCount(2);
    await expect(msgs.nth(0)).toHaveText(texto);
    await expect(msgs.nth(0)).toHaveAttribute('data-role', 'user');
    await expect(msgs.nth(1)).toHaveText(resposta);
    await expect(msgs.nth(1)).toHaveAttribute('data-role', 'assistant');
    const tools = page.getByTestId('luz-prueba-tools');
    await expect(tools).toContainText('(prueba) apply_to_vacancy — ok simulado');
    await expect(tools).toContainText('get_worker_status — ok');
    await expect(tools).toContainText('notario:x');
    await expect(header).toHaveText(tr('header', { nome: 'Prueba Luz PRUEBA' }));
    await expect(page.getByTestId('luz-prueba-input')).toHaveValue('');

    expect(calls).toHaveLength(1);
    expect(calls[0].mensagem).toBe(texto);
    expect(calls[0].historico).toEqual([]);
    expect(calls[0].sessao).toMatch(/^[A-Za-z0-9_-]{1,40}$/);

    // `maxDiffPixelRatio`: a resposta e a mensagem carregam o RUN_ID; o painel inteiro e' a foto.
    await expect(panel).toHaveScreenshot('luz-prueba-resposta.png', { animations: 'disabled', maxDiffPixelRatio: 0.02, mask: [msgs.nth(0), msgs.nth(1)] });
  });

  test('CA-8 sem a celula: a aba NAO existe no DOM e nenhuma request vai a /luz-prueba', async ({ page }) => {
    const u = user('ca8');
    const lista = await stubAssistants(page, [assistant('recruiting', 'Asistente Reclutamiento'), assistant('admission', 'Asistente Admision')]);
    const pedidosPrueba: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.includes('/luz-prueba')) pedidosPrueba.push(r.url());
    });
    await stubTurn(page, 'NO-DEBE-LLEGAR'); // se alguma request saisse, esta rota a contaria em `calls`
    await loginComoStaffMock(page, u, 'E2E LuzPrueba', { permissions: ['assistant_maria:chat'] });
    // A lista foi pedida E respondida: so' depois disso "sem aba" quer dizer "a pessoa nao tem a celula", nao "ainda nao carregou".
    await expect.poll(lista.lists, { timeout: 15_000 }).toBeGreaterThan(0);

    await page.getByTestId('assistants-fab').click();
    await page.getByTestId('assistants-picker').click();
    await expect(page.getByRole('option')).toHaveCount(2); // so' os assistentes do alcance
    await expect(page.getByTestId('assistants-tab-luz-prueba')).toHaveCount(0);
    await expect(page.getByText('Luz (prueba)')).toHaveCount(0);
    await expect(page.getByTestId('luz-prueba-header')).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect(pedidosPrueba).toEqual([]);
  });

  test('CA-9 reiniciar: 2 turnos, "Reiniciar conversa", lista vazia, 3o turno com historico vazio e sessao nova', async ({ page }) => {
    const u = user('ca9');
    await stubAssistants(page, [assistant('recruiting', 'Asistente Reclutamiento')]);
    const calls = await stubTurn(page, `RESPUESTA-${RUN_ID}`);
    await loginComoStaffMock(page, u, 'E2E LuzPrueba', { permissions: ['luz_prueba:chat', 'assistant_maria:chat'] });
    await abrirAbaPrueba(page);

    await digitarEEnviar(page, 'uno');
    await expect(page.getByTestId('luz-prueba-msg')).toHaveCount(2);
    await digitarEEnviar(page, 'dos', 'enter');
    await expect(page.getByTestId('luz-prueba-msg')).toHaveCount(4);
    expect(calls).toHaveLength(2);
    expect(calls[1].historico).toEqual([
      { role: 'user', content: 'uno' },
      { role: 'assistant', content: `RESPUESTA-${RUN_ID}` },
    ]);
    expect(calls[1].sessao).toBe(calls[0].sessao);

    await page.getByTestId('luz-prueba-reset').click();
    await expect(page.getByTestId('luz-prueba-msg')).toHaveCount(0);
    await expect(page.getByTestId('luz-prueba-header')).toHaveText(tr('headerGeneric'));

    await digitarEEnviar(page, 'tres');
    await expect(page.getByTestId('luz-prueba-msg')).toHaveCount(2);
    expect(calls).toHaveLength(3);
    expect(calls[2].mensagem).toBe('tres');
    expect(calls[2].historico).toEqual([]);
    expect(calls[2].sessao).not.toBe(calls[0].sessao);
    expect(calls[2].sessao).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });
});
