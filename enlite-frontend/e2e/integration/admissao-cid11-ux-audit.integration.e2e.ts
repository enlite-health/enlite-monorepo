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

const SHOT_DIR = path.join(__dirname, '../../../specs/016-admissao-cid11/evidencias/ux');
fs.mkdirSync(SHOT_DIR, { recursive: true });

function log(tag: string, msg: string): void {
  // eslint-disable-next-line no-console
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
  const file = path.join(SHOT_DIR, name);
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
  test.setTimeout(240_000);

  let patient: { patientId: string; stamp: string };
  const wasPromotedBefore = isCatalogPromoted();

  test.beforeAll(() => {
    patient = seedPatientForDiagnosis();
    setCatalogPromoted(true);
    log('ENV', `is_current antes de mexer = ${wasPromotedBefore}`);
  });

  test.afterAll(() => {
    cleanupPatientDeep(patient.patientId);
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
    const sectionLabel = await page.locator('label[for="icd-search-input"]').textContent().catch(() => null);
    const placeholder = await page.getByTestId('icd-search-input').getAttribute('placeholder');
    const legacyLabel = await page.locator('label[for="pce-diagnosis"]').textContent().catch(() => null);
    log('01', `label da seção estruturada = "${sectionLabel}" | placeholder do input = "${placeholder}" | label do campo LIVRE acima = "${legacyLabel}"`);
    const attribution = await textOrNothing(page.getByTestId('who-attribution'));
    log('01', `texto de atribuição visível = "${attribution}"`);

    // ── 2. Digita 1 letra e espera (piso é 2) ────────────────────────────────────────────
    const input = page.getByTestId('icd-search-input');
    await input.fill('e');
    await page.waitForTimeout(500);
    const statusAfter1Char = await textOrNothing(page.getByTestId('icd-search-status'));
    const listboxAfter1Char = await page.getByTestId('icd-search-listbox').count();
    log('02', `depois de 1 caractere: status="${statusAfter1Char}" (null=nada visível) | listbox presente=${listboxAfter1Char > 0}`);
    await shot(drawer, 'ux-02-um-caractere.png');

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

    // ── 5. Fora dos capítulos 06/08 — filtro esconde ─────────────────────────────────────
    await searchAndWait(page, 'diabetes');
    const statusRestrito = await textOrNothing(page.getByTestId('icd-search-status'));
    const toggleTextRestrito = await textOrNothing(page.getByTestId('icd-search-toggle-chapters'));
    log('05', `"diabetes" com filtro padrão: status-tela="${statusRestrito}" | texto do botão de alargar="${toggleTextRestrito}"`);
    await shot(drawer, 'ux-05a-diabetes-filtrado.png');
    // U1 — o filtro esconde "Diabetes mellitus tipo 1" (capítulo 05, fora de 06/08); a tela
    // deveria avisar a contagem ANTES da lista, sem trocar o filtro padrão sozinha.
    const outsideNoticeDiabetes = await textOrNothing(page.getByTestId('icd-search-outside-notice'));
    log('05', `U1: aviso de resultados fora do filtro (esperado, com contagem) = "${outsideNoticeDiabetes}"`);
    await shot(drawer, 'ux-05a2-diabetes-aviso-fora-filtro.png');
    await page.getByTestId('icd-search-toggle-chapters').click();
    await searchAndWait(page, 'diabetes');
    const statusAmplo = await textOrNothing(page.getByTestId('icd-search-status'));
    const listboxAmploCount = await page.getByTestId('icd-search-listbox').count();
    let primeiraOpcaoAmpla: string | null = null;
    if (listboxAmploCount > 0) primeiraOpcaoAmpla = await textOrNothing(page.getByTestId('icd-search-option-0'));
    log('05', `"diabetes" com TODAS as categorias: status-tela="${statusAmplo}" listbox=${listboxAmploCount > 0} primeiraOpcao="${primeiraOpcaoAmpla}"`);
    await shot(drawer, 'ux-05b-diabetes-todas-categorias.png');
    // volta ao padrão (categorias habituais) pro resto do percurso
    const toggleTextAmplo = await textOrNothing(page.getByTestId('icd-search-toggle-chapters'));
    log('05', `texto do botão depois de alargar (pra voltar) = "${toggleTextAmplo}"`);
    await page.getByTestId('icd-search-toggle-chapters').click();

    // ── 6. Clica no resultado 2x rápido (duplo clique) ───────────────────────────────────
    let postCount = 0;
    const onReq = (req: import('@playwright/test').Request) => {
      if (req.method() === 'POST' && /\/diagnoses$/.test(req.url())) postCount++;
    };
    page.on('request', onReq);
    await searchAndWait(page, 'esquizofrenia');
    const option0Exists = await page.getByTestId('icd-search-option-0').count();
    log('06', `busca "esquizofrenia" (sem typo) achou opção 0? ${option0Exists > 0}`);
    // U1 (contraprova) — "esquizofrenia" já está no capítulo 06: o filtro não esconde nada, o
    // aviso de "resultados fora do filtro" NÃO deveria aparecer aqui.
    const outsideNoticeEsquizofrenia = await textOrNothing(page.getByTestId('icd-search-outside-notice'));
    log('06', `U1 (contraprova): aviso fora do filtro em "esquizofrenia" (esperado AUSENTE) = "${outsideNoticeEsquizofrenia}"`);
    if (option0Exists > 0) {
      await page.getByTestId('icd-search-option-0').dblclick({ timeout: 5_000 }).catch((e) => log('06', `dblclick lançou: ${e}`));
      await page.waitForTimeout(1500);
    }
    page.off('request', onReq);
    const chipsAfterDbl = await textOrNothing(page.getByTestId('diagnosis-chips'));
    const chipCountAfterDbl = await page.locator('[data-testid^="diagnosis-chip-"]').count();
    log('06', `POSTs /diagnoses disparados pelo duplo clique = ${postCount} | conteúdo dos chips = "${chipsAfterDbl}" | nº de elementos chip-* no DOM = ${chipCountAfterDbl}`);
    await shot(drawer, 'ux-06-apos-duplo-clique.png');

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
    // clica no CORPO do chip (não na estrela) — antes ela não sabia que só o ícone reagia
    await firstChip.click({ position: { x: 10, y: 10 } }).catch(() => {});
    await page.waitForTimeout(300);
    const primaryBadgeAfterBodyClick = await page.locator('[data-testid^="diagnosis-chip-primary-badge-"]').count();
    log('08', `clique no CORPO do chip promoveu a principal? badge presente = ${primaryBadgeAfterBodyClick > 0}`);
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

    // ── 9. Quer remover — agora exige confirmação (U3) ───────────────────────────────────
    const removeBtn = page.locator('[data-testid^="diagnosis-chip-remove-"]').first();
    const removeVisible = await removeBtn.isVisible().catch(() => false);
    const removeAriaLabel = await attrOrNothing(removeBtn, 'aria-label');
    log('09', `botão remover: visível SEM hover/instrução = ${removeVisible} aria-label="${removeAriaLabel}"`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-09a-chip-antes-de-remover.png');
    const chipCountBeforeRemove = await page.locator('[data-testid^="diagnosis-chip-"]').count();
    if (removeVisible) {
      await removeBtn.click();
      await page.waitForTimeout(300);
    }
    // U3 — o 1º clique no X NÃO deveria remover mais: só pede confirmação inline.
    const confirmQuestionText = await textOrNothing(
      page.locator('[data-testid^="diagnosis-chip-remove-confirm-"]').first(),
    );
    const chipCountAfterFirstClick = await page.locator('[data-testid^="diagnosis-chip-"]').count();
    log('09', `U3: 1º clique pede confirmação = "${confirmQuestionText}" | nº de chips ainda o mesmo (nada removido) = ${chipCountAfterFirstClick === chipCountBeforeRemove}`);
    await shot(page.getByTestId('diagnosis-chips'), 'ux-09b-confirmacao-antes-de-remover.png');
    const confirmRemoveBtn = page.locator('[data-testid^="diagnosis-chip-remove-confirm-btn-"]').first();
    const confirmRemoveBtnVisible = await confirmRemoveBtn.isVisible().catch(() => false);
    if (confirmRemoveBtnVisible) {
      await confirmRemoveBtn.click();
      await page.waitForTimeout(600);
    }
    const chipsEmptyAfterRemove = await page.getByTestId('diagnosis-chips-empty').count();
    const anyUndoButton = await page.getByRole('button', { name: /deshacer|undo/i }).count();
    log('09', `depois de CONFIRMAR: removeu de fato | ficou vazio="${chipsEmptyAfterRemove > 0}" | existe botão de desfazer="${anyUndoButton > 0}"`);
    await shot(drawer, 'ux-09c-apos-confirmar-remocao.png');

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
    const legacyFieldValue = await page.getByTestId('pce-diagnosis').inputValue().catch(() => null);
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
});
