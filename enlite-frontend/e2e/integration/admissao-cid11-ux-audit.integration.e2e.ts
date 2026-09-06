/**
 * admissao-cid11-ux-audit.integration.e2e.ts — AUDITORIA DE USABILIDADE, não de correção.
 *
 * Simula uma operadora confusa/apressada usando a tela de diagnóstico CID-11. Não é um gate de
 * qualidade: cada passo tenta capturar screenshot + texto literal mesmo quando o comportamento
 * "funciona" — o objetivo é achar onde ela NÃO SABE o que fazer. Script de auditoria pontual,
 * não fica no conjunto de regressão.
 *
 * Molde de auth/seed: admissao-cid11-f3.integration.e2e.ts (auth REAL via emulador,
 * seedPatientForDiagnosis, setCatalogPromoted). Ambiente devolvido ao estado em que foi achado.
 *
 * RODADA 2 (depois dos 6 consertos U1-U6) — estendido, não reescrito do zero. Screenshots vão
 * para `<UX_AUDIT_EVIDENCE_DIR>/rodada2/`, com default RELATIVO ao repo (`e2e/__evidence__/ux`).
 * Quem for rodar a auditoria de novo e quiser os PNGs versionados no `ebrain` exporta
 * `UX_AUDIT_EVIDENCE_DIR=<ebrain>/specs/016-admissao-cid11/evidencias/ux` — o caminho da máquina
 * de UMA pessoa não pode voltar para dentro do código (ver bloco F5 abaixo).
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  seedPatientForDiagnosis, setCatalogPromoted, isCatalogPromoted, cleanupPatientDeep, runSQL,
} from '../helpers/terminology-diagnosis-helper';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.cid11ux.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';

/**
 * F5 (gate `revisao-pr`, BLOCKER de CI): este bloco fazia 3× `fs.mkdirSync` de um caminho ABSOLUTO
 * da máquina do autor, NO NÍVEL DO MÓDULO. Num runner esse caminho não existe, o `mkdir` estoura
 * ao CARREGAR o arquivo, e o erro de carga zera a listagem INTEIRA do projeto `integration`
 * (`Total: 0 tests in 0 files`, `playwright test` sai 1) — mesmo com `--grep` de outro spec.
 *
 * Conserto: (a) o arquivo saiu do `testMatch` do projeto `integration` (`testIgnore` em
 * `playwright.config.ts`) — ele mesmo se declara "auditoria pontual, não fica no conjunto de
 * regressão"; (b) o caminho passa a ser RELATIVO ao repo, com `UX_AUDIT_EVIDENCE_DIR` para
 * apontar a pasta de evidência do `ebrain` quando a auditoria for rodada de novo à mão; e
 * (c) o `mkdir` é PREGUIÇOSO — só acontece na primeira captura, nunca ao carregar o módulo.
 * Nada de carregar um módulo pode tocar o disco fora do repo.
 */
const EVIDENCE_ROOT =
  process.env.UX_AUDIT_EVIDENCE_DIR ?? path.resolve(__dirname, '..', '__evidence__', 'ux');

/** Cria a pasta na PRIMEIRA captura (nunca no carregamento do módulo) e só uma vez por pasta. */
const ensuredDirs = new Set<string>();
function evidenceDir(round: string): string {
  const dir = path.join(EVIDENCE_ROOT, round);
  if (!ensuredDirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  }
  return dir;
}

// RODADA 2.
const SHOT_DIR = 'rodada2';

// RODADA 3 (V1 + V2) — pasta NOVA, sem sobrescrever a rodada 2.
const SHOT_DIR3 = 'rodada3';

async function shot3(target: Page | ReturnType<Page['locator']>, name: string): Promise<string> {
  const file = path.join(evidenceDir(SHOT_DIR3), name);
  await target.screenshot({ path: file });
  log('SHOT3', `${name} -> ${file}`);
  return file;
}

// RODADA 4 — pasta NOVA, sem sobrescrever rodada1/2/3. Foco: (a) o controle de escopo permanente
// (novo desde a rodada 2) e (b) o corpo do chip agora inerte (removido desde a rodada 2).
const SHOT_DIR4 = 'rodada4';

async function shot4(target: Page | ReturnType<Page['locator']>, name: string): Promise<string> {
  const file = path.join(evidenceDir(SHOT_DIR4), name);
  await target.screenshot({ path: file });
  log('SHOT4', `${name} -> ${file}`);
  return file;
}

function log(tag: string, msg: string): void {
  console.log(`[AUDIT ${tag}] ${msg}`);
}

/**
 * `.textContent()`/`.getAttribute()` do Playwright ESPERAM o elemento aparecer (actionability) —
 * sem timeout próprio, herdam o timeout do TESTE INTEIRO. Vários elementos desta tela são
 * CONDICIONAIS (status só renderiza em certas fases, erro só quando há erro) — "(nada)" é uma
 * resposta legítima e tem que resolver rápido, não travar 10 minutos até estourar o teste.
 */
async function textOrNothing(locator: ReturnType<Page['getByTestId']>, timeoutMs = 1200): Promise<string | null> {
  try {
    return await locator.textContent({ timeout: timeoutMs });
  } catch {
    return null;
  }
}
async function attrOrNothing(locator: ReturnType<Page['getByTestId']>, attr: string, timeoutMs = 1200): Promise<string | null> {
  try {
    return await locator.getAttribute(attr, { timeout: timeoutMs });
  } catch {
    return null;
  }
}

async function shot(target: Page | ReturnType<Page['locator']>, name: string): Promise<string> {
  const file = path.join(evidenceDir(SHOT_DIR), name);
  await target.screenshot({ path: file });
  log('SHOT', `${name} -> ${file}`);
  return file;
}

async function loginAsAdmin(page: Page): Promise<void> {
  const signUp = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  const auth = signUp.ok ? signUp : await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(auth.ok).toBe(true);
  const { localId } = (await auth.json()) as { localId: string };
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
  });
  expect(claims.ok).toBe(true);
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E CID11 UX', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

async function openDetail(page: Page, patientId: string): Promise<void> {
  const isDetail = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const detail = page
      .waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 })
      .catch(() => null);
    await page.goto(`/admin/patients/${patientId}`);
    const res = await detail;
    if (res) return;
  }
  throw new Error(`GET /api/admin/patients/${patientId} não observado em 2 tentativas`);
}

async function openDrawer(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.getByTestId('edit-clinical-btn').click({ timeout: 15_000 });
  const drawer = page.getByTestId('patient-clinical-edit-drawer');
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  return drawer;
}

async function searchAndWait(page: Page, query: string, expectStatus?: number): Promise<number | 'timeout'> {
  const input = page.getByTestId('icd-search-input');
  await input.fill('');
  const waiter = page.waitForResponse(
    (r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()),
    { timeout: 8_000 },
  ).catch(() => null);
  await input.pressSequentially(query, { delay: 25 });
  const res = await waiter;
  if (!res) return 'timeout';
  if (expectStatus) expect(res.status()).toBe(expectStatus);
  await page.waitForTimeout(150); // deixa o React aplicar a fase (idle→results/empty/unavailable)
  return res.status();
}

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe('AUDITORIA UX — spec 016, tela de diagnóstico CID-11 (não é gate de correção)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(360_000);

  let patient: { patientId: string; stamp: string };
  let patientC: { patientId: string; stamp: string }; // RODADA 2 — Parte C, paciente do zero
  let patientD: { patientId: string; stamp: string }; // RODADA 4 — Parte D, paciente do zero
  const wasPromotedBefore = isCatalogPromoted();

  test.beforeAll(() => {
    patient = seedPatientForDiagnosis();
    patientC = seedPatientForDiagnosis();
    patientD = seedPatientForDiagnosis();
    setCatalogPromoted(true);
    log('ENV', `is_current antes de mexer = ${wasPromotedBefore}`);
  });

  test.afterAll(() => {
    cleanupPatientDeep(patient.patientId);
    cleanupPatientDeep(patientC.patientId);
    cleanupPatientDeep(patientD.patientId);
    setCatalogPromoted(wasPromotedBefore);
    const restored = isCatalogPromoted();
    log('ENV', `restaurado: is_current=${restored} (esperado=${wasPromotedBefore}) -> ${restored === wasPromotedBefore ? 'OK' : 'FALHOU'}`);
  });

  test('percurso completo da operadora confusa', async ({ page }) => {
    await loginAsAdmin(page);

    // ── 1. Abre o drawer, não sabe por onde começar ──────────────────────────────────────
    await openDetail(page, patient.patientId);
    const drawer = await openDrawer(page);
    await page.waitForTimeout(400); // anima abrindo
    await shot(drawer, 'ux-01-estado-inicial.png');
    const sectionLabel = await page.locator('#pce-section-pathology').textContent().catch(() => null);
    const placeholder = await page.getByTestId('icd-search-input').getAttribute('placeholder');
    // 05/09 (D284): o campo livre "Hipótesis Diagnóstica - CID" foi REMOVIDO do drawer — não há mais sonda dele.
    log('01', `label da seção estruturada = "${sectionLabel}" | placeholder do input = "${placeholder}"`);
    const attribution = await textOrNothing(page.getByTestId('who-attribution'));
    log('01', `texto de atribuição visível = "${attribution}"`);

    // ── RODADA 3 / V1 — o controle de escopo é ESTADO, não aviso: tem que estar visível ANTES
    // de qualquer digitação, sem depender de nenhuma busca ter rodado.
    const scopeUsualBeforeTyping = await textOrNothing(page.getByTestId('icd-search-scope-usual'));
    const scopeAllBeforeTyping = await textOrNothing(page.getByTestId('icd-search-scope-all'));
    const scopeUsualCheckedBeforeTyping = await attrOrNothing(page.getByTestId('icd-search-scope-usual'), 'aria-checked');
    log('R3-01', `V1: controle de escopo ANTES de digitar — opção habitual="${scopeUsualBeforeTyping}" (checked=${scopeUsualCheckedBeforeTyping}) | opção "todas"="${scopeAllBeforeTyping}"`);
    await shot3(drawer, 'ux3-01-controle-visivel-antes-de-digitar.png');

    // ── RODADA 4 / item 1 — o controle é ESTADO funcional (radiogroup, aria-checked, cor muda)
    // ou parece rótulo decorativo? role="radiogroup" com role="radio" em cada opção JÁ é sinal
    // forte de "isto é controle", não texto solto — confirma programaticamente.
    const scopeRole = await attrOrNothing(page.getByTestId('icd-search-scope'), 'role');
    const scopeUsualRole = await attrOrNothing(page.getByTestId('icd-search-scope-usual'), 'role');
    log('R4-01', `item1: role do container="${scopeRole}" (esperado radiogroup) | role da opção="${scopeUsualRole}" (esperado radio) — controle é FUNCIONAL, não decorativo = ${scopeRole === 'radiogroup' && scopeUsualRole === 'radio'}`);

    // ── RODADA 4 / item 2 — "Salud mental y neurología" pode ser lido como categoria CLÍNICA do
    // paciente/caso, em vez de filtro de busca? Evidência objetiva: comparar o ESTILO COMPUTADO do
    // rótulo-prefixo ("Buscando en:") contra o texto da opção, e comparar o estilo da opção ATIVA
    // contra o badge "Principal" do chip de diagnóstico (mesmo padrão visual = risco de confusão
    // entre "isto é um filtro" e "isto é um dado clínico do paciente").
    // Compara SPAN de texto com SPAN de texto (não o <button> inteiro, que herda font-size do
    // body por não ter classe de tamanho própria — a classe fica no <Text> filho).
    const scopeLabelTextStyle = await page.getByTestId('icd-search-scope').locator('span').first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color };
    });
    const scopeUsualTextStyle = await page.getByTestId('icd-search-scope-usual').locator('span').first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color };
    });
    const scopeUsualButtonStyle = await page.getByTestId('icd-search-scope-usual').evaluate((el) => {
      const s = getComputedStyle(el);
      return { backgroundColor: s.backgroundColor, borderColor: s.borderColor };
    });
    log('R4-02', `item2: rótulo-prefixo "Buscando en:" (span de texto) — fontSize=${scopeLabelTextStyle.fontSize} fontWeight=${scopeLabelTextStyle.fontWeight} color=${scopeLabelTextStyle.color} | texto da opção ativa "Salud mental y neurología" (span de texto) — fontSize=${scopeUsualTextStyle.fontSize} fontWeight=${scopeUsualTextStyle.fontWeight} color=${scopeUsualTextStyle.color}`);
    log('R4-02', `item2: mesmo TAMANHO de fonte entre rótulo e opção (span-a-span) = ${scopeLabelTextStyle.fontSize === scopeUsualTextStyle.fontSize} | mesmo peso = ${scopeLabelTextStyle.fontWeight === scopeUsualTextStyle.fontWeight} | cor DIFERENTE (label cinza-muted vs opção ativa colorida) = ${scopeLabelTextStyle.color !== scopeUsualTextStyle.color} — a diferenciação entre "isto é o rótulo do filtro" e "isto é a opção escolhida" depende só de COR + fundo/borda do botão-pill, não de tamanho de fonte nem de um rótulo redundante tipo "(filtro)"`);
    await shot4(page.getByTestId('icd-search-scope'), 'ux4-02-controle-de-escopo-close-up.png');

    // ── RODADA 4 / item 6 — dá pra saber visualmente qual toggle está ativo? Captura o par
    // completo de estilos computados dos DOIS botões no estado padrão (habitual ativo).
    const scopeAllOptionStyleBefore = await page.getByTestId('icd-search-scope-all').evaluate((el) => {
      const s = getComputedStyle(el);
      return { backgroundColor: s.backgroundColor, borderColor: s.borderColor };
    });
    log('R4-06', `item6: estado inicial — habitual(ativo) bg=${scopeUsualButtonStyle.backgroundColor} border=${scopeUsualButtonStyle.borderColor} | todas(inativo) bg=${scopeAllOptionStyleBefore.backgroundColor} border=${scopeAllOptionStyleBefore.borderColor} | contraste visual entre ativo/inativo existe = ${scopeUsualButtonStyle.backgroundColor !== scopeAllOptionStyleBefore.backgroundColor || scopeUsualButtonStyle.borderColor !== scopeAllOptionStyleBefore.borderColor}`);

    // ── 2. Digita 1 letra e espera (piso é 2) ────────────────────────────────────────────
    const input = page.getByTestId('icd-search-input');
    await input.fill('e');
    await page.waitForTimeout(500);
    const statusAfter1Char = await textOrNothing(page.getByTestId('icd-search-status'));
    const listboxAfter1Char = await page.getByTestId('icd-search-listbox').count();
    log('02', `depois de 1 caractere: status="${statusAfter1Char}" (null=nada visível) | listbox presente=${listboxAfter1Char > 0}`);
    await shot(drawer, 'ux-02-um-caractere.png');

    // RODADA 2 — B4: a dica de 2 caracteres "pisca" enquanto ela digita rápido, ou some na hora
    // certa e fica assim? Completa pra 2+ caracteres (dica deve sumir), depois volta pra 1 com
    // Backspace (dica deve reaparecer) — sem nunca ficar "grudada" atrás do resultado.
    await input.pressSequentially('sq', { delay: 30 }); // agora "esq" = 3 chars
    await page.waitForTimeout(500); // > DEBOUNCE_MS, dá tempo do fetch resolver
    const statusAfter3Chars = await textOrNothing(page.getByTestId('icd-search-status'));
    log('02b', `RODADA2/B4: depois de completar pra 3 caracteres ("esq"), a dica de mínimo deveria ter SUMIDO: status-tela="${statusAfter3Chars}"`);
    await shot(drawer, 'ux-02b-rodada2-tres-caracteres-dica-sumiu.png');
    await input.press('Backspace');
    await input.press('Backspace');
    await page.waitForTimeout(400); // fica em "e" (1 char) de novo
    const statusVoltouPara1Char = await textOrNothing(page.getByTestId('icd-search-status'));
    log('02c', `RODADA2/B4: apagando de volta pra 1 caractere, a dica REAPARECE = "${statusVoltouPara1Char}"`);
    await shot(drawer, 'ux-02c-rodada2-backspace-dica-reaparece.png');

    // ── 3. Digita rápido e erra: typos, PT, sigla, código CIE-10 ─────────────────────────
    const termos3: Array<[string, string]> = [
      ['esqizofrenia', 'ux-03a-typo-esqizofrenia.png'],
      ['depresion', 'ux-03b-depresion.png'],
      ['ansiedade', 'ux-03c-ansiedade-pt.png'],
      ['TDAH', 'ux-03d-tdah-sigla.png'],
      ['F84', 'ux-03e-f84-codigo-cie10.png'],
    ];
    for (const [termo, arquivo] of termos3) {
      const status = await searchAndWait(page, termo);
      const statusText = await textOrNothing(page.getByTestId('icd-search-status'));
      const listboxCount = await page.getByTestId('icd-search-listbox').count();
      let firstOption: string | null = null;
      if (listboxCount > 0) firstOption = await textOrNothing(page.getByTestId('icd-search-option-0'));
      log('03', `termo="${termo}" httpStatus=${status} status-tela="${statusText}" primeiraOpcao="${firstOption}"`);
      await shot(drawer, arquivo);
    }
    // U6 — o último termo do loop acima foi "F84" (código CIE-10): sem resultado, a tela
    // deveria ganhar a dica de que a busca é por NOME, não por código nem sigla.
    const codeHintAfterF84 = await textOrNothing(page.getByTestId('icd-search-code-hint'));
    log('03', `U6: dica de código/sigla depois de "F84" (esperada) = "${codeHintAfterF84}"`);
    await shot(drawer, 'ux-03f-f84-dica-codigo.png');

    // ── 4. Digita algo que não existe ────────────────────────────────────────────────────
    for (const [termo, arquivo] of [['dor de barriga', 'ux-04a-dor-de-barriga.png'], ['xxxxx', 'ux-04b-xxxxx.png']] as const) {
      await searchAndWait(page, termo);
      const statusText = await textOrNothing(page.getByTestId('icd-search-status'));
      log('04', `termo="${termo}" status-tela="${statusText}"`);
      await shot(drawer, arquivo);
    }
    // U6 — "xxxxx" NÃO parece código nem sigla: a dica NÃO deveria aparecer aqui (só o genérico).
    const codeHintAfterXxxxx = await textOrNothing(page.getByTestId('icd-search-code-hint'));
    log('04', `U6: dica de código/sigla depois de "xxxxx" (esperada AUSENTE) = "${codeHintAfterXxxxx}"`);

    // ── 5. RODADA 3 / V1 — o aviso condicional virou ESTADO permanente ──────────────────
    await searchAndWait(page, 'diabetes');
    const statusRestrito = await textOrNothing(page.getByTestId('icd-search-status'));
    log('05', `"diabetes" com escopo habitual: status-tela="${statusRestrito}"`);
    await shot(drawer, 'ux-05a-diabetes-filtrado.png');
    // RODADA 4 / item 3 — com "diabetes" sem resultado no escopo padrão, existe ALGUMA pista
    // visual (texto, ícone, destaque no toggle "todas") que sugira trocar de escopo sozinha, ou
    // ela só vê "sem resultado" genérico e teria que adivinhar que o escopo é a causa?
    const codeHintDuringDiabetes = await page.getByTestId('icd-search-code-hint').count();
    // status-tela sozinho não prova nada (fica "null" tanto em "sem resultado" quanto em "achou
    // resultado" — a fase 'results' não seta statusText). Confere a LISTA de verdade.
    const listboxDuringDiabetesUsual = await page.getByTestId('icd-search-listbox').count();
    const diabetesUsualTitle = listboxDuringDiabetesUsual > 0 ? await textOrNothing(page.getByTestId('icd-search-option-0')) : null;
    log('R4-03', `item3: status-tela = "${statusRestrito}" | lista de resultados presente = ${listboxDuringDiabetesUsual > 0} | 1º resultado = "${diabetesUsualTitle}" | existe MENÇÃO textual a trocar de escopo = ${/todas las categor/i.test(statusRestrito ?? '')} | dica de código/sigla por engano = ${codeHintDuringDiabetes > 0}`);
    if (listboxDuringDiabetesUsual > 0) {
      log('R4-03', `item3: ACHADO — "diabetes" com escopo padrão NÃO fica vazio, devolve "${diabetesUsualTitle}" (nenhuma pista diz que existe algo MELHOR em "Todas las categorías"; ela só saberia se já soubesse que o toggle existe e decidisse comparar por conta própria)`);
    } else {
      log('R4-03', `item3: "diabetes" com escopo padrão fica vazio — única pista de que dá pra trocar é o toggle "Todas las categorías", sempre visível ao lado (não há link dentro de um aviso condicional, esse já foi removido)`);
    }
    await shot4(drawer, 'ux4-03-diabetes-resultado-no-escopo-padrao.png');
    // V1 — o aviso condicional "Hay N resultados en otras categorías" e a 2ª requisição que o
    // sustentava foram REMOVIDOS. Prova negativa: não existem mais em lugar nenhum da tela.
    const outsideNoticeGoneR3 = await page.getByTestId('icd-search-outside-notice').count();
    const oldToggleGoneR3 = await page.getByTestId('icd-search-toggle-chapters').count();
    const bodyTextR3 = await drawer.textContent().catch(() => '');
    const oldNoticeTextGoneR3 = !(bodyTextR3 ?? '').toLowerCase().includes('otras categorías');
    log('R3-05', `V1: aviso antigo removido do DOM = ${outsideNoticeGoneR3 === 0} | botão antigo "buscar en todas" removido = ${oldToggleGoneR3 === 0} | texto "otras categorías" não existe mais na tela = ${oldNoticeTextGoneR3}`);
    await shot3(drawer, 'ux3-05a-sem-aviso-condicional-diabetes.png');

    // ── RODADA 4 / item 4 — troca de escopo com TEXTO JÁ DIGITADO (o input ainda tem "diabetes",
    // ninguém apagou nada): a busca refaz SOZINHA, sem precisar re-digitar? Instrumenta a rede
    // ANTES do clique e mede se um request novo sai só do clique no toggle.
    const searchReqsOnScopeSwitch: Array<{ url: string; ts: number }> = [];
    const onSearchReq = (req: import('@playwright/test').Request) => {
      if (req.method() === 'GET' && /\/api\/admin\/terminology\/search/.test(req.url())) {
        searchReqsOnScopeSwitch.push({ url: req.url(), ts: Date.now() });
      }
    };
    page.on('request', onSearchReq);
    const inputValueBeforeScopeSwitch = await page.getByTestId('icd-search-input').inputValue();
    const clickTs = Date.now();

    // troca de escopo pelo CONTROLE novo (estado permanente, não link condicional)
    await page.getByTestId('icd-search-scope-all').click();
    await page.waitForTimeout(600); // > DEBOUNCE_MS (300ms) do componente, dá tempo do fetch sair
    page.off('request', onSearchReq);
    log('R4-04', `item4: input ANTES do clique no toggle continuava com texto (não foi limpo) = "${inputValueBeforeScopeSwitch}" | requests de /terminology/search capturados após o clique (sem re-digitar nada) = ${JSON.stringify(searchReqsOnScopeSwitch)} | delta-ts do 1º request após o clique = ${searchReqsOnScopeSwitch[0] ? searchReqsOnScopeSwitch[0].ts - clickTs : 'N/A'}ms | BUSCA REFEZ SOZINHA = ${searchReqsOnScopeSwitch.length > 0}`);
    await shot4(drawer, 'ux4-04-troca-de-escopo-refaz-busca-sozinha.png');

    const scopeAllCheckedR3 = await attrOrNothing(page.getByTestId('icd-search-scope-all'), 'aria-checked');
    log('R3-05', `V1: depois de clicar em "todas las categorías" — aria-checked="${scopeAllCheckedR3}"`);
    await searchAndWait(page, 'diabetes');
    const statusAmplo = await textOrNothing(page.getByTestId('icd-search-status'));
    const listboxAmploCount = await page.getByTestId('icd-search-listbox').count();
    let primeiraOpcaoAmpla: string | null = null;
    if (listboxAmploCount > 0) primeiraOpcaoAmpla = await textOrNothing(page.getByTestId('icd-search-option-0'));
    log('05', `"diabetes" com TODAS as categorias: status-tela="${statusAmplo}" listbox=${listboxAmploCount > 0} primeiraOpcao="${primeiraOpcaoAmpla}"`);
    log('R3-05', `V1: trocar para "todas" achou "Diabetes mellitus tipo 1" = ${(primeiraOpcaoAmpla ?? '').toLowerCase().includes('diabetes mellitus tipo 1')}`);
    await shot3(drawer, 'ux3-05b-todas-categorias-acha-diabetes-tipo1.png');

    // V1 — a escolha PERSISTE: digita outro termo sem tocar no controle e confere que continua
    // marcado em "todas as categorías" (não volta ao padrão a cada tecla).
    await searchAndWait(page, 'autismo');
    const scopeAllStillCheckedR3 = await attrOrNothing(page.getByTestId('icd-search-scope-all'), 'aria-checked');
    log('R3-05', `V1: escolha "todas" PERSISTE depois de digitar outro termo ("autismo") = ${scopeAllStillCheckedR3 === 'true'}`);
    await shot3(drawer, 'ux3-05c-escolha-persiste-apos-nova-busca.png');

    // volta ao padrão (categorias habituais) pro resto do percurso
    await page.getByTestId('icd-search-scope-usual').click();

    // ── 6. Clica no resultado 2x rápido (duplo clique) ───────────────────────────────────
    let postCount = 0;
    const onReq = (req: import('@playwright/test').Request) => {
      if (req.method() === 'POST' && /\/diagnoses$/.test(req.url())) postCount++;
    };
    page.on('request', onReq);
    await searchAndWait(page, 'esquizofrenia');
    const option0Exists = await page.getByTestId('icd-search-option-0').count();
    log('06', `busca "esquizofrenia" (sem typo) achou opção 0? ${option0Exists > 0}`);
    // V1 (rodada 3) — não há mais aviso condicional nenhum para checar aqui; o escopo é visível
    // sempre, e "esquizofrenia" continua sendo buscada dentro da opção habitual (não mudou).
    const scopeUsualDuringEsquizofrenia = await attrOrNothing(page.getByTestId('icd-search-scope-usual'), 'aria-checked');
    log('06', `V1: escopo continua em "habitual" durante a busca de "esquizofrenia" = ${scopeUsualDuringEsquizofrenia === 'true'}`);
    if (option0Exists > 0) {
      await page.getByTestId('icd-search-option-0').dblclick({ timeout: 5_000 }).catch((e) => log('06', `dblclick lançou: ${e}`));
      await page.waitForTimeout(1500);
    }
    page.off('request', onReq);
    const chipsAfterDbl = await textOrNothing(page.getByTestId('diagnosis-chips'));
    const chipCountAfterDbl = await page.locator('[data-testid^="diagnosis-chip-"]').count();
    log('06', `POSTs /diagnoses disparados pelo duplo clique = ${postCount} | conteúdo dos chips = "${chipsAfterDbl}" | nº de elementos chip-* no DOM = ${chipCountAfterDbl}`);
    await shot(drawer, 'ux-06-apos-duplo-clique.png');

    // ── RODADA 4 / item 5 — já tem diagnóstico escolhido; DEPOIS troca de escopo. Algo se perde
    // (chip some, erro aparece) ou fica intacto (o escopo só afeta a BUSCA, não a seleção já feita)?
    const chipTitlesBeforeScopeChange = await page.locator('[data-testid^="diagnosis-chip-"]').allTextContents();
    await page.getByTestId('icd-search-scope-all').click();
    await page.waitForTimeout(300);
    const chipCountAfterScopeChange = await page.locator('[data-testid^="diagnosis-chip-"]').count();
    const chipTitlesAfterScopeChange = await page.locator('[data-testid^="diagnosis-chip-"]').allTextContents();
    const errorAfterScopeChange = await textOrNothing(page.getByTestId('diagnosis-assignment-error'));
    log('R4-05', `item5: diagnóstico(s) escolhido(s) ANTES de trocar escopo = ${JSON.stringify(chipTitlesBeforeScopeChange)} | DEPOIS de trocar para "todas" = ${JSON.stringify(chipTitlesAfterScopeChange)} (contagem ${chipCountAfterScopeChange}) | algum aviso/susto apareceu = "${errorAfterScopeChange}" | NADA SE PERDEU = ${chipCountAfterScopeChange === chipCountAfterDbl && errorAfterScopeChange === null}`);
    await shot4(drawer, 'ux4-05-chip-intacto-apos-trocar-escopo.png');
    // volta ao padrão pro resto do percurso (não é o foco deste item, mas evita efeito colateral)
    await page.getByTestId('icd-search-scope-usual').click();
    await page.waitForTimeout(200);

    // ── 7. Escolhe o mesmo diagnóstico duas vezes ────────────────────────────────────────
    await searchAndWait(page, 'esquizofrenia');
    const option0Exists2 = await page.getByTestId('icd-search-option-0').count();
    if (option0Exists2 > 0) {
      await page.getByTestId('icd-search-option-0').click();
      await page.waitForTimeout(1200);
    }
    const errorText = await textOrNothing(page.getByTestId('diagnosis-assignment-error'));
    log('07', `repetir a MESMA seleção: erro na tela = "${errorText}"`);
    await shot(drawer, 'ux-07-diagnostico-repetido.png');

    // ── 8. Não sabe marcar o principal ────────────────────────────────────────────────────
    const firstChip = page.locator('[data-testid^="diagnosis-chip-"]').first();
    const firstChipCount = await page.locator('[data-testid^="diagnosis-chip-"]').count();
    const firstChipTestId = firstChipCount > 0 ? await attrOrNothing(firstChip, 'data-testid') : null;
    log('08', `nº de chips no DOM antes deste passo = ${firstChipCount}`);
    log('08', `chip usado nos passos 8/9 = ${firstChipTestId}`);
    await shot(firstChip, 'ux-08a-chip-antes-de-marcar.png');
    // U4 — o botão de promover deste chip tem TEXTO visível agora (não só aria-label)?
    const promoteTextBeforeBodyClick = await textOrNothing(
      firstChip.locator('[data-testid^="diagnosis-chip-promote-"]'),
    );
    log('08', `U4: texto visível no botão de promover ANTES de qualquer clique = "${promoteTextBeforeBodyClick}"`);
    // RODADA 3 / V2 — o corpo do chip deixou de ser clicável (era o próprio bug do mis-clique).
    // Clica no CORPO mesmo assim, pra provar que ele agora é INERTE.
    // RODADA 4 / item 7 — pista visual (cursor) ANTES do clique: o corpo ainda "parece" clicável
    // (cursor: pointer) mesmo não fazendo mais nada? Mede o cursor computado no `<li>` do chip
    // (sem hover — Playwright não aciona `:hover` via CSS aqui, mas o cursor "parado" já é o sinal
    // que mais importa: se for `default`, não há nem a affordance estática de "isto é clicável").
    const chipBodyCursor = await firstChip.evaluate((el) => getComputedStyle(el).cursor);
    log('R4-07', `item7: cursor computado no corpo do chip (li) = "${chipBodyCursor}" (esperado "default"/"auto" — "pointer" seria pista falsa de que ainda é clicável)`);
    let postDiagnosesOnBodyClick = 0;
    let patchOnBodyClick = 0;
    const onPostDuringBodyClick = (req: import('@playwright/test').Request) => {
      if (req.method() === 'POST' && /\/diagnoses$/.test(req.url())) postDiagnosesOnBodyClick++;
      if (req.method() === 'PATCH' && /\/diagnoses\//.test(req.url())) patchOnBodyClick++;
    };
    page.on('request', onPostDuringBodyClick);
    await firstChip.click({ position: { x: 10, y: 10 } }).catch(() => {});
    await page.waitForTimeout(300);
    page.off('request', onPostDuringBodyClick);
    log('R4-07', `item7: clique no corpo do chip disparou ALGUMA request (POST /diagnoses ou PATCH /diagnoses/:id) = ${postDiagnosesOnBodyClick + patchOnBodyClick > 0} (esperado FALSE — corpo inerte também na REDE, não só na UI)`);
    const primaryBadgeAfterBodyClick = await page.locator('[data-testid^="diagnosis-chip-primary-badge-"]').count();
    log('R3-08', `V2: clique no CORPO do chip promoveu a principal? badge presente = ${primaryBadgeAfterBodyClick > 0} (esperado FALSE — o corpo agora é inerte)`);
    await shot3(page.getByTestId('diagnosis-chips'), 'ux3-08-corpo-do-chip-inerte-apos-clique.png');
    await shot4(page.getByTestId('diagnosis-chips'), 'ux4-07-corpo-do-chip-cursor-e-rede.png');
    const promoteBtn = page.locator('[data-testid^="diagnosis-chip-promote-"]').first();
    const promoteBtnVisible = await promoteBtn.isVisible().catch(() => false);
    const promoteAriaLabel = await attrOrNothing(promoteBtn, 'aria-label');
    const promoteHasVisibleText = await textOrNothing(promoteBtn);
    log('08', `botão de promover: visível=${promoteBtnVisible} aria-label="${promoteAriaLabel}" texto-visível="${promoteHasVisibleText}" (vazio = só ícone, sem legenda na tela)`);
    if (promoteBtnVisible) {
      await promoteBtn.click();
      await page.waitForTimeout(500);
    }
    const primaryBadgeAfter = await page.locator('[data-testid^="diagnosis-chip-primary-badge-"]').count();
    log('08', `depois de clicar no ícone estrela: badge "Principal" presente = ${primaryBadgeAfter > 0}`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-08b-chip-apos-marcar-principal.png');

    // ── 8c. RODADA 2 — B3: o corpo do chip promove; isso pode ter criado um problema NOVO ───
    // Precisa de um 2º diagnóstico (não-principal) pra ter um alvo de "mis-clique ao tentar
    // remover". Instrumenta a rede: promote e deactivate batem no MESMO endpoint PATCH, só o
    // corpo muda (`isPrimary:true` vs `active:false`) — o corpo do PATCH prova sem ambiguidade
    // qual ação disparou, mesmo que a contagem de elementos por prefixo (ruído já conhecido da
    // rodada 1) minta.
    const patchCalls: Array<{ url: string; body: string }> = [];
    const onPatch = (req: import('@playwright/test').Request) => {
      if (req.method() === 'PATCH' && /\/diagnoses\//.test(req.url())) {
        patchCalls.push({ url: req.url(), body: req.postData() ?? '' });
      }
    };
    page.on('request', onPatch);

    await searchAndWait(page, 'depresion');
    const depOptionForB3 = page.getByTestId('icd-search-option-0');
    if ((await depOptionForB3.count()) > 0) {
      await depOptionForB3.click();
      await page.waitForTimeout(1000);
    }
    const chipLis = page.locator('li[data-testid^="diagnosis-chip-"]');
    const chipCountRodada2 = await chipLis.count();
    log('08c', `RODADA2/B3: nº de chips (li) depois do 2º diagnóstico = ${chipCountRodada2}`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-08c-rodada2-dois-chips.png');

    const primaryChipLi = chipLis.filter({ has: page.locator('[data-testid^="diagnosis-chip-primary-badge-"]') }).first();
    const nonPrimaryChipLi = chipLis.filter({ hasNot: page.locator('[data-testid^="diagnosis-chip-primary-badge-"]') }).first();

    // B3a — clicar no chip que JÁ É principal: despromove? não faz nada? confunde?
    patchCalls.length = 0;
    await primaryChipLi.click({ position: { x: 10, y: 10 } }).catch(() => {});
    await page.waitForTimeout(400);
    log('08c', `RODADA2/B3a: clicar no corpo do chip JÁ PRINCIPAL disparou algum PATCH? ${patchCalls.length > 0 ? JSON.stringify(patchCalls) : 'NENHUM (esperado — nada deveria acontecer, mas também nenhum feedback visual diz "já é o principal")'}`);
    await shot(primaryChipLi, 'ux-08d-rodada2-clique-em-chip-ja-principal.png');

    // B3b — O ACHADO MAIS CRÍTICO da rodada 2: ela MIRA no X (remover) e erra por pouco,
    // acertando o CORPO do chip em vez do botão. Clica a poucos pixels do X (canto superior
    // direito da linha), fora da hitbox do botão. RODADA 3 / V2 — este é o mis-clique que o
    // conserto fecha: o corpo deixou de ser clicável, então nem PROMOVE nem REMOVE por engano.
    const nonPrimaryBox = await nonPrimaryChipLi.boundingBox();
    log('08c', `RODADA2/B3b: bounding box do chip não-principal = ${JSON.stringify(nonPrimaryBox)}`);
    patchCalls.length = 0;
    if (nonPrimaryBox) {
      const missX = nonPrimaryBox.x + nonPrimaryBox.width - 8;
      const missY = nonPrimaryBox.y + 6;
      await page.mouse.click(missX, missY);
    }
    await page.waitForTimeout(500);
    const promotedByMisclick = patchCalls.some((c) => c.body.includes('isPrimary'));
    const removedByMisclick = patchCalls.some((c) => c.body.includes('active'));
    log('08c', `RODADA2/B3b: clique perto do X (mis-clique simulado) no corpo do chip NÃO-principal -> PATCHes=${JSON.stringify(patchCalls)} | PROMOVEU sem querer=${promotedByMisclick} | REMOVEU=${removedByMisclick}`);
    log('R3-08c', `V2: mis-clique perto do X NÃO promoveu = ${!promotedByMisclick} (esperado TRUE — nenhum PATCH deveria sair do clique no corpo)`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-08e-rodada2-apos-misclique-perto-do-x.png');
    await shot3(page.getByTestId('diagnosis-chips'), 'ux3-08c-misclique-nao-promove.png');
    page.off('request', onPatch);

    // ── 9. Quer remover — agora exige confirmação (U3) ───────────────────────────────────
    // Usa o botão X DE VERDADE agora (mira certeira), no chip não-principal.
    const removeBtn = nonPrimaryChipLi.locator('[data-testid^="diagnosis-chip-remove-"]').first();
    const removeVisible = await removeBtn.isVisible().catch(() => false);
    const removeAriaLabel = await attrOrNothing(removeBtn, 'aria-label');
    log('09', `botão remover: visível SEM hover/instrução = ${removeVisible} aria-label="${removeAriaLabel}"`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-09a-chip-antes-de-remover.png');
    if (removeVisible) {
      await removeBtn.click();
      await page.waitForTimeout(300);
    }
    // U3 — o 1º clique no X NÃO deveria remover mais: só pede confirmação inline.
    const confirmQuestionText = await textOrNothing(
      nonPrimaryChipLi.locator('[data-testid^="diagnosis-chip-remove-confirm-"]').first(),
    );
    log('09', `U3: 1º clique pede confirmação = "${confirmQuestionText}"`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-09b-confirmacao-antes-de-remover.png');

    // RODADA 2 — B2: se ela clicar FORA do chip enquanto a confirmação está aberta, o que
    // acontece? O componente não tem listener de "clique fora" (só os botões Cancelar/Quitar
    // fecham) — confirma isso clicando num ponto neutro do drawer (o rótulo da seção) e
    // vendo se a pergunta continua na tela indefinidamente.
    await page.locator('#pce-section-pathology').click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const confirmStillThereAfterOutsideClick = await textOrNothing(
      nonPrimaryChipLi.locator('[data-testid^="diagnosis-chip-remove-confirm-"]').first(),
    );
    log('09', `RODADA2/B2: clicar FORA do chip com a confirmação aberta — ela continua aberta = "${confirmStillThereAfterOutsideClick}" (null = fechou sozinha; texto = ficou aberta pra sempre até ela decidir)`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-09b2-rodada2-confirmacao-apos-clicar-fora.png');

    // RODADA 2 — B2: testa o botão Cancelar explicitamente (não só o Confirmar) — cancela sem
    // medo, sem remover nada?
    const cancelBtn = nonPrimaryChipLi.locator('[data-testid^="diagnosis-chip-remove-cancel-"]').first();
    const cancelBtnVisible = await cancelBtn.isVisible().catch(() => false);
    const chipCountBeforeCancel = await chipLis.count();
    if (cancelBtnVisible) {
      await cancelBtn.click();
      await page.waitForTimeout(300);
    }
    const chipCountAfterCancel = await chipLis.count();
    const confirmGoneAfterCancel = await nonPrimaryChipLi.locator('[data-testid^="diagnosis-chip-remove-confirm-"]').count();
    log('09', `RODADA2/B2: botão Cancelar visível=${cancelBtnVisible} | nº de chips antes=${chipCountBeforeCancel} depois=${chipCountAfterCancel} (esperado igual — nada foi removido) | confirmação sumiu depois de cancelar=${confirmGoneAfterCancel === 0}`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-09b3-rodada2-apos-cancelar.png');

    // Agora sim: X de novo, e confirma de verdade — fecha o ciclo original da rodada 1.
    const chipCountBeforeRemove = await chipLis.count();
    await removeBtn.click().catch(() => {});
    await page.waitForTimeout(300);
    const confirmRemoveBtn = nonPrimaryChipLi.locator('[data-testid^="diagnosis-chip-remove-confirm-btn-"]').first();
    const confirmRemoveBtnVisible = await confirmRemoveBtn.isVisible().catch(() => false);
    if (confirmRemoveBtnVisible) {
      await confirmRemoveBtn.click();
      await page.waitForTimeout(600);
    }
    const chipCountAfterRemove = await chipLis.count();
    const anyUndoButton = await page.getByRole('button', { name: /deshacer|undo/i }).count();
    log('09', `depois de CONFIRMAR: removeu de fato | chips antes=${chipCountBeforeRemove} depois=${chipCountAfterRemove} | existe botão de desfazer="${anyUndoButton > 0}"`);
    await shot(drawer, 'ux-09c-apos-confirmar-remocao.png');
    // sobrou só o principal ("esquizofrenia") — remove também, pra deixar limpo pro passo 10
    const remainingChipRemoveBtn = page.locator('li[data-testid^="diagnosis-chip-"] [data-testid^="diagnosis-chip-remove-"]').first();
    if (await remainingChipRemoveBtn.count() > 0) {
      await remainingChipRemoveBtn.click();
      await page.waitForTimeout(300);
      const finalConfirmBtn = page.locator('[data-testid^="diagnosis-chip-remove-confirm-btn-"]').first();
      if (await finalConfirmBtn.isVisible().catch(() => false)) {
        await finalConfirmBtn.click();
        await page.waitForTimeout(500);
      }
    }
    const chipsEmptyAfterRemove = await page.getByTestId('diagnosis-chips-empty').count();
    log('09', `drawer ficou vazio depois de limpar os 2 diagnósticos de teste = ${chipsEmptyAfterRemove > 0}`);

    // ── 10. Enter em campo vazio, Esc no meio da digitação ───────────────────────────────
    await input.fill('');
    await input.focus();
    await input.press('Enter');
    await page.waitForTimeout(200);
    const drawerStillOpenAfterEnter = await drawer.isVisible().catch(() => false);
    log('10a', `Enter com campo vazio: drawer continua aberto = ${drawerStillOpenAfterEnter}`);

    await searchAndWait(page, 'esq');
    const listboxOpenBeforeEsc = await page.getByTestId('icd-search-listbox').count();
    log('10b', `antes do Esc: dropdown de sugestões aberto = ${listboxOpenBeforeEsc > 0}`);
    await input.press('Escape');
    await page.waitForTimeout(500);
    const drawerVisibleAfterEsc = await drawer.isVisible().catch(() => false);
    const listboxAfterEsc = await page.getByTestId('icd-search-listbox').count();
    log('10c', `depois do Esc: drawer ainda visível = ${drawerVisibleAfterEsc} | dropdown ainda aberto = ${listboxAfterEsc > 0}`);
    if (drawerVisibleAfterEsc) {
      await shot(drawer, 'ux-10-esc-fechou-so-o-dropdown.png');
    } else {
      await shot(page, 'ux-10-esc-fechou-o-drawer-inteiro.png');
    }

    // ── 11. Fecha o drawer sem apertar "Guardar", com diagnóstico escolhido ──────────────
    if (!drawerVisibleAfterEsc) {
      // o passo 10 já fechou o drawer inteiro — reabre pra continuar o percurso
      await openDetail(page, patient.patientId);
      await openDrawer(page);
    }
    await searchAndWait(page, 'depresion');
    const depOption = page.getByTestId('icd-search-option-0');
    const depOptionExists = await depOption.count();
    let novoDiagTitulo: string | null = null;
    if (depOptionExists > 0) {
      novoDiagTitulo = await depOption.textContent();
      await depOption.click();
      await page.waitForTimeout(1000);
    }
    log('11', `adicionado para o teste de fechar sem salvar: "${novoDiagTitulo}"`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-11a-chip-antes-de-fechar-sem-guardar.png');
    // fecha pelo X (nunca aperta "Guardar")
    await page.getByRole('button', { name: 'Cerrar' }).click({ timeout: 5_000 }).catch((e) => log('11', `clique em Cerrar falhou: ${e}`));
    await page.waitForTimeout(700);
    const drawerGoneAfterX = (await drawer.count()) === 0 || !(await drawer.isVisible().catch(() => false));
    const confirmDialogAppeared = await page.getByText(/descartar/i).count();
    log('11', `X fechou sem pedir confirmação (nenhuma tela de "descartar cambios" apareceu) = ${confirmDialogAppeared === 0} | drawer fechou = ${drawerGoneAfterX}`);
    // reabre a ficha do zero (reload) pra provar que sobreviveu de verdade, não só em memória
    await page.reload();
    await page.waitForLoadState('networkidle');
    const card = page.getByTestId('diagnostico-card-patologias');
    const cardText = await textOrNothing(card);
    log('11', `depois de RECARREGAR a página (sem apertar Guardar): card de patologías mostra = "${cardText}"`);
    await shot(page, 'ux-11b-ficha-apos-reload-sem-guardar.png');

    // ── 12. Catálogo cai com o drawer aberto ─────────────────────────────────────────────
    await openDrawer(page);
    setCatalogPromoted(false);
    const statusCatalogoCaiu = await searchAndWait(page, 'esquizofrenia', 503).catch(() => 'erro-inesperado');
    const statusTextCatalogo = await textOrNothing(page.getByTestId('icd-search-status'));
    const listboxDuranteQueda = await page.getByTestId('icd-search-listbox').count();
    log('12', `httpStatus=${statusCatalogoCaiu} texto-na-tela="${statusTextCatalogo}" listbox-presente=${listboxDuranteQueda > 0}`);
    await shot(page.getByTestId('icd-search-status'), 'ux-12-catalogo-indisponivel.png');
    setCatalogPromoted(true); // devolve pro afterAll e pro passo 13

    // ── 13. Procura o código que a obra social pede ──────────────────────────────────────
    const domContent = await page.content();
    const legacyFieldValue = 'campo removido em D284'; // não existe mais nada a sondar
    const anyElementWithTitleAttr = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-testid^="diagnosis-chip-"]'));
      return els.map((el) => el.getAttribute('title')).filter(Boolean);
    });
    const hasVisibleCodeButtonOrLink = await page.getByText(/c[oó]digo|CIE-11|CID-11/i).allTextContents();
    log('13', `campo LIVRE "Hipótesis Diagnóstica - CID" (legado) contém = "${legacyFieldValue}" | atributos title= nos chips = ${JSON.stringify(anyElementWithTitleAttr)} | textos na tela mencionando "código/CIE/CID" = ${JSON.stringify(hasVisibleCodeButtonOrLink)}`);
    await shot(page.getByTestId('patient-clinical-edit-drawer'), 'ux-13-nenhum-lugar-mostra-o-codigo.png');

    // sanidade final: nenhum código CIE real deveria estar no DOM (REQ-21) — não é o foco desta
    // auditoria, mas registra a evidência já que passamos por aqui.
    log('13', `tamanho do DOM=${domContent.length} chars (REQ-21 não é o foco desta auditoria de UX)`);

    await page.getByRole('button', { name: 'Cerrar' }).click({ timeout: 5_000 }).catch(() => {});
  });

  // RODADA 2 — Parte C: o fluxo inteiro, sem parar, como ela faria com pressa antes do almoço.
  // Conta MOMENTOS DE AMBIGUIDADE — pontos onde a tela não diz o que fazer e ela pararia pra
  // perguntar pra alguém. Critério: se um passo precisa de tentativa-e-erro (não deu pra saber
  // olhando a tela sozinha) ou de um clique que teve efeito diferente do esperado, conta 1.
  test('Parte C — fluxo completo sem parar, cadastrando 2 diagnósticos num paciente do zero', async ({ page }) => {
    let duvidas = 0;
    const marcarDuvida = (motivo: string) => { duvidas += 1; log('C', `DÚVIDA #${duvidas}: ${motivo}`); };

    await loginAsAdmin(page);
    await openDetail(page, patientC.patientId);
    const drawerC = await openDrawer(page);
    await page.waitForTimeout(400);
    await shot(drawerC, 'ux-c00-estado-inicial.png');

    // 1) busca e escolhe o 1º diagnóstico
    await searchAndWait(page, 'esquizofrenia');
    const opt0 = page.getByTestId('icd-search-option-0');
    if (await opt0.count() === 0) marcarDuvida('buscou "esquizofrenia" e não achou nada — precisaria perguntar se o termo está certo');
    else { await opt0.click(); await page.waitForTimeout(800); }
    await shot(page.getByTestId('diagnosis-chips'), 'ux-c01-primeiro-diagnostico.png');

    // 2) busca e escolhe o 2º diagnóstico
    await searchAndWait(page, 'depresion');
    const opt0b = page.getByTestId('icd-search-option-0');
    if (await opt0b.count() === 0) marcarDuvida('buscou "depresion" e não achou nada');
    else { await opt0b.click(); await page.waitForTimeout(800); }
    const chipLisC = page.locator('li[data-testid^="diagnosis-chip-"]');
    const countAfter2 = await chipLisC.count();
    if (countAfter2 !== 2) marcarDuvida(`esperava 2 chips depois de escolher 2 diagnósticos, tem ${countAfter2} — ela não teria como confirmar visualmente que os dois "pegaram"`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-c02-dois-diagnosticos.png');

    // 3) marca o 1º como principal — RODADA 3 / V2: o corpo do chip deixou de ser clicável
    // (era o próprio bug do mis-clique). Ela usa o botão COM TEXTO VISÍVEL ("Marcar como
    // principal"), que já resolvia a descoberta (medido na 2ª auditoria, item 8: ENTENDE).
    const anyPrimaryBadgeBefore = await page.locator('[data-testid^="diagnosis-chip-primary-badge-"]').count();
    if (anyPrimaryBadgeBefore === 0) marcarDuvida('nenhum diagnóstico nasce marcado como principal e a tela não diz que ISSO é obrigatório nem qual ação faz — ela só sabe se já leu o texto do botão-estrela');
    const targetChip = chipLisC.first();
    // prova V2: clicar no corpo NÃO promove mais (era o defeito da rodada 2)
    await targetChip.click({ position: { x: 10, y: 10 } }).catch(() => {});
    await page.waitForTimeout(300);
    const primaryBadgeAfterBodyClickC = await page.locator('[data-testid^="diagnosis-chip-primary-badge-"]').count();
    log('R3-C', `V2: clique no corpo do 1º chip promoveu? badge presente = ${primaryBadgeAfterBodyClickC > 0} (esperado FALSE)`);
    const promoteBtnC = targetChip.locator('[data-testid^="diagnosis-chip-promote-"]').first();
    if (await promoteBtnC.count() > 0) { await promoteBtnC.click(); await page.waitForTimeout(500); }
    const primaryBadgeCountC = await page.locator('[data-testid^="diagnosis-chip-primary-badge-"]').count();
    log('C', `depois de clicar no BOTÃO de promover do 1º chip: badge "Principal" presente = ${primaryBadgeCountC > 0}`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-c03-apos-marcar-principal.png');

    // 4) remove o 2º diagnóstico (2 cliques: X, depois confirmar)
    const nonPrimaryC = chipLisC.filter({ hasNot: page.locator('[data-testid^="diagnosis-chip-primary-badge-"]') }).first();
    const removeBtnC = nonPrimaryC.locator('[data-testid^="diagnosis-chip-remove-"]').first();
    if (await removeBtnC.count() === 0) marcarDuvida('não achou o botão de remover do diagnóstico não-principal');
    else {
      await removeBtnC.click();
      await page.waitForTimeout(300);
      const confirmVisibleC = await nonPrimaryC.locator('[data-testid^="diagnosis-chip-remove-confirm-"]').first().isVisible().catch(() => false);
      if (!confirmVisibleC) marcarDuvida('clicou no X e não apareceu confirmação — ela não saberia se removeu ou não');
      await shot(page.getByTestId('diagnosis-chips'), 'ux-c04-confirmando-remocao.png');
      const confirmBtnC = nonPrimaryC.locator('[data-testid^="diagnosis-chip-remove-confirm-btn-"]').first();
      if (await confirmBtnC.isVisible().catch(() => false)) { await confirmBtnC.click(); await page.waitForTimeout(600); }
    }
    const countAfterRemoveC = await chipLisC.count();
    if (countAfterRemoveC !== 1) marcarDuvida(`esperava sobrar 1 diagnóstico depois de remover 1 dos 2, sobrou ${countAfterRemoveC}`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-c05-apos-remover-um.png');

    // 5) fecha o drawer (sem procurar botão "Guardar" — ação já é "salvo na hora", D-263)
    await page.getByRole('button', { name: 'Cerrar' }).click({ timeout: 5_000 }).catch(() => marcarDuvida('não achou o botão "Cerrar" em 5s'));
    await page.waitForTimeout(500);
    await shot(page, 'ux-c06-fechado.png');

    // prova final: sobreviveu de verdade (reload), igual ao passo 11 da Parte A
    await page.reload();
    await page.waitForLoadState('networkidle');
    const finalCardText = await textOrNothing(page.getByTestId('diagnostico-card-patologias'));
    log('C', `depois de reload: card de patologías mostra = "${finalCardText}"`);
    await shot(page, 'ux-c07-apos-reload.png');

    log('C', `RESUMO PARTE C: ${duvidas} momento(s) em que ela precisaria perguntar pra alguém`);
  });

  // RODADA 4 — Parte D: igual à Parte C, mas com um diagnóstico FORA do escopo padrão (diabetes,
  // só aparece em "Todas las categorías"). item 10 do roteiro da rodada 4 — compara contra o
  // resultado da rodada 2 (Parte C, escopo único, deu 1 dúvida).
  test('RODADA 4 — Parte D: fluxo completo com 1 diagnóstico fora do escopo padrão', async ({ page }) => {
    let duvidas = 0;
    const marcarDuvida = (motivo: string) => { duvidas += 1; log('D', `DÚVIDA #${duvidas}: ${motivo}`); };

    await loginAsAdmin(page);
    await openDetail(page, patientD.patientId);
    const drawerD = await openDrawer(page);
    await page.waitForTimeout(400);
    await shot4(drawerD, 'ux4-d00-estado-inicial.png');

    // 1) busca e escolhe o 1º diagnóstico — DENTRO do escopo padrão (habitual)
    await searchAndWait(page, 'esquizofrenia');
    const optD0 = page.getByTestId('icd-search-option-0');
    if (await optD0.count() === 0) marcarDuvida('buscou "esquizofrenia" (dentro do escopo padrão) e não achou nada');
    else { await optD0.click(); await page.waitForTimeout(800); }
    await shot4(page.getByTestId('diagnosis-chips'), 'ux4-d01-primeiro-diagnostico.png');

    // 2) busca "diabetes" no escopo PADRÃO (habitual) — é o cenário do item 3/10. Descoberta ao
    // rodar de verdade: o catálogo real TEM uma entrada chapter=08 que também contém "diabetes"
    // no título ("Neuropatía autonómica por diabetes mellitus") — então o escopo padrão não fica
    // vazio; ele devolve 1 resultado plausível, mas DIFERENTE do que ela provavelmente queria
    // ("Diabetes mellitus tipo 1", chapter=05, só em "Todas las categorías"). Captura o título
    // literal pra provar qual das duas hipóteses é real.
    await searchAndWait(page, 'diabetes');
    const optDiabetesDefaultScope = page.getByTestId('icd-search-option-0');
    const foundDiabetesInDefaultScope = (await optDiabetesDefaultScope.count()) > 0;
    const diabetesDefaultScopeTitle = foundDiabetesInDefaultScope ? await textOrNothing(optDiabetesDefaultScope) : null;
    if (foundDiabetesInDefaultScope) {
      marcarDuvida(`ACHADO NOVO (não estava no roteiro): "diabetes" no escopo padrão NÃO fica vazio — devolve 1 resultado plausível porém ENGANOSO: "${diabetesDefaultScopeTitle}" (uma complicação neurológica do diabetes, chapter=08) em vez do diagnóstico genérico "Diabetes mellitus tipo 1" (chapter=05, só existe em "Todas las categorías"). Se ela clicar direto no option-0 (hábito repetido nos passos anteriores), atribui um diagnóstico ERRADO sem perceber e sem nenhum aviso — não precisaria "perguntar pra alguém", erraria em silêncio`);
    } else {
      marcarDuvida('buscou "diabetes" no escopo padrão, não achou nada, e a tela não aponta o toggle "Todas las categorías" como causa/saída — ela teria que descobrir sozinha que precisa trocar de escopo');
    }
    log('D', `item3/10: título literal do option-0 em "diabetes" com escopo padrão = "${diabetesDefaultScopeTitle}"`);
    await shot4(drawerD, 'ux4-d02-diabetes-resultado-enganoso-no-escopo-padrao.png');

    // 3) troca para "Todas las categorías" e busca de novo
    await page.getByTestId('icd-search-scope-all').click();
    await searchAndWait(page, 'diabetes');
    const optDiabetesAllScope = page.getByTestId('icd-search-option-0');
    const diabetesTitleAllScope = (await optDiabetesAllScope.count()) > 0 ? await textOrNothing(optDiabetesAllScope) : null;
    if (!diabetesTitleAllScope) marcarDuvida('trocou para "todas as categorías" e AINDA ASSIM não achou "diabetes" — bloqueio real');
    else { await optDiabetesAllScope.click(); await page.waitForTimeout(800); }
    const chipLisD = page.locator('li[data-testid^="diagnosis-chip-"]');
    const countAfter2D = await chipLisD.count();
    if (countAfter2D !== 2) marcarDuvida(`esperava 2 chips (1 dentro + 1 fora do escopo padrão), tem ${countAfter2D}`);
    log('D', `2º diagnóstico (fora do escopo padrão) escolhido = "${diabetesTitleAllScope}" | total de chips = ${countAfter2D}`);
    await shot4(page.getByTestId('diagnosis-chips'), 'ux4-d03-dois-diagnosticos-um-fora-do-escopo.png');
    // volta ao padrão — não é o foco deste passo, mas evita deixar o resto do fluxo com o escopo trocado
    await page.getByTestId('icd-search-scope-usual').click();

    // 4) marca o 1º (esquizofrenia, dentro do escopo) como principal — só pelo BOTÃO com texto
    const targetChipD = chipLisD.first();
    const promoteBtnD = targetChipD.locator('[data-testid^="diagnosis-chip-promote-"]').first();
    if (await promoteBtnD.count() === 0) marcarDuvida('não achou o botão de promover no 1º chip');
    else { await promoteBtnD.click(); await page.waitForTimeout(500); }
    const primaryBadgeCountD = await page.locator('[data-testid^="diagnosis-chip-primary-badge-"]').count();
    if (primaryBadgeCountD === 0) marcarDuvida('clicou em "Marcar como principal" e nenhum badge "Principal" apareceu');
    await shot4(page.getByTestId('diagnosis-chips'), 'ux4-d04-apos-marcar-principal.png');

    // 5) remove o diagnóstico NÃO-principal (diabetes, o que veio de fora do escopo)
    const nonPrimaryD = chipLisD.filter({ hasNot: page.locator('[data-testid^="diagnosis-chip-primary-badge-"]') }).first();
    const removeBtnD = nonPrimaryD.locator('[data-testid^="diagnosis-chip-remove-"]').first();
    if (await removeBtnD.count() === 0) marcarDuvida('não achou o botão de remover do diagnóstico não-principal (diabetes)');
    else {
      await removeBtnD.click();
      await page.waitForTimeout(300);
      const confirmVisibleD = await nonPrimaryD.locator('[data-testid^="diagnosis-chip-remove-confirm-"]').first().isVisible().catch(() => false);
      if (!confirmVisibleD) marcarDuvida('clicou no X e não apareceu confirmação');
      await shot4(page.getByTestId('diagnosis-chips'), 'ux4-d05-confirmando-remocao.png');
      const confirmBtnD = nonPrimaryD.locator('[data-testid^="diagnosis-chip-remove-confirm-btn-"]').first();
      if (await confirmBtnD.isVisible().catch(() => false)) { await confirmBtnD.click(); await page.waitForTimeout(600); }
    }
    const countAfterRemoveD = await chipLisD.count();
    if (countAfterRemoveD !== 1) marcarDuvida(`esperava sobrar 1 diagnóstico, sobrou ${countAfterRemoveD}`);
    await shot4(page.getByTestId('diagnosis-chips'), 'ux4-d06-apos-remover-um.png');

    // 6) fecha o drawer
    await page.getByRole('button', { name: 'Cerrar' }).click({ timeout: 5_000 }).catch(() => marcarDuvida('não achou o botão "Cerrar" em 5s'));
    await page.waitForTimeout(500);
    await shot4(page, 'ux4-d07-fechado.png');

    // prova final: sobreviveu de verdade (reload)
    await page.reload();
    await page.waitForLoadState('networkidle');
    const finalCardTextD = await textOrNothing(page.getByTestId('diagnostico-card-patologias'));
    log('D', `depois de reload: card de patologías mostra = "${finalCardTextD}"`);
    await shot4(page, 'ux4-d08-apos-reload.png');

    log('D', `RESUMO PARTE D (item 10): ${duvidas} momento(s) em que ela precisaria perguntar pra alguém — rodada 2 (Parte C, escopo único) deu 1`);
  });
});
