/**
 * luz-prueba.integration.e2e.ts @integration — spec 086, F3 (CA-7, CA-8, CA-9): a aba "Luz (prueba)" do widget de assistentes vista por uma PESSOA.
 *
 * SEM mock de dado e SEM interceptação de rede: engine ABAC LIGADO, staff REAL em grupo e a célula `luz_prueba:chat` concedida por SQL (`grantCell`);
 * a rota `POST /api/admin/luz-prueba/turn`, a célula e o contador do dia rodam de verdade no worker-functions do stack. O triage não existe no CI:
 * o stub (`worker-functions/test-fixtures/triage-prueba-stub.mjs`, `docker-compose.triage-prueba-stub.yml`) ocupa o lugar dele NA FRONTEIRA DE SAÍDA
 * do worker-functions (`TRIAGE_PRUEBA_URL`) e guarda cada request em `GET /_requests` — é de lá que o CA-9 lê o corpo que CHEGOU ao triage.
 * Sem `VITE_ASSISTANTS_SERVICE_URL` neste job o widget não pergunta pelos assistentes da gestão (lista vazia): quem tem a célula vê o botão e o
 * painel abre direto na vista prueba; quem não tem, não vê botão nenhum.
 *
 * ⚠️ Engine ligado + `admin.integrations` enforçada + stub do triage: só roda no job `integration-e2e-group-simulation` do `_frontend-integration.yml`
 * (token `luz-prueba` no `--grep`; `TRIAGE_STUB_URL` default http://localhost:59060).
 * Baseline visual: o `toHaveScreenshot` do CA-7 segue a convenção do repo — a baseline `*-darwin.png` NÃO está commitada (é gerada à mão no macOS com
 * `--update-snapshots`) e o CI roda `--ignore-snapshots`, então lá o print não é comparado; textos lidos de `es.json`.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, safeSql, seedStaffInGroup, type MockUser } from '../helpers/abac-stack-helper';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const mk = (nome: string): MockUser => ({ uid: `e2e-luz-${nome}-${RUN}`, email: `luz.${nome}.${RUN}@e2e.test`, role: 'recruiter', country: 'AR' });
const COM = mk('com');
const SEM = mk('sem');
const grupos: Record<string, string> = {};

const STUB = process.env.TRIAGE_STUB_URL || 'http://localhost:59060';
const I18N = JSON.parse(readFileSync('src/infrastructure/i18n/locales/es.json', 'utf8')).admin.luzPrueba as Record<string, string>;
const header = (nome: string) => I18N.header.replace('{{nome}}', nome);

interface Chegou { gatilho: string | null; body: { sessao: string; mensagem: string; historico: { role: string; content: string }[] } }

/** O que o triage (stub) recebeu DESTA pessoa, na ordem. O gatilho é `prueba:<uid>:<sessao>#turno-<N>`. */
async function recebidos(u: MockUser): Promise<Chegou[]> {
  const res = await fetch(`${STUB}/_requests`);
  const todos = (await res.json()) as Chegou[];
  return todos.filter((r) => r.gatilho?.startsWith(`prueba:${u.uid}:`));
}

test.describe('Luz (prueba) 086 — feliz, sem célula, reiniciar @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeAll(async ({ request }) => {
    for (const [chave, u] of [['com', COM], ['sem', SEM]] as Array<[string, MockUser]>) {
      grupos[chave] = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `Luz086 ${chave} ${RUN}`, country: 'AR' }).groupId;
    }
    grantCell(grupos.com, 'luz_prueba', 'chat');
    await pollAuthz(request, COM, (b) => b?.permissions?.includes('luz_prueba:chat'));
  });

  test.afterAll(() => {
    for (const [chave, u] of [['com', COM], ['sem', SEM]] as Array<[string, MockUser]>) cleanupStaffAndGroup(u.uid, grupos[chave] ?? '');
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE 'Luz086 % ${RUN}'`);
  });

  test('CA-7 feliz: com a célula, abre o painel, vê o cabeçalho, envia (click + keyboard.type) e vê resposta, ferramenta simulada e o nome no cabeçalho', async ({ page }) => {
    await loginAs(page, COM);
    const fab = page.getByTestId('assistants-fab');
    await expect(fab).toBeVisible({ timeout: 30_000 });
    await fab.click();
    const header0 = page.getByTestId('luz-prueba-header');
    await expect(header0).toHaveText(I18N.headerGeneric); // antes do 1º turno: texto genérico
    await expect(page.getByTestId('assistants-composer')).toHaveCount(0); // a caixa da Maria não existe aqui

    const box = page.getByTestId('luz-prueba-input');
    await box.click();
    await expect(box).toBeFocused();
    await page.keyboard.type('Hola');
    await expect(box).toHaveValue('Hola');
    await page.getByTestId('luz-prueba-send').click();

    const msgs = page.getByTestId('luz-prueba-msg');
    await expect(msgs).toHaveCount(2, { timeout: 30_000 });
    await expect(msgs.nth(0)).toHaveText('Hola');
    await expect(msgs.nth(0)).toHaveAttribute('data-role', 'user');
    await expect(msgs.nth(1)).toHaveText('Hola, soy la Luz (stub)');
    await expect(msgs.nth(1)).toHaveAttribute('data-role', 'assistant');
    const tools = page.getByTestId('luz-prueba-tools');
    await expect(tools).toContainText('(prueba) apply_to_vacancy — ok simulado');
    await expect(tools).toContainText('get_worker_status — ok');
    await expect(tools).toContainText('notario:x');
    await expect(header0).toHaveText(header('Prueba Luz PRUEBA'));
    await expect(box).toHaveValue('');

    const chegou = await recebidos(COM);
    expect(chegou).toHaveLength(1);
    expect(chegou[0].body.mensagem).toBe('Hola');
    expect(chegou[0].body.historico).toEqual([]);
    expect(chegou[0].gatilho).toMatch(/#turno-\d+$/);

    await expect(page.getByTestId('assistants-panel')).toHaveScreenshot('luz-prueba-resposta.png', { animations: 'disabled', maxDiffPixelRatio: 0.002 });
  });

  test('CA-8 sem a célula: a aba NÃO existe no DOM e nenhuma request vai a /luz-prueba', async ({ page }) => {
    const pedidos: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.includes('/luz-prueba')) pedidos.push(r.url());
    });
    await loginAs(page, SEM);
    await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_000); // o contrato de permissões já chegou: "sem botão" é "sem célula", não "ainda carregando"
    await expect(page.getByTestId('assistants-fab')).toHaveCount(0);
    await expect(page.getByTestId('assistants-tab-luz-prueba')).toHaveCount(0);
    await expect(page.getByTestId('luz-prueba-header')).toHaveCount(0);
    expect(pedidos).toEqual([]);
    expect((await recebidos(SEM))).toEqual([]);
  });

  test('CA-9 reiniciar: 2 turnos, "Reiniciar conversa", lista vazia, 3º turno chega ao triage com histórico vazio e sessão nova', async ({ page }) => {
    await loginAs(page, COM);
    await expect(page.getByTestId('assistants-fab')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('assistants-fab').click();
    const box = page.getByTestId('luz-prueba-input');
    const msgs = page.getByTestId('luz-prueba-msg');

    for (const [i, texto] of ['uno', 'dos'].entries()) {
      await box.click();
      await page.keyboard.type(texto);
      await page.keyboard.press('Enter');
      await expect(msgs).toHaveCount((i + 1) * 2, { timeout: 30_000 });
    }
    await page.getByTestId('luz-prueba-reset').click();
    await expect(msgs).toHaveCount(0);
    await expect(page.getByTestId('luz-prueba-header')).toHaveText(I18N.headerGeneric);

    await box.click();
    await page.keyboard.type('tres');
    await page.keyboard.press('Enter');
    await expect(msgs).toHaveCount(2, { timeout: 30_000 });

    const chegou = await recebidos(COM);
    const meus = chegou.filter((r) => ['uno', 'dos', 'tres'].includes(r.body.mensagem));
    expect(meus.map((r) => r.body.mensagem)).toEqual(['uno', 'dos', 'tres']);
    expect(meus[1].body.historico).toEqual([
      { role: 'user', content: 'uno' },
      { role: 'assistant', content: 'Hola, soy la Luz (stub)' },
    ]);
    expect(meus[1].body.sessao).toBe(meus[0].body.sessao);
    expect(meus[2].body.historico).toEqual([]);
    expect(meus[2].body.sessao).not.toBe(meus[0].body.sessao);
  });
});
