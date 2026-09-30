/**
 * ai-prompts-humano.integration.e2e.ts @integration — spec 029, T035.
 *
 * O fluxo inteiro de `/admin/prompts-ia`, feito por um HUMANO contra o stack REAL (Vite + API +
 * Postgres, engine ABAC LIGADO), zero mock de rede de negócio: ler em Markdown → "Editar" →
 * digitar → escolher um caso → simular → ver o AVISO de simulação → "Guardar" → F5 (o texto
 * continua lá) → "Deshacer" (window.confirm aceito) → o texto anterior volta.
 *
 * Régua humana (memória `e2e-humano-nao-e-fill`): `click` + `keyboard.type`, e o valor é lido
 * DA TELA depois de digitar. Nenhum `fill()`.
 *
 * Armadilhas deste spec, todas medidas antes:
 *  - "Deshacer" abre um `window.confirm`, que o Playwright DESCARTA sozinho. Sem
 *    `page.on('dialog', d => d.accept())` o clique não faz nada e o teste "passa" sem desfazer.
 *    O handler aqui aceita E grava tipo+mensagem; a prova do desfazer é o EFEITO na tela
 *    (marcador some, texto original volta, contador volta) e no banco — não o clique.
 *  - Um 200 só diz que o servidor respondeu; só o F5 prova que gravou.
 *  - O preview chama o modelo. A stack de teste carrega `vertexInterceptPreload.js` dentro do
 *    container da API (docker-compose.test.yml), que devolve resposta sintética e loga
 *    `[VERTEX-STUB]`. Este spec NÃO presume que está ativo: lê o log do container antes e depois
 *    do clique e exige que a contagem de interceptações SUBA (instrumento que acusaria se o
 *    modelo real fosse chamado — sem interceptação, o teste reprova) e que o texto digitado na
 *    tela tenha chegado ao `systemInstruction` visto pelo stub.
 *  - Sem skip mudo: stack ausente → `beforeAll` falha alto.
 *
 * Stack (mesma família dos specs ABAC — ver `helpers/abac-stack-helper.ts`): API e banco vêm de
 * `ABAC_API_URL` / `ABAC_TEST_DB_URL`; o container da API é achado pela PORTA publicada (nunca
 * por nome fixo) ou por `E2E_API_CONTAINER`. O engine precisa estar ligado com
 * `PERMISSION_CATALOG_SYNC_ENABLED=true` e `iam.rollout_state.permission_groups_migrated=done`.
 *
 * O estado dos prompts é restaurado no `afterAll` (linhas + trilha, mesmo id) — o teste grava e
 * desfaz de verdade, então devolve o banco como encontrou.
 */
import { execSync } from 'child_process';
import { test, expect, type Dialog } from '@playwright/test';
import {
  ABAC_API_URL,
  cleanupStaffAndGroup,
  grantCell,
  loginAs,
  pollAuthz,
  psql,
  safeSql,
  scalar,
  seedStaffInGroup,
  type MockUser,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const UID = `e2e-t035-${RUN_ID}`;
const USER: MockUser = { uid: UID, email: `${UID}@e2e.test`, role: 'recruiter', country: 'AR' };
const GROUP = `E2E T035 prompts ${RUN_ID}`;

const SLUG = 'VACANCY_DESCRIPTION';
const CASE_TITLE = 'T035 Caso Preview e2e';
// Texto fixo (não carimbado): o banco é restaurado ao fim, e o screenshot precisa ser estável.
const DIGITADO = 'Nota e2e T035: linha escrita por uma pessoa no teclado.';

function sqlLit(s: string): string {
  return `$t035$${s}$t035$`;
}

/** Container da API pela PORTA publicada em `ABAC_API_URL`; falha alto se não achar. */
function resolveApiContainer(): string {
  const override = process.env.E2E_API_CONTAINER?.trim();
  if (override) return override;
  const port = new URL(ABAC_API_URL).port || '80';
  const names = execSync(`docker ps --filter "publish=${port}" --format '{{.Names}}'`)
    .toString()
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(`Nenhum container publica a porta ${port} (ABAC_API_URL=${ABAC_API_URL}). Suba a stack ou defina E2E_API_CONTAINER.`);
  }
  return names[0];
}

function apiLogs(container: string): string {
  return execSync(`docker logs ${container} 2>&1`, { maxBuffer: 1024 * 1024 * 80 }).toString();
}

function stubCalls(logs: string): number {
  return (logs.match(/\[VERTEX-STUB\] intercepted call #/g) ?? []).length;
}

function promptRow(): { body: string; version: number } {
  const body = scalar(`SELECT replace(encode(convert_to(body,'UTF8'),'base64'), chr(10), '') FROM ai_prompts WHERE slug='${SLUG}'`);
  const version = Number(scalar(`SELECT version FROM ai_prompts WHERE slug='${SLUG}'`));
  return { body: Buffer.from(body, 'base64').toString('utf8'), version };
}

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe('spec 029 T035 — prompts de IA: um HUMANO lê, edita, simula, guarda, recarrega e desfaz @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let groupId = '';
  let jobPostingId = '';
  let container = '';
  let capturedPrompts = '';
  let capturedAudit = '';
  let original = { body: '', version: 0 };

  test.beforeAll(async () => {
    // Falha alto: sem a stack, sem o engine ou sem o preload não há o que provar.
    const health = await fetch(`${ABAC_API_URL}/health`).catch(() => null);
    expect(health?.ok, `API fora do ar em ${ABAC_API_URL}`).toBe(true);
    container = resolveApiContainer();
    expect(apiLogs(container), 'preload do Vertex ausente no container da API — o preview chamaria o modelo real').toContain(
      '[VERTEX-STUB] preload ativo',
    );

    expect(Number(scalar(`SELECT count(*) FROM ai_prompts WHERE slug='${SLUG}'`)), 'prompt semeado ausente (migration 487/491)').toBe(1);
    capturedPrompts = scalar(`SELECT to_jsonb(p)::text FROM ai_prompts p WHERE slug='${SLUG}'`);
    capturedAudit = psql(
      `SELECT coalesce(string_agg(to_jsonb(a)::text, E'\\n'), '') FROM ai_prompt_audit_log a WHERE prompt_id = (SELECT id FROM ai_prompts WHERE slug='${SLUG}')`,
    ).trim();
    original = promptRow();
    expect(original.body.length).toBeGreaterThan(50);

    // Staff com as três células que a tela usa: ler e editar o prompt, e listar vacantes (seletor de caso).
    ({ groupId } = seedStaffInGroup({ uid: UID, email: USER.email, groupName: GROUP, country: 'AR' }));
    grantCell(groupId, 'ai_prompt', 'read');
    grantCell(groupId, 'ai_prompt', 'update');
    grantCell(groupId, 'vacancy', 'read');

    // Um caso NÃO-rascunho, visível na lista de vacantes (o seletor do painel filtra rascunhos).
    // `vacancy_number` fixo: o rótulo do seletor (`Caso 990035-35`) entra no screenshot e a sequência mudaria a cada rodada.
    safeSql(`DELETE FROM job_postings WHERE title = '${CASE_TITLE}'`);
    jobPostingId = scalar(
      `INSERT INTO job_postings (title, description, country, status, is_draft, case_number, vacancy_number)
       VALUES ('${CASE_TITLE}', 'T035 e2e — caso do simulador', 'AR', 'SEARCHING', false, 990035, 35) RETURNING id`,
    );
    expect(jobPostingId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test.afterAll(() => {
    // Devolve o banco como encontrado: linha (mesmo id) e trilha. Cada passo isolado, para um não esconder o outro.
    safeSql(`DELETE FROM ai_prompt_audit_log WHERE prompt_id = (SELECT id FROM ai_prompts WHERE slug='${SLUG}')`);
    safeSql(`DELETE FROM ai_prompts WHERE slug='${SLUG}'`);
    if (capturedPrompts) {
      safeSql(`INSERT INTO ai_prompts SELECT * FROM jsonb_populate_record(NULL::ai_prompts, ${sqlLit(capturedPrompts)}::jsonb)`);
    }
    for (const line of capturedAudit.split('\n').filter(Boolean)) {
      safeSql(`INSERT INTO ai_prompt_audit_log SELECT * FROM jsonb_populate_record(NULL::ai_prompt_audit_log, ${sqlLit(line)}::jsonb)`);
    }
    if (jobPostingId) safeSql(`DELETE FROM job_postings WHERE id = '${jobPostingId}'`);
    cleanupStaffAndGroup(UID, groupId);
  });

  test('ler → Editar → digitar → escolher caso → simular (aviso) → Guardar → F5 → Deshacer (confirm aceito)', async ({ page, request }) => {
    // O contrato de permissões tem cache no backend; espera as células valerem ANTES de abrir a tela.
    const authz = await pollAuthz(request, USER, (b) => JSON.stringify(b ?? {}).includes('ai_prompt'));
    expect(JSON.stringify(authz.body)).toContain('ai_prompt');

    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
    await loginAs(page, USER);
    await page.goto('/admin/prompts-ia');
    await expect(page.getByRole('heading', { name: 'Prompts de IA' })).toBeVisible({ timeout: 30_000 });

    // ── 1. Modo leitura: Markdown renderizado, sem textarea ──────────────────────────────────
    const reader = page.getByTestId('ai-prompt-editor-reader');
    await expect(reader).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ai-prompt-editor-textarea')).toHaveCount(0);
    await expect(page.getByTestId('ai-prompt-tab-VACANCY_DESCRIPTION')).toHaveAttribute('aria-selected', 'true');
    // Markdown de verdade: o corpo semeado vira elementos (não texto cru com marcadores).
    const nodes = await reader.locator('p, li, h1, h2, h3, strong').count();
    expect(nodes, 'o leitor não renderizou nenhum elemento Markdown').toBeGreaterThan(0);
    const primeiraPalavra = original.body.replace(/[#*_`>\-\d.]/g, ' ').trim().split(/\s+/)[0];
    await expect(reader).toContainText(primeiraPalavra);
    await expect(page.getByTestId('ai-prompt-editor-counter')).toContainText(`${original.body.length}`);
    await expect(reader).toHaveScreenshot('ai-prompts-1-modo-leitura.png', { maxDiffPixelRatio: 0.02 });
    // Enquadramento COMPLETO do editor em leitura: inclui o botão "Editar" (a peça central da
    // funcionalidade), o "Deshacer" e o contador. Volátil: a linha "última edição: data + autor"
    // (muda a cada Guardar) → MASCARADA; o resto é fixo (corpo semeado por migration, versão 1).
    const editor = page.getByTestId('ai-prompt-editor');
    await expect(editor.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
    await expect(editor).toHaveScreenshot('ai-prompts-1b-leitura-com-botao-editar.png', {
      mask: [page.getByTestId('ai-prompt-editor-author')],
      maxDiffPixelRatio: 0.02,
    });

    // ── 1c. As outras duas abas, em leitura (zero cobertura visual antes) ─────────────────────
    // Mesmo enquadramento e mesma máscara do autor. O corpo de cada uma é semeado por migration e
    // nada o altera neste spec (só VACANCY_DESCRIPTION é editada), então o conteúdo é estável.
    for (const [tab, arquivo] of [
      ['PRESCREENING_AT', 'ai-prompts-1c-leitura-prescreening-at.png'],
      ['PRESCREENING_CAREGIVER', 'ai-prompts-1d-leitura-prescreening-caregiver.png'],
    ] as const) {
      await page.getByTestId(`ai-prompt-tab-${tab}`).click();
      await expect(page.getByTestId(`ai-prompt-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('ai-prompt-editor-reader')).toBeVisible();
      await expect(page.getByTestId('ai-prompt-editor-textarea')).toHaveCount(0);
      await expect(editor.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
      await expect(editor).toHaveScreenshot(arquivo, {
        mask: [page.getByTestId('ai-prompt-editor-author')],
        maxDiffPixelRatio: 0.02,
      });
    }
    // Volta à aba do fluxo (o editor é remontado por `key={slug}`, então volta em leitura).
    await page.getByTestId(`ai-prompt-tab-${SLUG}`).click();
    await expect(page.getByTestId(`ai-prompt-tab-${SLUG}`)).toHaveAttribute('aria-selected', 'true');
    await expect(reader).toBeVisible();

    // ── 2. "Editar" → textarea (clique de verdade) ───────────────────────────────────────────
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    const textarea = page.getByTestId('ai-prompt-editor-textarea');
    await expect(textarea).toBeVisible();
    await expect(reader).toHaveCount(0);
    await expect(page.getByTestId('ai-prompt-preview-panel')).toBeVisible();
    // O aviso só existe com resultado à vista: aqui ainda NÃO pode existir (contagem 0 com controle positivo adiante).
    await expect(page.getByTestId('ai-prompt-preview-notice')).toHaveCount(0);

    // ── 3. Digitar como gente: click + teclado, e ler o valor DA TELA ────────────────────────
    await textarea.click();
    await expect(textarea).toBeFocused();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Meta+ArrowDown'); // macOS: fim do texto (Control+End cobre Linux/Windows)
    await page.keyboard.type(`\n\n${DIGITADO}`);
    const naTela = await textarea.inputValue();
    expect(naTela.endsWith(DIGITADO), 'o valor lido da tela não termina com o que foi digitado').toBe(true);
    expect(naTela.startsWith(original.body.slice(0, 40))).toBe(true); // digitou NO FIM, não apagou o resto
    await expect(page.getByTestId('ai-prompt-editor-counter')).toContainText(`${naTela.length}`);

    // ── 4. Escolher um caso (o <select> é nativo: selectOption é o gesto humano dele) ─────────
    const runBtn = page.getByTestId('ai-prompt-preview-run');
    await expect(runBtn).toBeDisabled(); // sem caso escolhido não simula
    const select = page.getByTestId('ai-prompt-preview-case');
    await expect(select).toBeVisible({ timeout: 30_000 });
    const opcoes = await select.locator('option').allTextContents();
    const rotulo = opcoes.find((o) => o.includes('990035') || o.includes(CASE_TITLE));
    expect(rotulo, `o caso semeado não apareceu no seletor. Opções: ${JSON.stringify(opcoes)}`).toBeTruthy();
    await select.selectOption({ label: rotulo! });
    await expect(select).toHaveValue(jobPostingId);
    await expect(runBtn).toBeEnabled();
    await expect(page.getByTestId('ai-prompt-editor')).toHaveScreenshot('ai-prompts-2-modo-edicao.png', {
      mask: [page.getByTestId('ai-prompt-editor-author')],
      maxDiffPixelRatio: 0.02,
    });

    // ── 5. Simular: o modelo NÃO pode ser o real ─────────────────────────────────────────────
    const logsAntes = apiLogs(container);
    const stubAntes = stubCalls(logsAntes);
    const before = promptRow();
    const preview = page.waitForResponse((r) => r.request().method() === 'POST' && /\/ai-prompts\/VACANCY_DESCRIPTION\/preview$/.test(r.url()));
    await runBtn.click();
    const res = await preview;
    expect(res.status()).toBe(200);
    const payload = (await res.json()) as { success: boolean; data: { jobPostingId: string; slug: string; generated: string } };
    expect(payload.success).toBe(true);
    expect(payload.data.jobPostingId).toBe(jobPostingId);
    expect(payload.data.slug).toBe(SLUG);

    const result = page.getByTestId('ai-prompt-preview-result');
    await expect(result).toBeVisible();
    // Aviso de simulação PRESENTE e com o texto de simulação.
    const aviso = page.getByTestId('ai-prompt-preview-notice');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('SIMULACIÓN');
    await expect(aviso).toContainText('No se guardó nada');
    const generated = page.getByTestId('ai-prompt-preview-generated');
    await expect(generated).toContainText('Resumen objetivo del caso'); // a resposta sintética do stub
    expect((await generated.textContent())!.length).toBeGreaterThan(20);
    // O aviso é permanente: segue à vista depois de um tempo, sem toast que suma.
    await page.waitForTimeout(3_000);
    await expect(aviso).toBeVisible();

    // Prova de que não foi o Vertex real: o stub do container contou mais uma chamada, e o que
    // ele recebeu como instrução de sistema contém o texto que a pessoa digitou na tela.
    const logsDepois = apiLogs(container);
    expect(stubCalls(logsDepois), 'nenhuma interceptação nova no stub — o modelo real pode ter sido chamado').toBeGreaterThan(stubAntes);
    expect(logsDepois).not.toContain('BLOCKED unexpected outbound Google call');
    const novas = logsDepois.slice(logsAntes.length);
    expect(novas, 'o texto digitado não chegou ao modelo (stub) — o preview usou o texto SALVO').toContain('Nota e2e T035');
    // O preview não grava: versão e corpo no banco idênticos aos de antes (version=1 é o controle, não zero).
    expect(before.version).toBeGreaterThanOrEqual(1);
    expect(promptRow()).toEqual(before);
    await expect(page.getByTestId('ai-prompt-preview-panel')).toHaveScreenshot('ai-prompts-3-painel-resultado.png', {
      maxDiffPixelRatio: 0.02,
    });

    // ── 6. Guardar ───────────────────────────────────────────────────────────────────────────
    const put = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/ai-prompts\/VACANCY_DESCRIPTION$/.test(r.url()));
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    expect((await put).status()).toBe(200);
    await expect(page.getByTestId('ai-prompt-editor-reader')).toBeVisible();
    await expect(page.getByTestId('ai-prompt-editor-reader')).toContainText('Nota e2e T035');
    await expect(page.getByTestId('ai-prompt-editor-textarea')).toHaveCount(0);

    // ── 7. F5: só o recarregar prova que gravou ──────────────────────────────────────────────
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Prompts de IA' })).toBeVisible({ timeout: 30_000 });
    const readerF5 = page.getByTestId('ai-prompt-editor-reader');
    await expect(readerF5).toBeVisible({ timeout: 30_000 });
    await expect(readerF5).toContainText('Nota e2e T035: linha escrita por uma pessoa no teclado.');
    const gravado = promptRow();
    expect(gravado.version).toBe(original.version + 1);
    expect(gravado.body.endsWith(DIGITADO)).toBe(true);

    // ── 8. Deshacer: window.confirm ACEITO de propósito, prova pelo EFEITO ───────────────────
    const dialogs: Array<{ type: string; message: string }> = [];
    page.on('dialog', async (d: Dialog) => {
      dialogs.push({ type: d.type(), message: d.message() });
      await d.accept();
    });
    const undoBtn = page.getByRole('button', { name: 'Deshacer último cambio' });
    await expect(undoBtn).toBeEnabled(); // version > 1 depois do Guardar
    const undo = page.waitForResponse((r) => r.request().method() === 'POST' && /\/ai-prompts\/VACANCY_DESCRIPTION\/undo$/.test(r.url()));
    await undoBtn.click();
    expect((await undo).status()).toBe(200);
    // O diálogo apareceu UMA vez, era um confirm, com a frase da tela, e foi aceito.
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].type).toBe('confirm');
    expect(dialogs[0].message).toBe('¿Deshacer el último cambio? El texto vuelve a la versión anterior.');
    // Efeito na tela: o marcador que ESTAVA lá (asserido no passo 7) sumiu e o texto original voltou.
    await expect(readerF5).not.toContainText('Nota e2e T035');
    await expect(readerF5).toContainText(primeiraPalavra);
    await expect(page.getByTestId('ai-prompt-editor-counter')).toContainText(`${original.body.length}`);
    // Efeito no banco: o corpo é o original, byte a byte.
    expect(promptRow().body).toBe(original.body);

    // E continua desfeito depois de recarregar.
    await page.reload();
    await expect(page.getByTestId('ai-prompt-editor-reader')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ai-prompt-editor-reader')).not.toContainText('Nota e2e T035');
    await expect(page.getByTestId('ai-prompt-editor-counter')).toContainText(`${original.body.length}`);
  });
});
