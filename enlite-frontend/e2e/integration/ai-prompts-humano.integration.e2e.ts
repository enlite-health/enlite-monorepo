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
 *  - A simulação chama o modelo (2 chamadas: descrição + prescreening). A stack de teste carrega
 *    `vertexInterceptPreload.js` dentro do container da API (docker-compose.test.yml), que devolve
 *    resposta sintética e loga `[VERTEX-STUB]`. Este spec NÃO presume que está ativo: lê o log do
 *    container antes e depois do clique e exige que a contagem de interceptações SUBA (instrumento
 *    que acusaria se o modelo real fosse chamado — sem interceptação, o teste reprova) e que o
 *    texto digitado na tela tenha chegado ao `systemInstruction` visto pelo stub. O 503 é provocado
 *    pelo marcador `[E2E-MODEL-DOWN]` no texto digitado, que o MESMO stub (versionado) transforma em
 *    falha do modelo — sem mock de rede.
 *  - T074: o painel de preview por aba saiu do editor; a simulação é a seção `vacancy-simulation-*`,
 *    FORA das abas. A seção não cria nada: o teste conta job_postings + tabelas de prescreening
 *    antes/depois, com controle positivo (o mesmo contador acusa uma inserção de propósito).
 *  - Evidência visual: com `E2E_EVIDENCIAS_DIR` definido os passos gravam `page.screenshot()` ali
 *    (nada de `toHaveScreenshot` novo — baselines são -darwin e o CI roda com --ignore-snapshots).
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
import { test, expect, type APIRequestContext, type Dialog, type Locator, type Page } from '@playwright/test';
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

const TABELAS_NAO_CRIA = [
  'job_postings',
  'job_posting_prescreening_questions',
  'job_posting_prescreening_faq',
  'talentum_prescreenings',
  'job_posting_audit_log',
] as const;

/** Contagem de linhas das tabelas que a simulação NUNCA pode tocar. */
function contagens(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of TABELAS_NAO_CRIA) out[t] = Number(scalar(`SELECT count(*) FROM ${t}`));
  return out;
}

function stubForcedFailures(logs: string): number {
  return (logs.match(/\[VERTEX-STUB\] FORCED FAILURE/g) ?? []).length;
}

/** Evidência visual opcional: só grava se `E2E_EVIDENCIAS_DIR` existir (não altera o resultado do teste). */
async function foto(page: Page, nome: string, alvo?: Locator, alinhar: 'start' | 'end' = 'start'): Promise<void> {
  const dir = process.env.E2E_EVIDENCIAS_DIR;
  // A rolagem é da área de conteúdo (não da janela): rola o alvo para a vista antes de fotografar a janela.
  if (alvo) await alvo.evaluate((el, a) => el.scrollIntoView({ block: a, behavior: 'instant' }), alinhar);
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${nome}` });
}

function pareceJson(texto: string): boolean {
  try {
    // Só objeto/array conta: "5" (peso) e "true" também parseiam, mas não são "JSON na tela".
    const v: unknown = JSON.parse(texto.trim());
    return typeof v === 'object' && v !== null;
  } catch {
    return false;
  }
}

const SIMULATE_URL = /\/ai-prompts\/simulate-vacancy$/;

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
    // O painel de preview POR ABA saiu do editor (T072): a simulação mora numa seção própria, fora das abas.
    await expect(page.getByTestId('ai-prompt-preview-panel')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-simulation-section')).toBeVisible();

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

    // ── 3b. Rascunho não salvo SOBREVIVE à troca de aba, e a aba ganha a bolinha âmbar ───────
    const bolinha = page.getByTestId(`ai-prompt-tab-unsaved-${SLUG}`);
    await expect(bolinha).toBeVisible();
    await expect(page.getByTestId('ai-prompt-tab-unsaved-PRESCREENING_AT')).toHaveCount(0); // controle: aba intocada não tem bolinha
    await page.getByTestId('ai-prompt-tab-PRESCREENING_AT').click();
    await expect(page.getByTestId('ai-prompt-tab-PRESCREENING_AT')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('ai-prompt-editor-reader')).toBeVisible(); // outra aba: em leitura
    await expect(bolinha).toBeVisible(); // a bolinha continua na aba com rascunho
    await page.getByTestId(`ai-prompt-tab-${SLUG}`).click();
    await expect(textarea).toBeVisible(); // volta JÁ em edição
    expect(await textarea.inputValue(), 'o rascunho não sobreviveu à troca de aba').toBe(naTela);

    // ── 4. Escolher um caso na seção de simulação (o <select> é nativo: selectOption é o gesto dele) ──
    const runBtn = page.getByTestId('vacancy-simulation-run');
    await expect(runBtn).toBeDisabled(); // sem caso escolhido não simula
    const select = page.getByTestId('vacancy-simulation-case');
    await expect(select).toBeVisible({ timeout: 30_000 });
    const opcoes = await select.locator('option').allTextContents();
    const rotulo = opcoes.find((o) => o.includes('990035') || o.includes(CASE_TITLE));
    expect(rotulo, `o caso semeado não apareceu no seletor. Opções: ${JSON.stringify(opcoes)}`).toBeTruthy();
    await select.selectOption({ label: rotulo! });
    await expect(select).toHaveValue(jobPostingId);
    await expect(runBtn).toBeEnabled();
    await expect(page.getByTestId('vacancy-simulation-result')).toHaveCount(0); // antes de simular não há resultado
    await foto(page, '01-feliz-antes-de-simular.png', page.getByTestId('vacancy-simulation-section'));

    // ── 5. Simular: o modelo NÃO pode ser o real ─────────────────────────────────────────────
    const logsAntes = apiLogs(container);
    const stubAntes = stubCalls(logsAntes);
    const before = promptRow();
    const contagemAntes = contagens();
    const sim = page.waitForResponse((r) => r.request().method() === 'POST' && SIMULATE_URL.test(r.url()), { timeout: 120_000 });
    await runBtn.click();
    const res = await sim;
    expect(res.status()).toBe(200);
    const payload = (await res.json()) as {
      success: boolean;
      data: { description: string; prescreening: { questions: unknown[]; faq: unknown[] }; workerType: string; usedSlugs: string[] };
    };
    expect(payload.success).toBe(true);
    expect(payload.data.usedSlugs[0]).toBe(SLUG);
    expect(payload.data.usedSlugs).toHaveLength(2);

    const result = page.getByTestId('vacancy-simulation-result');
    await expect(result).toBeVisible({ timeout: 30_000 });
    // Aviso de simulação PRESENTE, permanente, dizendo que nada foi criado.
    const aviso = page.getByTestId('vacancy-simulation-notice');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('SIMULACIÓN');
    await expect(aviso).toContainText('no se creó ninguna vacante');
    // Quais prompts entraram: a descrição e o de prescreening escolhido pela vaga.
    await expect(page.getByTestId('vacancy-simulation-used')).toContainText('Prompts que se ejercitaron');
    // Conteúdo DESENHADO: a descrição sintética do stub aparece como texto (não como `{"propuesta": ...}`)...
    await expect(result).toContainText('Resumen objetivo del caso');
    // ...e a pergunta e a FAQ do prescreening estão nos campos (modo leitura) da tela.
    const valoresDosCampos = await result.locator('input, textarea').evaluateAll((els) =>
      els.map((e) => (e as HTMLInputElement | HTMLTextAreaElement).value),
    );
    expect(valoresDosCampos.join(' | '), 'a pergunta desenhada do prescreening não está na tela').toContain('Pergunta sintética (stub e2e T071)?');
    expect(valoresDosCampos.join(' | '), 'a FAQ desenhada do prescreening não está na tela').toContain('FAQ sintética (stub e2e T071)?');
    // Campos em modo leitura: nenhum campo editável dentro do resultado.
    const editaveis = await result.locator('input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])').count();
    expect(editaveis, 'o resultado da simulação tem campo editável').toBe(0);

    // NÃO É JSON: nenhum <pre>, nenhum texto visível que seja/comece como JSON e nenhuma chave crua da resposta.
    expect(pareceJson('{"propuesta":"x"}'), 'controle positivo: o detector de JSON tem de acusar JSON').toBe(true);
    await expect(result.locator('pre')).toHaveCount(0);
    await expect(page.locator('pre')).toHaveCount(0);
    const textoVisivel = await result.innerText();
    expect(pareceJson(textoVisivel), 'o resultado visível parseia como JSON').toBe(false);
    expect(textoVisivel).not.toMatch(/^\s*[{[]/);
    expect(textoVisivel).not.toMatch(/"(propuesta|perfilProfesional|responseType|desiredResponse|usedSlugs)"\s*:/);
    expect(valoresDosCampos.some((v) => pareceJson(v)), 'um campo do resultado contém JSON cru').toBe(false);

    // NENHUM botão de criar/publicar/gravar dentro do resultado.
    const PERIGOSO = /crear|publicar|guardar|grabar|enviar|talentum|salvar|save|publish|create/i;
    const botoesDoResultado = await result.getByRole('button').allInnerTexts();
    expect(botoesDoResultado.filter((b) => PERIGOSO.test(b)), `botão de criar/publicar/gravar no resultado: ${JSON.stringify(botoesDoResultado)}`).toEqual([]);
    const botoesDaPagina = await page.getByRole('button').allInnerTexts();
    expect(botoesDaPagina.filter((b) => PERIGOSO.test(b)).length, 'controle positivo: o regex tem de achar o "Guardar" do editor, fora do resultado').toBeGreaterThan(0);

    // O aviso é permanente: segue à vista depois de um tempo, sem toast que suma.
    await page.waitForTimeout(3_000);
    await expect(aviso).toBeVisible();
    await foto(page, '02a-feliz-simulacao-topo.png', page.getByTestId('vacancy-simulation-section'));
    await foto(page, '02b-feliz-simulacao-fim.png', page.getByTestId('vacancy-simulation-result'), 'end');

    // Prova de que não foi o Vertex real: o stub do container contou chamadas novas, e o que ele
    // recebeu como instrução de sistema contém o texto que a pessoa digitou na tela (rascunho NÃO salvo).
    const logsDepois = apiLogs(container);
    expect(stubCalls(logsDepois), 'nenhuma interceptação nova no stub — o modelo real pode ter sido chamado').toBeGreaterThanOrEqual(stubAntes + 2);
    expect(logsDepois).not.toContain('BLOCKED unexpected outbound Google call');
    const novas = logsDepois.slice(logsAntes.length);
    expect(novas, 'o texto digitado não chegou ao modelo (stub) — a simulação usou o texto SALVO').toContain('Nota e2e T035');

    // NÃO CRIA: prompt idêntico, e contagem das tabelas de vaga/prescreening/auditoria igual à de antes.
    expect(before.version).toBeGreaterThanOrEqual(1);
    expect(promptRow()).toEqual(before);
    const contagemDepois = contagens();
    expect(contagemDepois, 'a simulação criou linhas em job_postings/prescreening/auditoria').toEqual(contagemAntes);
    // Controle positivo: O MESMO contador acusa uma inserção feita de propósito (senão "igual" poderia ser "não contei").
    const controleId = scalar(
      `INSERT INTO job_postings (title, description, country, status, is_draft, case_number, vacancy_number)
       VALUES ('T074 controle positivo', 'controle', 'AR', 'SEARCHING', true, 990074, 74) RETURNING id`,
    );
    try {
      safeSql(
        `INSERT INTO job_posting_prescreening_questions (job_posting_id, question_order, question, desired_response, weight)
         VALUES ('${controleId}', 1, 'controle', 'controle', 1)`,
      );
      const comControle = contagens();
      expect(comControle.job_postings, 'controle positivo: o contador não acusou o job_posting inserido').toBe(contagemDepois.job_postings + 1);
      expect(comControle.job_posting_prescreening_questions, 'controle positivo: o contador não acusou a pergunta inserida').toBe(
        contagemDepois.job_posting_prescreening_questions + 1,
      );
      expect(comControle).not.toEqual(contagemAntes);
    } finally {
      safeSql(`DELETE FROM job_postings WHERE id = '${controleId}'`);
    }

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
  /** Abre `/admin/prompts-ia` como o staff semeado, na aba VACANCY_DESCRIPTION, em modo leitura. */
  async function abrirTela(page: Page, request: APIRequestContext): Promise<void> {
    const authz = await pollAuthz(request, USER, (b) => JSON.stringify(b ?? {}).includes('ai_prompt'));
    expect(JSON.stringify(authz.body)).toContain('ai_prompt');
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
    await loginAs(page, USER);
    await page.goto('/admin/prompts-ia');
    await expect(page.getByRole('heading', { name: 'Prompts de IA' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ai-prompt-editor-reader')).toBeVisible({ timeout: 30_000 });
  }

  test('corpo vazio: a pessoa apaga tudo e tenta Guardar → a tela recusa, nenhum PUT sai e o banco não muda', async ({ page, request }) => {
    const antes = promptRow(); // fotografia de ENTRADA (o teste nominal devolve o banco, mas não dependo disso)
    const puts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && /\/ai-prompts\//.test(r.url())) puts.push(r.url());
    });
    try {
      await abrirTela(page, request);
      await page.getByRole('button', { name: 'Editar', exact: true }).click();
      const textarea = page.getByTestId('ai-prompt-editor-textarea');
      await expect(textarea).toBeVisible();
      expect((await textarea.inputValue()).length, 'o textarea devia abrir com o corpo semeado').toBeGreaterThan(50);

      // Apagar como gente: foco, selecionar tudo pelo teclado, Backspace.
      await textarea.click();
      await expect(textarea).toBeFocused();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      expect(await textarea.inputValue(), 'o valor lido da tela devia estar vazio').toBe('');
      await expect(page.getByTestId('ai-prompt-editor-counter')).toContainText('0');
      await expect(page.getByTestId('ai-prompt-editor-save-error')).toHaveCount(0); // controle: antes de Guardar não há erro

      await page.getByRole('button', { name: 'Guardar', exact: true }).click();

      // A recusa é do CLIENTE: mensagem na tela, ainda editando, e nenhuma requisição PUT saiu.
      const erro = page.getByTestId('ai-prompt-editor-save-error');
      await expect(erro).toBeVisible();
      await expect(erro).toHaveText('El texto no puede estar vacío.');
      await expect(textarea).toBeVisible();
      await expect(page.getByTestId('ai-prompt-editor-reader')).toHaveCount(0);
      await page.waitForTimeout(1_500); // dá tempo de um PUT indevido sair antes de afirmar que não saiu
      expect(puts, 'um PUT saiu com o corpo vazio').toEqual([]);
      expect(promptRow(), 'o banco mudou com o corpo vazio').toEqual(antes);

      // F5: o texto que está na tela é o semeado, não o vazio.
      await page.reload();
      await expect(page.getByTestId('ai-prompt-editor-reader')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('ai-prompt-editor-counter')).toContainText(`${antes.body.length}`);
    } finally {
      // Nada deveria ter sido gravado; se foi, devolve — a asserção acima já reprovou o teste.
      const agora = promptRow();
      if (agora.body !== antes.body || agora.version !== antes.version) {
        safeSql(`UPDATE ai_prompts SET body = ${sqlLit(antes.body)}, version = ${antes.version} WHERE slug='${SLUG}'`);
      }
    }
  });

  test('conflito de versão: outra pessoa grava entre a leitura e o Guardar → 409 na tela, e o texto dela NÃO é sobrescrito', async ({ page, request }) => {
    const OUTRA_PESSOA = 'Outra Pessoa E2E';
    const OUTRO_TEXTO = 'Texto gravado por OUTRA pessoa no meio (e2e 409).';
    const antes = scalar(`SELECT to_jsonb(p)::text FROM ai_prompts p WHERE slug='${SLUG}'`);
    const row0 = promptRow();
    try {
      await abrirTela(page, request); // a tela leu a versão row0.version

      await page.getByRole('button', { name: 'Editar', exact: true }).click();
      const textarea = page.getByTestId('ai-prompt-editor-textarea');
      await expect(textarea).toBeVisible();
      await textarea.click();
      await expect(textarea).toBeFocused();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Meta+ArrowDown'); // macOS: fim do texto (Control+End cobre Linux/Windows) — mesmo gesto do teste nominal
      await page.keyboard.type('\n\nMinha edição (e2e 409), escrita em cima de uma versão velha.');
      const digitado = await textarea.inputValue();
      expect(digitado.endsWith('em cima de uma versão velha.')).toBe(true);

      // O outro ator grava DEPOIS do GET da tela e ANTES do nosso PUT: versão sobe, autor e corpo mudam.
      safeSql(
        `UPDATE ai_prompts SET body = ${sqlLit(OUTRO_TEXTO)}, version = version + 1, updated_by = '${OUTRA_PESSOA}', updated_at = now() WHERE slug='${SLUG}'`,
      );
      expect(promptRow()).toEqual({ body: OUTRO_TEXTO, version: row0.version + 1 });

      const put = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/ai-prompts\/VACANCY_DESCRIPTION$/.test(r.url()));
      await page.getByRole('button', { name: 'Guardar', exact: true }).click();
      expect((await put).status()).toBe(409);

      // A tela mostra o conflito, com QUEM alterou, e segue em edição com o rascunho intacto.
      const erro = page.getByTestId('ai-prompt-editor-save-error');
      await expect(erro).toBeVisible();
      await expect(erro).toContainText('Otra persona');
      await expect(erro).toContainText(OUTRA_PESSOA);
      await expect(erro).toContainText('Recargá para ver la versión actual');
      await expect(textarea).toBeVisible();
      expect(await textarea.inputValue(), 'o rascunho da pessoa foi perdido/sobrescrito na tela').toBe(digitado);

      // O instrumento que importa: o banco continua com o texto da OUTRA pessoa, versão dela, sem nenhuma gravação nossa.
      await page.waitForTimeout(1_000);
      expect(promptRow(), 'o PUT em conflito sobrescreveu o texto de quem gravou antes').toEqual({
        body: OUTRO_TEXTO,
        version: row0.version + 1,
      });
    } finally {
      // Restaura a linha como estava (mesmo id, mesma versão, mesmo autor, mesmo updated_at).
      safeSql(
        `UPDATE ai_prompts SET body = r.body, version = r.version, updated_by = r.updated_by, updated_at = r.updated_at FROM jsonb_populate_record(NULL::ai_prompts, ${sqlLit(antes)}::jsonb) r WHERE ai_prompts.slug = '${SLUG}'`,
      );
    }
    expect(promptRow(), 'a restauração não devolveu o prompt ao estado de entrada').toEqual(row0);
  });

  /** Abre Editar, digita `texto` no FIM do rascunho (click + teclado) e devolve o valor lido da tela. */
  async function digitarNoFim(page: Page, texto: string): Promise<string> {
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    const textarea = page.getByTestId('ai-prompt-editor-textarea');
    await expect(textarea).toBeVisible();
    await textarea.click();
    await expect(textarea).toBeFocused();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Meta+ArrowDown'); // macOS: fim do texto (Control+End cobre Linux/Windows)
    await page.keyboard.type(texto);
    const naTela = await textarea.inputValue();
    expect(naTela.endsWith(texto), 'o valor lido da tela não termina com o que foi digitado').toBe(true);
    return naTela;
  }

  test('ALTERNATIVO modelo indisponível: o modelo falha → 503 → a tela mostra a mensagem própria, conserva o rascunho e não cria nada', async ({ page, request }) => {
    const MARCADOR = '[E2E-MODEL-DOWN]';
    const antes = promptRow();
    const contagemAntes = contagens();
    try {
      await abrirTela(page, request);
      const naTela = await digitarNoFim(page, `\n\nNota e2e T074 ${MARCADOR}`);

      const select = page.getByTestId('vacancy-simulation-case');
      await expect(select).toBeVisible({ timeout: 30_000 });
      await select.selectOption({ value: jobPostingId });
      await expect(select).toHaveValue(jobPostingId);

      const falhasAntes = stubForcedFailures(apiLogs(container));
      const sim = page.waitForResponse((r) => r.request().method() === 'POST' && SIMULATE_URL.test(r.url()), { timeout: 120_000 });
      await page.getByTestId('vacancy-simulation-run').click();
      const res = await sim;
      expect(res.status(), 'o modelo forçado a falhar devia virar 503').toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('modelo_indisponivel');
      expect(stubForcedFailures(apiLogs(container)), 'o stub não registrou a falha forçada — o 503 veio de outro lugar').toBeGreaterThan(falhasAntes);

      // A mensagem PRÓPRIA do 503 (não a genérica, não a do 404).
      const erro = page.getByTestId('vacancy-simulation-error');
      await expect(erro).toBeVisible();
      await expect(erro).toHaveText(
        'El modelo de IA no está disponible en este momento. Los textos de los editores se conservaron; probá de nuevo en unos instantes.',
      );
      await expect(page.getByTestId('vacancy-simulation-result')).toHaveCount(0);
      await expect(page.getByTestId('vacancy-simulation-notice')).toHaveCount(0);
      // "Los textos de los editores se conservaron": o rascunho segue intacto na tela.
      expect(await page.getByTestId('ai-prompt-editor-textarea').inputValue()).toBe(naTela);
      await expect(page.getByTestId(`ai-prompt-tab-unsaved-${SLUG}`)).toBeVisible();
      await foto(page, '03-alternativo-503-modelo-indisponivel.png', page.getByTestId('vacancy-simulation-section'));

      // Nada criado nem gravado.
      expect(contagens(), 'o 503 deixou linhas em job_postings/prescreening/auditoria').toEqual(contagemAntes);
      expect(promptRow()).toEqual(antes);
    } finally {
      const agora = promptRow();
      if (agora.body !== antes.body || agora.version !== antes.version) {
        safeSql(`UPDATE ai_prompts SET body = ${sqlLit(antes.body)}, version = ${antes.version} WHERE slug='${SLUG}'`);
      }
    }
  });

  test('ALTERNATIVO caso inexistente: o caso some entre a escolha e o clique → 404 → a tela não quebra, avisa, e dá para simular outro caso', async ({ page, request }) => {
    const TITULO_EFEMERO = 'T074 Caso que some';
    const antes = promptRow();
    safeSql(`DELETE FROM job_postings WHERE title = '${TITULO_EFEMERO}'`);
    const efemeroId = scalar(
      `INSERT INTO job_postings (title, description, country, status, is_draft, case_number, vacancy_number)
       VALUES ('${TITULO_EFEMERO}', 'T074 e2e — caso que some', 'AR', 'SEARCHING', false, 990074, 75) RETURNING id`,
    );
    try {
      await abrirTela(page, request);
      const select = page.getByTestId('vacancy-simulation-case');
      await expect(select).toBeVisible({ timeout: 30_000 });
      const opcoes = await select.locator('option').allTextContents();
      const rotulo = opcoes.find((o) => o.includes('990074'));
      expect(rotulo, `o caso efêmero não apareceu no seletor. Opções: ${JSON.stringify(opcoes)}`).toBeTruthy();
      await select.selectOption({ label: rotulo! });
      await expect(select).toHaveValue(efemeroId);

      // Outra pessoa apaga o caso DEPOIS de a tela listá-lo e ANTES do clique (404 de verdade, no banco).
      safeSql(`DELETE FROM job_postings WHERE id = '${efemeroId}'`);
      expect(Number(scalar(`SELECT count(*) FROM job_postings WHERE id = '${efemeroId}'`))).toBe(0);

      const contagemAntes = contagens();
      const sim = page.waitForResponse((r) => r.request().method() === 'POST' && SIMULATE_URL.test(r.url()), { timeout: 120_000 });
      await page.getByTestId('vacancy-simulation-run').click();
      const res = await sim;
      expect(res.status()).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('caso_nao_encontrado');

      const erro = page.getByTestId('vacancy-simulation-error');
      await expect(erro).toBeVisible();
      await expect(erro).toHaveText('El caso elegido ya no existe. Elegí otro.');
      await expect(page.getByTestId('vacancy-simulation-result')).toHaveCount(0);
      // A tela NÃO quebrou: título, editor, seção e seletor seguem funcionais.
      await expect(page.getByRole('heading', { name: 'Prompts de IA' })).toBeVisible();
      await expect(page.getByTestId('ai-prompt-editor-reader')).toBeVisible();
      await expect(page.getByTestId('vacancy-simulation-section')).toBeVisible();
      await expect(select).toBeEnabled();
      expect(contagens()).toEqual(contagemAntes);
      await foto(page, '04-alternativo-404-caso-inexistente.png', page.getByTestId('vacancy-simulation-section'));

      // Recuperação: escolher OUTRO caso (o semeado) e simular funciona, e o erro some.
      await select.selectOption({ value: jobPostingId });
      await expect(select).toHaveValue(jobPostingId);
      const sim2 = page.waitForResponse((r) => r.request().method() === 'POST' && SIMULATE_URL.test(r.url()), { timeout: 120_000 });
      await page.getByTestId('vacancy-simulation-run').click();
      expect((await sim2).status()).toBe(200);
      await expect(page.getByTestId('vacancy-simulation-result')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('vacancy-simulation-error')).toHaveCount(0);
      expect(contagens(), 'a simulação de recuperação criou linhas').toEqual(contagemAntes);
      expect(promptRow()).toEqual(antes);
    } finally {
      safeSql(`DELETE FROM job_postings WHERE id = '${efemeroId}'`);
    }
  });

  test('ALTERNATIVO prompt não exercitado: rascunho do prescreening do OUTRO tipo → a tela AVISA que o texto não entrou, sem erro', async ({ page, request }) => {
    const antes = promptRow();
    const contagemAntes = contagens();
    await abrirTela(page, request);
    // A vaga semeada não pede CUIDADOR → o prescreening exercitado é o do AT; o rascunho vai no de CUIDADOR.
    await page.getByTestId('ai-prompt-tab-PRESCREENING_CAREGIVER').click();
    await expect(page.getByTestId('ai-prompt-tab-PRESCREENING_CAREGIVER')).toHaveAttribute('aria-selected', 'true');
    const naTela = await digitarNoFim(page, '\n\nNota e2e T074 (texto do prescreening de CUIDADOR).');
    await expect(page.getByTestId('ai-prompt-tab-unsaved-PRESCREENING_CAREGIVER')).toBeVisible();
    await expect(page.getByTestId('vacancy-simulation-not-exercised-PRESCREENING_CAREGIVER')).toHaveCount(0); // controle: antes de simular não há aviso

    const select = page.getByTestId('vacancy-simulation-case');
    await expect(select).toBeVisible({ timeout: 30_000 });
    await select.selectOption({ value: jobPostingId });
    const sim = page.waitForResponse((r) => r.request().method() === 'POST' && SIMULATE_URL.test(r.url()), { timeout: 120_000 });
    await page.getByTestId('vacancy-simulation-run').click();
    const res = await sim;
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { data: { usedSlugs: string[] } }).data.usedSlugs).toEqual([SLUG, 'PRESCREENING_AT']);

    const aviso = page.getByTestId('vacancy-simulation-not-exercised-PRESCREENING_CAREGIVER');
    await expect(aviso).toBeVisible({ timeout: 30_000 });
    await expect(aviso).toContainText('NO entró en esta simulación');
    await expect(aviso).toContainText('No hubo error');
    await expect(page.getByTestId('vacancy-simulation-error')).toHaveCount(0);
    await expect(page.getByTestId('vacancy-simulation-not-exercised-PRESCREENING_AT')).toHaveCount(0); // o que entrou não gera aviso
    await foto(page, '05-alternativo-prompt-nao-exercitado.png', page.getByTestId('vacancy-simulation-section'));
    expect(await page.getByTestId('ai-prompt-editor-textarea').inputValue()).toBe(naTela); // rascunho intacto
    expect(contagens()).toEqual(contagemAntes);
    expect(promptRow()).toEqual(antes);
  });
});
